import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as core from './core.js';
import { userForAccessToken, can, toolLabel, TOOL_NAMES, baseUrl } from './access.js';

const rupees = p => p / 100;
const view = o => ({
  order: o.number, customer: o.customer, contact: o.contact, due_date: o.due_date, state: o.state, notes: o.notes,
  items: o.items.map(i => ({ name: i.name, qty: i.qty, unit_price: rupees(i.unit_paise) })),
  total: rupees(o.total), paid: rupees(o.paid), balance_due: rupees(o.balance), payment_status: o.pay,
  ...(o.reported ? { reported_awaiting_confirmation: rupees(o.reported) } : {}),
  payments: o.payments.map(p => ({ amount: rupees(p.amount_paise), date: p.paid_on, upi_ref: p.upi_ref, state: p.state })),
  customer_page: `${o.base}/o/${o.public_token}`,
});

const Item = z.object({ name: z.string().describe('Item name, e.g. "Brownie box of 6"'), qty: z.number().describe('How many'), unit_price: z.number().describe('Price for ONE, in rupees') });
const Pay = z.object({ amount: z.number().describe('Rupees received'), paid_on: z.string().optional().describe('YYYY-MM-DD, defaults to today'), upi_ref: z.string().optional().describe('UPI reference / UTR number if known') });
const OrderIn = z.object({
  customer: z.string(), contact: z.string().optional().describe('Phone or Instagram handle'),
  due_date: z.string().describe('Delivery or pickup date, YYYY-MM-DD'),
  items: z.array(Item).min(1), notes: z.string().optional(), payments: z.array(Pay).optional().describe('Money already received for this order'),
});

const ok = data => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });
const notAllowed = (who, tool) => `${who.email} is not allowed to use "${toolLabel(tool)}" for ${who.biz_name}. The owner can allow it in Orderly under Settings → Team, then start a new chat.`;
const guard = (tool, who, fn) => async args => {
  try {
    if (!can(who, tool)) throw new core.UserError(notAllowed(who, tool));
    return ok(await fn(args));
  }
  catch (e) {
    if (e instanceof core.UserError) return { isError: true, content: [{ type: 'text', text: e.message }] };
    console.error(e); return { isError: true, content: [{ type: 'text', text: 'Something went wrong on our side. Try again in a moment.' }] };
  }
};

export function buildServer(who, base) {
  const biz = { id: who.bid, name: who.biz_name };
  const allowed = TOOL_NAMES.filter(t => can(who, t)).join(', ');
  const tools = {};
  const withBase = o => ({ ...o, base });
  const s = new McpServer({ name: `${biz.name} orders`, version: '1.0.0' }, {
    instructions: `You manage orders and payments for "${biz.name}", a small made-to-order seller. Today is ${core.today()} (India). ` +
      'Never guess missing details: if a customer, date, item or price is unclear, ask the seller first. ' +
      'Amounts are rupees. Dates are YYYY-MM-DD. Money only counts as received when recorded with record_payment; ' +
      'payments customers report on their order page wait for the seller to confirm in the app. ' +
      `You are connected as ${who.email} (${who.role === 'owner' ? 'owner' : 'team member'}), who may use: ${allowed}.`,
  });

  tools.list_orders = s.registerTool('list_orders', {
    description: 'Look up orders. Use for "what is due this week", "who has not paid", "show Priya\'s orders". All filters are optional. Returns totals, balance due and payment status for each.',
    inputSchema: {
      state: z.enum(['open', 'delivered', 'cancelled']).optional(),
      payment: z.enum(['unpaid', 'part-paid', 'paid']).optional().describe('"unpaid" also returns part-paid orders'),
      due_from: z.string().optional().describe('YYYY-MM-DD'), due_to: z.string().optional().describe('YYYY-MM-DD'),
      customer: z.string().optional().describe('Part of a customer name'),
    },
  }, guard('list_orders', who, async a => { const rows = await core.listOrders(biz.id, a); return rows.length ? rows.map(o => view(withBase(o))) : 'No orders match.'; }));

  tools.add_order = s.registerTool('add_order', {
    description: 'Create one order. Ask the seller for anything missing (customer, due date, items with prices) before calling. If a similar order (same customer, due date, total) exists it is refused unless allow_duplicate is true. Returns the order number and the link to send the customer.',
    inputSchema: { ...OrderIn.shape, allow_duplicate: z.boolean().optional() },
  }, guard('add_order', who, async ({ allow_duplicate, ...o }) => {
    const r = await core.addOrder(biz.id, o, { allowDuplicate: allow_duplicate });
    if (r.duplicateOf) throw new core.UserError(`Looks like order #${r.duplicateOf} is already this order (same customer, date and total). Nothing was added. If it really is a second order, call again with allow_duplicate true.`);
    return { ...view(withBase(await core.getOrder(biz.id, r.number))), ...(r.warnings.length ? { warnings: r.warnings } : {}) };
  }));

  tools.update_order = s.registerTool('update_order', {
    description: 'Change an order by its number: customer, contact, due date, notes, state (open / delivered / cancelled), or replace all items. Only send what changes. Marking an order delivered or cancelled does not touch its payments.',
    inputSchema: {
      order: z.number().describe('Order number'), customer: z.string().optional(), contact: z.string().optional(), due_date: z.string().optional(),
      notes: z.string().optional(), state: z.enum(['open', 'delivered', 'cancelled']).optional(),
      items: z.array(Item).optional().describe('If given, REPLACES all items on the order'),
    },
  }, guard('update_order', who, async ({ order, ...f }) => view(withBase(await core.updateOrder(biz.id, order, f)))));

  tools.record_payment = s.registerTool('record_payment', {
    description: 'Record money the seller has received against an order. Include the UPI reference number whenever the seller has it: the same reference cannot be recorded twice, which stops double counting.',
    inputSchema: { order: z.number(), ...Pay.shape },
  }, guard('record_payment', who, async ({ order, ...p }) => view(withBase(await core.recordPayment(biz.id, order, p)))));

  tools.import_orders = s.registerTool('import_orders', {
    description: 'Bring in many orders at once, for example from a sheet, a register or a chat history the seller shared. Map their columns yourself, SHOW THE SELLER A PREVIEW FIRST and only call this after they agree. Up to 200 orders per call. Orders that match an existing one (same customer, due date, total) are skipped, so re-running is safe. Include already received money in each order\'s payments.',
    inputSchema: { orders: z.array(OrderIn).min(1).max(200) },
  }, guard('import_orders', who, async ({ orders }) => core.importOrders(biz.id, orders)));


  // ---- costing. Claude collects the facts from the seller; the app only stores and computes.
  const rs = p => Math.round(p) / 100, qn = n => Math.round(n * 100) / 100;
  const recipeView = r => ({
    recipe: r.name, makes: r.yield_qty, packaging_per_item: rs(r.packaging_paise), notes: r.notes || undefined,
    lines: r.lines.map(l => ({ ingredient: l.name, qty: l.qty, unit: l.unit, cost: rs(l.cost) })),
    batch_cost: rs(r.batch_cost), cost_per_item: rs(r.unit_cost),
  });

  tools.save_recipe = s.registerTool('save_recipe', {
    description: 'Save how one item is made so Orderly can work out its cost. The name must match the item name used on orders (case does not matter). ' +
      'yield_qty = how many of that item one batch makes. packaging_cost = rupees of box, ribbon or sticker for ONE item. Each line is an ingredient and the quantity for one batch, in that ingredient\'s unit (g, ml or piece). ' +
      'For a NEW ingredient also send unit, pack_size (in that unit) and pack_price (rupees the seller pays for one pack), plus use_within_days_after_opening if it spoils once opened (cream, curd, fresh fruit). ' +
      'Never guess: ask the seller for pack sizes and prices, how many grams or ml their cup or spoon holds, and how long an opened pack lasts. ' +
      'Saving the same name again replaces that recipe\'s lines. Sending pack_size or pack_price for an existing ingredient updates it for every recipe.',
    inputSchema: {
      name: z.string().describe('Exact item name from orders, e.g. "Brownie box of 6"'),
      yield_qty: z.number().describe('How many items one batch makes'),
      packaging_cost: z.number().optional().describe('Rupees of packaging per ONE item'),
      notes: z.string().optional(),
      lines: z.array(z.object({
        ingredient: z.string(), qty: z.number().describe('Amount per batch, in the ingredient\'s unit'),
        unit: z.enum(['g', 'ml', 'piece']).optional().describe('Required for a new ingredient'),
        pack_size: z.number().optional().describe('Size of the pack the seller buys, in the same unit'),
        pack_price: z.number().optional().describe('Rupees for one pack'),
        use_within_days_after_opening: z.number().int().nullable().optional().describe('Days an opened pack stays usable; null if it keeps'),
      })).min(1),
    },
  }, guard('save_recipe', who, async r => recipeView(await core.saveRecipe(biz.id, r))));

  tools.add_expense = s.registerTool('add_expense', {
    description: 'Record a monthly cost that is not an ingredient: gas, electricity, rent share, delivery, platform fees, equipment. ' +
      'It is shared across that month\'s orders by revenue when working out margins. Ask the seller for the amount; do not invent one. ' +
      'If they only know roughly (e.g. "a ₹1,100 gas cylinder lasts about 6 weeks"), work it out with them, set is_estimate true and say in note how it was estimated.',
    inputSchema: {
      month: z.string().describe('YYYY-MM'), category: z.string().describe('e.g. gas, electricity, rent share, delivery'),
      amount: z.number().describe('Rupees for the month'), note: z.string().optional(), is_estimate: z.boolean().optional(),
    },
  }, guard('add_expense', who, async e => { const r = await core.addExpense(biz.id, e);
    return { saved: { month: r.month, category: r.category, amount: rs(r.amount_paise), is_estimate: r.is_estimate, note: r.note || undefined }, month_expenses_total: rs(r.month_total_paise), month_expense_count: r.month_expense_count }; }));

  tools.profit_summary = s.registerTool('profit_summary', {
    description: 'Profit for one month: orders due that month (cancelled ones left out). Revenue minus ingredient and packaging cost (from recipes) minus overhead (that month\'s expenses, shared by revenue). ' +
      'Items with no recipe show "cost unknown": then the total margin is too high by their missing cost, so tell the seller which items and offer to add those recipes with save_recipe. ' +
      'Also shows money collected, still outstanding, and reported by customers but not yet confirmed (which does not count yet).',
    inputSchema: { month: z.string().describe('YYYY-MM') },
  }, guard('profit_summary', who, async ({ month }) => {
    const p = await core.profitSummary(biz.id, month);
    if (!p.orders && !p.expenses.length) return `No orders due in ${p.month} and no expenses recorded for it.`;
    const pct = v => p.revenue ? Math.round(v / p.revenue * 1000) / 10 : null;
    return {
      month: p.month, orders: p.orders, revenue: rs(p.revenue), cost: rs(p.cost), overhead: rs(p.overhead), margin: rs(p.margin), margin_percent: pct(p.margin),
      ...(p.cost_complete ? {} : { cost_unknown_for: p.unknown_cost_items, warning: `Cost unknown for ${p.unknown_cost_items.join(', ')} (₹${rs(p.unknown_cost_revenue)} of sales): no recipe matches. The margin above leaves their cost out, so it is too high.` }),
      overhead_detail: p.expenses.map(e => ({ category: e.category, amount: rs(e.amount_paise), ...(e.is_estimate ? { estimate: true, how: e.note } : e.note ? { note: e.note } : {}) })),
      margin_by_item: p.by_item.map(it => ({ item: it.item, qty: it.qty, revenue: rs(it.revenue),
        cost: it.cost === null ? 'cost unknown' : rs(it.cost), cost_per_item: it.unit_cost === null ? 'cost unknown' : rs(it.unit_cost),
        overhead_share: rs(it.overhead), margin: it.margin === null ? 'cost unknown' : rs(it.margin), orders: it.orders })),
      collected: rs(p.collected), outstanding: rs(p.outstanding), reported_awaiting_confirmation: rs(p.awaiting_confirmation),
    };
  }));

  tools.make_list = s.registerTool('make_list', {
    description: 'Shopping and prep list for OPEN orders due between two dates: total of each ingredient needed (from recipes), how many packs that is, and perishables that spoil after opening. ' +
      'Items with no recipe are listed separately because their ingredients are unknown; offer to add those recipes.',
    inputSchema: { due_from: z.string().describe('YYYY-MM-DD'), due_to: z.string().describe('YYYY-MM-DD') },
  }, guard('make_list', who, async ({ due_from, due_to }) => {
    const m = await core.makeList(biz.id, due_from, due_to);
    if (!m.orders) return `No open orders due between ${m.from} and ${m.to}.`;
    const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
    return {
      from: m.from, to: m.to, open_orders: m.orders,
      ingredients: m.ingredients.map(n => ({
        ingredient: n.ingredient, need: qn(n.qty), unit: n.unit, packs: Math.ceil(n.qty / n.pack_size - 1e-9), pack_size: n.pack_size,
        packs_cost: rs(Math.ceil(n.qty / n.pack_size - 1e-9) * n.pack_price_paise), for: [...n.items],
        ...(n.use_within ? { perishable: true, use_within_days_after_opening: n.use_within, first_needed: n.first, last_needed: n.last,
          ...(days(n.first, n.last) >= n.use_within ? { warning: `Needed from ${n.first} to ${n.last}, more than ${n.use_within} days apart: one opened pack will not last. Buy or open separately for the later orders.` } : {}) } : {}),
      })),
      perishables: m.ingredients.filter(n => n.use_within).map(n => n.ingredient),
      ...(m.missing.length ? { no_recipe: m.missing.map(x => ({ item: x.item, qty: x.qty, orders: x.orders })), note: 'Ingredients for the no_recipe items are not in this list.' } : {}),
    };
  }));

  // Claude only sees the tools this email may use
  for (const [name, t] of Object.entries(tools)) if (!can(who, name)) t.disable();
  return s;
}

// Claude sends the token it got from signing in. No token or an expired one gets a 401 that tells
// Claude where to sign in (RFC 9728), and Claude refreshes or asks the person to sign in again.
export async function mcpHandler(req, res) {
  const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  const who = await userForAccessToken(token);
  if (!who) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"${token ? ', error="invalid_token"' : ''}`);
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Sign in to Orderly to use this connector.' }, id: null });
  }
  // a chat that still remembers a tool the owner has since switched off gets a plain answer, not "tool disabled"
  const b = req.body;
  if (b?.method === 'tools/call' && TOOL_NAMES.includes(b.params?.name) && !can(who, b.params.name))
    return res.json({ jsonrpc: '2.0', id: b.id, result: { isError: true, content: [{ type: 'text', text: notAllowed(who, b.params.name) }] } });
  const server = buildServer(who, baseUrl(req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
