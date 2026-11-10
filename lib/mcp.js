import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as core from './core.js';
import { userForAccessToken, can, toolLabelFor as toolLabel, baseUrl } from './access.js';

const rupees = p => p / 100;
const view = o => ({
  order: o.number, customer: o.customer, contact: o.contact, due_date: o.due_date, state: o.state, notes: o.notes,
  items: o.items.map(i => ({ name: i.name, qty: i.qty, unit_price: rupees(i.unit_paise) })),
  total: rupees(o.total), paid: rupees(o.paid), balance_due: rupees(o.balance), payment_status: o.pay,
  ...(o.reported ? { reported_awaiting_confirmation: rupees(o.reported) } : {}),
  payments: o.payments.map(p => ({ amount: rupees(p.amount_paise), date: p.paid_on, upi_ref: p.upi_ref, state: p.state })),
  customer_page: `${o.base}/o/${o.public_token}`,
});

const Item = z.object({
  name: z.string().describe('Use the exact product name from list_products, e.g. "Brownie box of 6"'), qty: z.number().describe('How many'),
  unit_price: z.number().optional().describe('Rupees for ONE. Leave out to use the catalogue price; give it only to override the price for this order'),
});
const Pay = z.object({ amount: z.number().describe('Rupees received'), paid_on: z.string().optional().describe('YYYY-MM-DD, defaults to today'), upi_ref: z.string().optional().describe('UPI reference / UTR number if known') });
const OrderIn = z.object({
  customer: z.string(), contact: z.string().optional().describe('Phone or Instagram handle'),
  due_date: z.string().describe('Delivery or pickup date, YYYY-MM-DD'),
  items: z.array(Item).min(1), notes: z.string().optional(), payments: z.array(Pay).optional().describe('Money already received for this order'),
});

const ok = data => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });
const ALL_TOOLS = ['list_orders', 'add_order', 'update_order', 'record_payment', 'import_orders', 'list_products', 'save_products',
  'save_recipe', 'remove_recipe', 'add_expense', 'remove_expense', 'profit_summary', 'make_list'];
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

  const tools = {}, allowed = ALL_TOOLS.filter(t => can(who, t)).join(', ');
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
    description: 'Create one order. Use the exact product names from list_products; then the price comes from the catalogue and can be left out (a given unit_price overrides it for this order only). If an item is not a product, ask the seller for its price or add it with save_products first. Ask for anything else missing (customer, due date) before calling. If a similar order (same customer, due date, total) exists it is refused unless allow_duplicate is true. Returns the order number and the link to send the customer.',
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
      items: z.array(Item).optional().describe('If given, REPLACES all items on the order. Items without unit_price get today\'s catalogue price, so send unit_price for items whose original price must be kept'),
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
    product: r.name, makes: r.yield_qty, packaging_per_item: rs(r.packaging_paise), notes: r.notes || undefined,
    lines: r.lines.map(l => ({ ingredient: l.name, qty: l.qty, unit: l.unit, cost: rs(l.cost) })),
    batch_cost: rs(r.batch_cost), cost_per_item: rs(r.unit_cost),
  });

  tools.list_products = s.registerTool('list_products', {
    description: 'The seller\'s product catalogue: names, prices, whether each is active, and cost per item where a recipe exists. Use these exact names when adding orders so prices fill in by themselves.',
    inputSchema: { active_only: z.boolean().optional() },
  }, guard('list_products', who, async ({ active_only }) => {
    const ps = await core.listProducts(biz.id, { activeOnly: active_only });
    if (!ps.length) return 'No products yet. Ask the seller for their menu or price list and add it with save_products.';
    return ps.map(p => ({ name: p.name, price: p.price_paise === null ? 'no price yet' : rs(p.price_paise), active: p.active,
      cost_per_item: p.recipe ? rs(p.recipe.unit_cost) : 'cost unknown', ...(p.recipe && p.price_paise !== null ? { margin_per_item_before_overhead: rs(p.price_paise - p.recipe.unit_cost) } : {}) }));
  }));

  tools.save_products = s.registerTool('save_products', {
    description: 'Add or update catalogue products in bulk (up to 200), matched by name (case does not matter). A new product needs a price; for an existing one, send only what changes (price, or active false to switch it off). ' +
      'Use the seller\'s exact product names. Ask for any missing price; never guess. For more than a few products, show the seller a preview table first and only save after they agree. ' +
      'Changing a price never changes existing orders: they keep the price they were sold at.',
    inputSchema: { products: z.array(z.object({ name: z.string(), price: z.number().optional().describe('Rupees for one'), active: z.boolean().optional() })).min(1).max(200) },
  }, guard('save_products', who, async ({ products }) => {
    const r = await core.saveProducts(biz.id, products);
    const money = x => ({ ...x, ...(x.price_paise !== undefined ? { price: rs(x.price_paise) } : {}), ...(x.old_price_paise !== undefined ? { old_price: x.old_price_paise === null ? 'none' : rs(x.old_price_paise) } : {}), price_paise: undefined, old_price_paise: undefined, id: undefined });
    return { created: r.created.map(money), updated: r.updated.map(money), unchanged: r.unchanged.length, errors: r.errors };
  }));

  tools.save_recipe = s.registerTool('save_recipe', {
    description: 'Save how one product is made so Orderly can work out its cost. One recipe per product: give the exact product name from list_products. ' +
      'If the product is not in the catalogue yet, ask the seller what it sells for and send it as price; it is added first. ' +
      'yield_qty = how many of that product one batch makes. packaging_cost = rupees of box, ribbon or sticker for ONE item. Each line is an ingredient and the quantity for one batch, in that ingredient\'s unit (g, ml or piece). ' +
      'For a NEW ingredient also send unit, pack_size (in that unit) and pack_price (rupees the seller pays for one pack), plus use_within_days_after_opening if it spoils once opened (cream, curd, fresh fruit). ' +
      'Never guess: ask the seller for pack sizes and prices, how many grams or ml their cup or spoon holds, and how long an opened pack lasts. ' +
      'Saving again replaces that recipe\'s lines. Sending pack_size or pack_price for an existing ingredient updates it for every recipe.',
    inputSchema: {
      product: z.string().describe('Exact product name, e.g. "Brownie box of 6"'),
      price: z.number().optional().describe('Selling price in rupees; only used if the product does not exist yet'),
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

  tools.remove_recipe = s.registerTool('remove_recipe', {
    description: 'Delete the recipe of one product (the product stays in the catalogue, its cost becomes unknown). Confirm with the seller first.',
    inputSchema: { product: z.string().describe('Exact product name') },
  }, guard('remove_recipe', who, async ({ product }) => { const r = await core.removeRecipe(biz.id, product); return `Removed the recipe for ${r.removed}. Its cost now shows as unknown until a new recipe is saved.`; }));

  tools.add_expense = s.registerTool('add_expense', {
    description: 'Record a monthly cost that is not an ingredient: gas, electricity, rent share, delivery, platform fees, equipment. One amount per month and category: saving the same month and category again REPLACES it, so re-estimating never double counts. ' +
      'It is shared across that month\'s orders by revenue when working out margins. Ask the seller for the amount; do not invent one. ' +
      'If they only know roughly (e.g. "a ₹1,100 gas cylinder lasts about 6 weeks"), work it out with them, set is_estimate true and say in note how it was estimated.',
    inputSchema: {
      month: z.string().describe('YYYY-MM'), category: z.string().describe('e.g. gas, electricity, rent share, delivery'),
      amount: z.number().describe('Rupees for the month'), note: z.string().optional(), is_estimate: z.boolean().optional(),
    },
  }, guard('add_expense', who, async e => { const r = await core.addExpense(biz.id, e);
    return { saved: { month: r.month, category: r.category, amount: rs(r.amount_paise), is_estimate: r.is_estimate, note: r.note || undefined }, replaced_previous: r.replaced, month_expenses_total: rs(r.month_total_paise), month_expense_count: r.month_expense_count }; }));

  tools.remove_expense = s.registerTool('remove_expense', {
    description: 'Delete one month\'s expense in a category (e.g. a mistake). Confirm with the seller first.',
    inputSchema: { month: z.string().describe('YYYY-MM'), category: z.string() },
  }, guard('remove_expense', who, async a => { const r = await core.removeExpense(biz.id, a); return `Removed ${r.category} (₹${rs(r.amount_paise)}) from ${r.month}.`; }));

  tools.profit_summary = s.registerTool('profit_summary', {
    description: 'Profit for one month, or for a range of months (from_month to to_month, up to 24): orders due in those months (cancelled ones left out). Revenue minus ingredient and packaging cost (from recipes) minus overhead (each month\'s expenses, shared across that month\'s orders by revenue). ' +
      'For a range it also gives each month\'s totals (the trend) and each product\'s totals for the whole range. ' +
      'Items that are not a product, or whose product has no recipe, show "cost unknown": then the total margin is too high by their missing cost, so tell the seller which items and offer to add products or recipes. ' +
      'Also shows money collected, still outstanding, and reported by customers but not yet confirmed (which does not count yet).',
    inputSchema: { month: z.string().optional().describe('YYYY-MM, for one month'), from_month: z.string().optional().describe('YYYY-MM, start of a range'), to_month: z.string().optional().describe('YYYY-MM, end of a range (inclusive)') },
  }, guard('profit_summary', who, async ({ month, from_month, to_month }) => {
    const from = from_month || month || to_month, to = to_month || month || from_month;
    if (!from) throw new core.UserError('Say which month (month: "2026-11") or which range (from_month and to_month).');
    const p = await core.profitRange(biz.id, from, to);
    const label = from === to ? from : `${from} to ${to}`;
    if (!p.orders && !p.months.some(m => m.expenses.length)) return `No orders due in ${label} and no expenses recorded for it.`;
    const pct = (v, of) => of ? Math.round(v / of * 1000) / 10 : null;
    return {
      ...(from === to ? { month: from } : { from_month: from, to_month: to }),
      orders: p.orders, revenue: rs(p.revenue), cost: rs(p.cost), overhead: rs(p.overhead), margin: rs(p.margin), margin_percent: pct(p.margin, p.revenue),
      ...(p.cost_complete ? {} : { cost_unknown_for: p.unknown_cost_items, warning: `Cost unknown for ${p.unknown_cost_items.join(', ')} (₹${rs(p.unknown_cost_revenue)} of sales): not a product, or no recipe. The margin above leaves their cost out, so it is too high.` }),
      ...(from === to ? { overhead_detail: p.months[0].expenses.map(e => ({ category: e.category, amount: rs(e.amount_paise), ...(e.is_estimate ? { estimate: true, how: e.note } : e.note ? { note: e.note } : {}) })) }
        : { by_month: p.months.map(m => ({ month: m.month, orders: m.orders, revenue: rs(m.revenue), cost: rs(m.cost), overhead: rs(m.overhead), margin: rs(m.margin), margin_percent: pct(m.margin, m.revenue), ...(m.cost_complete ? {} : { cost_incomplete: true }) })) }),
      margin_by_item: p.by_item.map(it => ({ item: it.item, qty: it.qty, revenue: rs(it.revenue), share_of_revenue_percent: pct(it.revenue, p.revenue),
        cost: it.cost === null ? 'cost unknown' : rs(it.cost), cost_per_item: it.unit_cost === null ? 'cost unknown' : rs(it.unit_cost),
        ...(it.cost === null ? { why: it.has_product ? 'no recipe for this product' : 'not in the product catalogue' } : {}),
        overhead_share: rs(it.overhead), margin: it.margin === null ? 'cost unknown' : rs(it.margin), orders: it.orders })),
      collected: rs(p.collected), outstanding: rs(p.outstanding), reported_awaiting_confirmation: rs(p.awaiting_confirmation),
    };
  }));

  tools.make_list = s.registerTool('make_list', {
    description: 'Shopping and prep list for OPEN orders due between two dates: total of each ingredient needed (from recipes), how many packs that is, and perishables that spoil after opening, with the order dates they serve. ' +
      'Items with no recipe are listed separately because their ingredients are unknown; offer to add those recipes.',
    inputSchema: { due_from: z.string().describe('YYYY-MM-DD'), due_to: z.string().describe('YYYY-MM-DD') },
  }, guard('make_list', who, async ({ due_from, due_to }) => {
    const m = await core.makeList(biz.id, due_from, due_to);
    if (!m.orders) return `No open orders due between ${m.from} and ${m.to}.`;
    return {
      from: m.from, to: m.to, open_orders: m.orders,
      ingredients: m.ingredients.map(n => ({
        ingredient: n.ingredient, need: qn(n.qty), unit: n.unit, packs: n.packs, pack_size: n.pack_size, packs_cost: rs(n.packs * n.pack_price_paise), for: n.items,
        ...(n.use_within ? { perishable: true, use_within_days_after_opening: n.use_within, order_dates: n.dates,
          ...(n.too_far_apart ? { warning: `Needed from ${n.first} to ${n.last}, more than ${n.use_within} days apart: one opened pack will not last. Buy or open separately for the later orders.` } : {}) } : {}),
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
  if (b?.method === 'tools/call' && ALL_TOOLS.includes(b.params?.name) && !can(who, b.params.name))
    return res.json({ jsonrpc: '2.0', id: b.id, result: { isError: true, content: [{ type: 'text', text: notAllowed(who, b.params.name) }] } });
  const server = buildServer(who, baseUrl(req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
