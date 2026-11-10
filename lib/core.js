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
