import crypto from 'node:crypto';
import { pool, q } from './db.js';

export class UserError extends Error {}
const fail = m => { throw new UserError(m); };

export const token = (n = 24) => crypto.randomBytes(n).toString('base64url');
export const toPaise = r => Math.round(Number(r) * 100);
export const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // India date

export function checkDate(d, label = 'Date') {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d)) ||
      new Date(d).toISOString().slice(0, 10) !== d) fail(`${label} must be a real date written YYYY-MM-DD, got "${d}".`);
  return d;
}

function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) fail('An order needs at least one item (name, quantity, price each).');
  return items.map((it, i) => {
    const name = String(it.name ?? '').trim();
    const qty = Number(it.qty), price = Number(it.unit_price);
    if (!name) fail(`Item ${i + 1} has no name.`);
    if (!(qty > 0)) fail(`Item "${name}" needs a quantity above zero.`);
    if (!(price >= 0)) fail(`Item "${name}" needs a price each (0 or more).`);
    return { name, qty, unit_paise: toPaise(price) };
  });
}

const SUMS = `
  SELECT o.id, o.number, o.customer, o.contact, o.due_date, o.notes, o.public_token, o.state,
    COALESCE(i.total,0) AS total, COALESCE(p.confirmed,0) AS paid, COALESCE(p.reported,0) AS reported
  FROM orders o
  LEFT JOIN (SELECT order_id, SUM(ROUND(qty*unit_paise))::bigint total FROM order_items GROUP BY 1) i ON i.order_id=o.id
  LEFT JOIN (SELECT order_id,
      COALESCE(SUM(amount_paise) FILTER (WHERE state='confirmed'),0)::bigint confirmed,
      COALESCE(SUM(amount_paise) FILTER (WHERE state='reported'),0)::bigint reported
    FROM payments GROUP BY 1) p ON p.order_id=o.id`;

function shape(r) {
  const balance = Math.max(r.total - r.paid, 0);
  const pay = r.total > 0 && balance === 0 ? 'paid' : r.paid > 0 ? 'part-paid' : 'unpaid';
  return { ...r, balance, pay };
}

async function attach(rows, withPayments = false) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const items = (await q('SELECT order_id,name,qty,unit_paise FROM order_items WHERE order_id=ANY($1) ORDER BY id', [ids])).rows;
  const pays = withPayments ? (await q('SELECT id,order_id,amount_paise,paid_on,upi_ref,state FROM payments WHERE order_id=ANY($1) ORDER BY paid_on,id', [ids])).rows : [];
  return rows.map(r => ({ ...shape(r),
    items: items.filter(i => i.order_id === r.id),
    payments: pays.filter(p => p.order_id === r.id) }));
}

export async function listOrders(bid, f = {}) {
  const where = ['o.business_id=$1']; const p = [bid];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', '$' + p.length)); };
  if (f.state) add('o.state=?', f.state);
  if (f.due_from) add('o.due_date>=?', checkDate(f.due_from, 'due_from'));
  if (f.due_to) add('o.due_date<=?', checkDate(f.due_to, 'due_to'));
  if (f.customer) add('o.customer ILIKE ?', `%${f.customer}%`);
  let rows = (await q(`${SUMS} WHERE ${where.join(' AND ')} ORDER BY o.due_date, o.number LIMIT 500`, p)).rows;
  let out = await attach(rows, true);
  if (f.payment) out = out.filter(o => o.pay === f.payment || (f.payment === 'unpaid' && o.pay === 'part-paid'));
  return out;
}

export async function getOrder(bid, number) {
  const r = (await q(`${SUMS} WHERE o.business_id=$1 AND o.number=$2`, [bid, number])).rows;
  if (!r.length) fail(`There is no order #${number}.`);
  return (await attach(r, true))[0];
}

export async function getByPublicToken(tok) {
  const r = (await q(`${SUMS} WHERE o.public_token=$1`, [tok])).rows;
  if (!r.length) return null;
  const o = (await attach(r, true))[0];
  const b = (await q('SELECT id,name,upi_id,logo,qr FROM businesses WHERE id=(SELECT business_id FROM orders WHERE public_token=$1)', [tok])).rows[0];
  return { order: o, business: b };
}

async function findDuplicate(c, bid, customer, due, totalPaise) {
  const r = await c.query(`SELECT o.number FROM orders o WHERE o.business_id=$1 AND lower(o.customer)=lower($2) AND o.due_date=$3 AND o.state<>'cancelled'
    AND COALESCE((SELECT SUM(ROUND(qty*unit_paise)) FROM order_items WHERE order_id=o.id),0)=$4 LIMIT 1`, [bid, customer, due, totalPaise]);
  return r.rows[0]?.number;
}

async function insertPayment(c, bid, orderId, p, state) {
  const amount = toPaise(p.amount);
  if (!(amount > 0)) fail('A payment amount must be above zero.');
  const paid_on = checkDate(p.paid_on || today(), 'Payment date');
  const ref = p.upi_ref ? String(p.upi_ref).trim().toUpperCase() : null;
  try {
    await c.query('INSERT INTO payments (business_id,order_id,amount_paise,paid_on,upi_ref,state) VALUES ($1,$2,$3,$4,$5,$6)', [bid, orderId, amount, paid_on, ref, state]);
  } catch (e) {
    if (e.code === '23505') fail(`UPI reference ${ref} is already recorded on another payment. The same transfer cannot be counted twice.`);
    throw e;
  }
}

// creates one order. returns { created, number } or { duplicateOf }
export async function addOrder(bid, o, { allowDuplicate = false } = {}) {
  const customer = String(o.customer ?? '').trim();
  if (!customer) fail('Who is the order for? A customer name is needed.');
  const due = checkDate(o.due_date, 'Due date');
  const items = cleanItems(o.items);
  const total = items.reduce((s, i) => s + Math.round(i.qty * i.unit_paise), 0);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [bid]);
    if (!allowDuplicate) {
      const dup = await findDuplicate(c, bid, customer, due, total);
      if (dup) { await c.query('ROLLBACK'); return { duplicateOf: dup }; }
    }
    const number = (await c.query('SELECT COALESCE(MAX(number),0)+1 n FROM orders WHERE business_id=$1', [bid])).rows[0].n;
    const id = (await c.query('INSERT INTO orders (business_id,number,customer,contact,due_date,notes,public_token) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [bid, number, customer, String(o.contact ?? '').trim(), due, String(o.notes ?? '').trim(), token(16)])).rows[0].id;
    for (const it of items) await c.query('INSERT INTO order_items (order_id,name,qty,unit_paise) VALUES ($1,$2,$3,$4)', [id, it.name, it.qty, it.unit_paise]);
    const warnings = [];
    for (const p of o.payments || []) {
      await c.query('SAVEPOINT pay');
      try { await insertPayment(c, bid, id, p, 'confirmed'); await c.query('RELEASE SAVEPOINT pay'); }
      catch (e) { await c.query('ROLLBACK TO SAVEPOINT pay'); if (e instanceof UserError) warnings.push(e.message); else throw e; }
    }
    await c.query('COMMIT');
    return { created: true, number, warnings };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

export async function updateOrder(bid, number, f) {
  const o = await getOrder(bid, number);
  const sets = []; const p = [o.id];
  const set = (col, v) => { p.push(v); sets.push(`${col}=$${p.length}`); };
  if (f.customer !== undefined) { const v = String(f.customer).trim(); if (!v) fail('Customer name cannot be empty.'); set('customer', v); }
  if (f.contact !== undefined) set('contact', String(f.contact).trim());
  if (f.notes !== undefined) set('notes', String(f.notes).trim());
  if (f.due_date !== undefined) set('due_date', checkDate(f.due_date, 'Due date'));
  if (f.state !== undefined) {
    if (!['open', 'delivered', 'cancelled'].includes(f.state)) fail('State must be open, delivered or cancelled.');
    set('state', f.state);
  }
  const items = f.items !== undefined ? cleanItems(f.items) : null;
  if (!sets.length && !items) fail('Nothing to change. Say which field to update.');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (sets.length) await c.query(`UPDATE orders SET ${sets.join(',')} WHERE id=$1`, p);
    if (items) {
      await c.query('DELETE FROM order_items WHERE order_id=$1', [o.id]);
      for (const it of items) await c.query('INSERT INTO order_items (order_id,name,qty,unit_paise) VALUES ($1,$2,$3,$4)', [o.id, it.name, it.qty, it.unit_paise]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
  return getOrder(bid, number);
}

export async function recordPayment(bid, number, p, state = 'confirmed') {
  const o = await getOrder(bid, number);
  const c = await pool.connect();
  try { await insertPayment(c, bid, o.id, p, state); } finally { c.release(); }
  return getOrder(bid, number);
}

export async function setPaymentState(bid, paymentId, action) {
  const r = action === 'delete'
    ? await q('DELETE FROM payments WHERE id=$1 AND business_id=$2 RETURNING order_id', [paymentId, bid])
    : await q("UPDATE payments SET state='confirmed' WHERE id=$1 AND business_id=$2 RETURNING order_id", [paymentId, bid]);
  if (!r.rowCount) fail('That payment was not found.');
}

export async function importOrders(bid, orders) {
  if (!Array.isArray(orders) || !orders.length) fail('No orders to import.');
  if (orders.length > 200) fail('Import at most 200 orders per call. Send the rest in another call.');
  const result = { created: [], skipped_duplicates: [], errors: [] };
  for (let i = 0; i < orders.length; i++) {
    try {
      const r = await addOrder(bid, orders[i]);
      if (r.duplicateOf) result.skipped_duplicates.push({ row: i + 1, customer: orders[i].customer, same_as_order: r.duplicateOf });
      else result.created.push({ row: i + 1, order: r.number, ...(r.warnings.length ? { warnings: r.warnings } : {}) });
    } catch (e) {
      if (e instanceof UserError) result.errors.push({ row: i + 1, customer: orders[i]?.customer, problem: e.message });
      else throw e;
    }
  }
  return result;
}

export async function paymentsToConfirm(bid) {
  return (await q(`SELECT p.id, p.amount_paise, p.paid_on, p.upi_ref, o.number, o.customer FROM payments p JOIN orders o ON o.id=p.order_id
    WHERE p.business_id=$1 AND p.state='reported' ORDER BY p.created_at`, [bid])).rows;
}

// ---- costing and margins. Only inputs are stored; every cost and margin below is computed on request.
const UNITS = ['g', 'ml', 'piece'];
const key = s => String(s ?? '').trim().toLowerCase();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

export function checkMonth(m) {
  if (typeof m !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) fail(`Month must be written YYYY-MM, like 2026-11, got "${m}".`);
  return m;
}
const monthBounds = m => { const [y, mo] = m.split('-').map(Number); return [`${m}-01`, new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10)]; };

// creates or updates the recipe, its ingredients and its lines in one transaction
export async function saveRecipe(bid, r) {
  const name = String(r.name ?? '').trim();
  if (!name) fail('The recipe needs a name: use the item name exactly as it appears on orders, e.g. "Brownie box of 6".');
  const yieldQty = Number(r.yield_qty);
  if (!(yieldQty > 0)) fail(`How many "${name}" does one batch make? yield_qty must be above zero.`);
  const packaging = has(r, 'packaging_cost') ? Number(r.packaging_cost) : null;
  if (packaging !== null && !(packaging >= 0)) fail(`Packaging cost for "${name}" must be 0 or more rupees per item.`);
  if (!Array.isArray(r.lines) || !r.lines.length) fail(`"${name}" needs at least one ingredient line (ingredient and quantity).`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [bid]);
    const lines = new Map();
    for (const [n, l] of r.lines.entries()) {
      const iname = String(l.ingredient ?? '').trim();
      if (!iname) fail(`Line ${n + 1} has no ingredient name. Nothing was saved.`);
      if (lines.has(key(iname))) fail(`"${iname}" is listed twice. Put the total in one line. Nothing was saved.`);
      const qty = Number(l.qty);
      if (!(qty > 0)) fail(`"${iname}" needs a quantity above zero, in its own unit. Nothing was saved.`);
      const unit = has(l, 'unit') ? String(l.unit).trim().toLowerCase() : null;
      if (unit !== null && !UNITS.includes(unit)) fail(`"${iname}" must be measured in g, ml or piece, not "${l.unit}". Ask the seller how many grams or ml their cup or spoon holds, then convert. Nothing was saved.`);
      const size = has(l, 'pack_size') ? Number(l.pack_size) : null;
      if (size !== null && !(size > 0)) fail(`Pack size for "${iname}" must be above zero. Nothing was saved.`);
      const price = has(l, 'pack_price') ? toPaise(l.pack_price) : null;
      if (price !== null && !(price >= 0)) fail(`Pack price for "${iname}" must be 0 or more rupees. Nothing was saved.`);
      const shelf = has(l, 'use_within_days_after_opening') ? l.use_within_days_after_opening : undefined;
      if (shelf != null && !(Number.isInteger(shelf) && shelf > 0)) fail(`"${iname}": days to use after opening must be a whole number above zero, or left out if it keeps. Nothing was saved.`);
      let ing = (await c.query('SELECT id,name,unit FROM ingredients WHERE business_id=$1 AND lower(name)=lower($2)', [bid, iname])).rows[0];
      if (!ing) {
        const missing = [unit === null && 'unit (g, ml or piece)', size === null && 'pack size', price === null && 'pack price'].filter(Boolean);
        if (missing.length) fail(`"${iname}" is a new ingredient. Ask the seller for its ${missing.join(', ')}. Nothing was saved.`);
        ing = (await c.query('INSERT INTO ingredients (business_id,name,unit,pack_size,pack_price_paise,use_within_days_after_opening) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,unit',
          [bid, iname, unit, size, price, shelf ?? null])).rows[0];
      } else {
        if (unit !== null && unit !== ing.unit) fail(`"${ing.name}" is measured in ${ing.unit}, but this line says ${unit}. Give the quantity in ${ing.unit} (ask the seller to convert if needed). Nothing was saved.`);
        await c.query(`UPDATE ingredients SET pack_size=COALESCE($3,pack_size), pack_price_paise=COALESCE($4,pack_price_paise),
          use_within_days_after_opening=CASE WHEN $5 THEN $6 ELSE use_within_days_after_opening END WHERE id=$1 AND business_id=$2`,
        [ing.id, bid, size, price, shelf !== undefined, shelf ?? null]);
      }
      lines.set(key(iname), { id: ing.id, qty });
    }
    let rec = (await c.query('SELECT id FROM recipes WHERE business_id=$1 AND lower(name)=lower($2)', [bid, name])).rows[0];
    if (rec) await c.query(`UPDATE recipes SET name=$3, yield_qty=$4, packaging_paise=COALESCE($5,packaging_paise), notes=COALESCE($6,notes) WHERE id=$1 AND business_id=$2`,
      [rec.id, bid, name, yieldQty, packaging === null ? null : toPaise(packaging), has(r, 'notes') ? String(r.notes).trim() : null]);
    else rec = (await c.query('INSERT INTO recipes (business_id,name,yield_qty,packaging_paise,notes) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [bid, name, yieldQty, toPaise(packaging || 0), String(r.notes ?? '').trim()])).rows[0];
    await c.query('DELETE FROM recipe_lines WHERE recipe_id=$1 AND business_id=$2', [rec.id, bid]);
    for (const l of lines.values()) await c.query('INSERT INTO recipe_lines (business_id,recipe_id,ingredient_id,qty) VALUES ($1,$2,$3,$4)', [bid, rec.id, l.id, l.qty]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
  return (await recipeBook(bid)).get(key(name));
}

// every recipe of a business with its computed cost: line cost = qty x pack_price / pack_size,
// cost per unit = sum(line costs) / yield + packaging. All in paise, unrounded.
export async function recipeBook(bid) {
  const recs = (await q('SELECT id,name,yield_qty,packaging_paise,notes FROM recipes WHERE business_id=$1', [bid])).rows;
  const lines = (await q(`SELECT l.recipe_id, l.qty, i.id AS ingredient_id, i.name, i.unit, i.pack_size, i.pack_price_paise, i.use_within_days_after_opening
    FROM recipe_lines l JOIN ingredients i ON i.id=l.ingredient_id AND i.business_id=l.business_id WHERE l.business_id=$1 ORDER BY l.id`, [bid])).rows;
  const book = new Map();
  for (const r of recs) {
    const ls = lines.filter(l => l.recipe_id === r.id).map(l => ({ ...l, cost: l.qty * l.pack_price_paise / l.pack_size }));
    const batch = ls.reduce((s, l) => s + l.cost, 0);
    book.set(key(r.name), { ...r, lines: ls, batch_cost: batch, unit_cost: batch / r.yield_qty + r.packaging_paise });
  }
  return book;
}

export async function addExpense(bid, e) {
  const month = checkMonth(e.month);
  const category = String(e.category ?? '').trim();
  if (!category) fail('What was the expense for? Give a category, e.g. gas, electricity, rent share, delivery.');
  const amount = toPaise(e.amount);
  if (!(amount > 0)) fail(`The ${category} amount must be above zero rupees.`);
  const note = String(e.note ?? '').trim(), estimate = !!e.is_estimate;
  if (estimate && !note) fail(`This ${category} amount is an estimate, so say in the note how it was worked out (e.g. "₹1,100 cylinder lasts about 6 weeks"). Nothing was saved.`);
  await q('INSERT INTO expenses (business_id,month,category,amount_paise,note,is_estimate) VALUES ($1,$2,$3,$4,$5,$6)', [bid, month, category, amount, note, estimate]);
  const t = (await q('SELECT COALESCE(SUM(amount_paise),0)::bigint t, COUNT(*)::int n FROM expenses WHERE business_id=$1 AND month=$2', [bid, month])).rows[0];
  return { month, category, amount_paise: amount, is_estimate: estimate, note, month_total_paise: t.t, month_expense_count: t.n };
}

// Profit for orders due in a month. Overhead (that month's expenses) is shared across the month's
// non-cancelled orders by revenue. Items without a recipe have cost null: "cost unknown", never zero.
export async function profitSummary(bid, month) {
  const [from, to] = monthBounds(checkMonth(month));
  const orders = (await listOrders(bid, { due_from: from, due_to: to })).filter(o => o.state !== 'cancelled');
  const book = await recipeBook(bid);
  const expenses = (await q('SELECT category,amount_paise,note,is_estimate FROM expenses WHERE business_id=$1 AND month=$2 ORDER BY id', [bid, month])).rows;
  const overhead = expenses.reduce((s, e) => s + e.amount_paise, 0);
  const revenue = orders.reduce((s, o) => s + o.total, 0);
  const share = rev => revenue > 0 ? overhead * rev / revenue : 0;
  const items = new Map();
  for (const o of orders) for (const i of o.items) {
    const r = book.get(key(i.name)), rev = Math.round(i.qty * i.unit_paise);
    const it = items.get(key(i.name)) || { item: i.name, qty: 0, revenue: 0, cost: r ? 0 : null, unit_cost: r ? r.unit_cost : null, orders: [] };
    it.qty += i.qty; it.revenue += rev; if (r) it.cost += i.qty * r.unit_cost;
    if (!it.orders.includes(o.number)) it.orders.push(o.number);
    items.set(key(i.name), it);
  }
  const byItem = [...items.values()].map(it => ({ ...it, overhead: share(it.revenue), margin: it.cost === null ? null : it.revenue - it.cost - share(it.revenue) }))
    .sort((a, b) => b.revenue - a.revenue);
  const unknown = byItem.filter(it => it.cost === null);
  const cost = byItem.reduce((s, it) => s + (it.cost || 0), 0);
  return {
    month, orders: orders.length, revenue, cost, overhead, margin: revenue - cost - overhead,
    cost_complete: !unknown.length, unknown_cost_items: unknown.map(u => u.item), unknown_cost_revenue: unknown.reduce((s, u) => s + u.revenue, 0),
    expenses, by_item: byItem,
    collected: orders.reduce((s, o) => s + o.paid, 0), outstanding: orders.reduce((s, o) => s + o.balance, 0),
    awaiting_confirmation: orders.reduce((s, o) => s + o.reported, 0),
  };
}

// What to buy and measure for open orders due in a date range, with perishables flagged.
export async function makeList(bid, dueFrom, dueTo) {
  const from = checkDate(dueFrom, 'due_from'), to = checkDate(dueTo, 'due_to');
  if (from > to) fail(`due_from (${from}) is after due_to (${to}). Swap them.`);
  const orders = await listOrders(bid, { state: 'open', due_from: from, due_to: to });
  const book = await recipeBook(bid);
  const need = new Map(), missing = new Map();
  for (const o of orders) for (const i of o.items) {
    const r = book.get(key(i.name));
    if (!r) { const m = missing.get(key(i.name)) || { item: i.name, qty: 0, orders: [] }; m.qty += i.qty; if (!m.orders.includes(o.number)) m.orders.push(o.number); missing.set(key(i.name), m); continue; }
    const batches = i.qty / r.yield_qty;
    for (const l of r.lines) {
      const n = need.get(l.ingredient_id) || { ingredient: l.name, unit: l.unit, qty: 0, pack_size: l.pack_size, pack_price_paise: l.pack_price_paise, use_within: l.use_within_days_after_opening, first: o.due_date, last: o.due_date, items: new Set() };
      n.qty += l.qty * batches; n.items.add(r.name);
      if (o.due_date < n.first) n.first = o.due_date; if (o.due_date > n.last) n.last = o.due_date;
      need.set(l.ingredient_id, n);
    }
  }
  return { from, to, orders: orders.length, ingredients: [...need.values()].sort((a, b) => a.ingredient.localeCompare(b.ingredient)), missing: [...missing.values()] };
}
