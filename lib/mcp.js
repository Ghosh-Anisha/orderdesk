import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as core from './core.js';
import { q } from './db.js';

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
const guard = fn => async args => {
  try { return ok(await fn(args)); }
  catch (e) {
    if (e instanceof core.UserError) return { isError: true, content: [{ type: 'text', text: e.message }] };
    console.error(e); return { isError: true, content: [{ type: 'text', text: 'Something went wrong on our side. Try again in a moment.' }] };
  }
};

export function buildServer(biz, base) {
  const withBase = o => ({ ...o, base });
  const s = new McpServer({ name: `${biz.name} orders`, version: '1.0.0' }, {
    instructions: `You manage orders and payments for "${biz.name}", a small made-to-order seller. Today is ${core.today()} (India). ` +
      'Never guess missing details: if a customer, date, item or price is unclear, ask the seller first. ' +
      'Amounts are rupees. Dates are YYYY-MM-DD. Money only counts as received when recorded with record_payment; ' +
      'payments customers report on their order page wait for the seller to confirm in the app.',
  });

  s.registerTool('list_orders', {
    description: 'Look up orders. Use for "what is due this week", "who has not paid", "show Priya\'s orders". All filters are optional. Returns totals, balance due and payment status for each.',
    inputSchema: {
      state: z.enum(['open', 'delivered', 'cancelled']).optional(),
      payment: z.enum(['unpaid', 'part-paid', 'paid']).optional().describe('"unpaid" also returns part-paid orders'),
      due_from: z.string().optional().describe('YYYY-MM-DD'), due_to: z.string().optional().describe('YYYY-MM-DD'),
      customer: z.string().optional().describe('Part of a customer name'),
    },
  }, guard(async a => { const rows = await core.listOrders(biz.id, a); return rows.length ? rows.map(o => view(withBase(o))) : 'No orders match.'; }));

  s.registerTool('add_order', {
    description: 'Create one order. Ask the seller for anything missing (customer, due date, items with prices) before calling. If a similar order (same customer, due date, total) exists it is refused unless allow_duplicate is true. Returns the order number and the link to send the customer.',
    inputSchema: { ...OrderIn.shape, allow_duplicate: z.boolean().optional() },
  }, guard(async ({ allow_duplicate, ...o }) => {
    const r = await core.addOrder(biz.id, o, { allowDuplicate: allow_duplicate });
    if (r.duplicateOf) throw new core.UserError(`Looks like order #${r.duplicateOf} is already this order (same customer, date and total). Nothing was added. If it really is a second order, call again with allow_duplicate true.`);
    return { ...view(withBase(await core.getOrder(biz.id, r.number))), ...(r.warnings.length ? { warnings: r.warnings } : {}) };
  }));

  s.registerTool('update_order', {
    description: 'Change an order by its number: customer, contact, due date, notes, state (open / delivered / cancelled), or replace all items. Only send what changes. Marking an order delivered or cancelled does not touch its payments.',
    inputSchema: {
      order: z.number().describe('Order number'), customer: z.string().optional(), contact: z.string().optional(), due_date: z.string().optional(),
      notes: z.string().optional(), state: z.enum(['open', 'delivered', 'cancelled']).optional(),
      items: z.array(Item).optional().describe('If given, REPLACES all items on the order'),
    },
  }, guard(async ({ order, ...f }) => view(withBase(await core.updateOrder(biz.id, order, f)))));

  s.registerTool('record_payment', {
    description: 'Record money the seller has received against an order. Include the UPI reference number whenever the seller has it: the same reference cannot be recorded twice, which stops double counting.',
    inputSchema: { order: z.number(), ...Pay.shape },
  }, guard(async ({ order, ...p }) => view(withBase(await core.recordPayment(biz.id, order, p)))));

  s.registerTool('import_orders', {
    description: 'Bring in many orders at once, for example from a sheet, a register or a chat history the seller shared. Map their columns yourself, SHOW THE SELLER A PREVIEW FIRST and only call this after they agree. Up to 200 orders per call. Orders that match an existing one (same customer, due date, total) are skipped, so re-running is safe. Include already received money in each order\'s payments.',
    inputSchema: { orders: z.array(OrderIn).min(1).max(200) },
  }, guard(async ({ orders }) => core.importOrders(biz.id, orders)));

  return s;
}

export async function mcpHandler(req, res) {
  const biz = (await q('SELECT id,name FROM businesses WHERE mcp_token=$1', [req.params.token])).rows[0];
  if (!biz) return res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'This link is not valid. Copy the current link from Settings in the app.' }, id: null });
  const base = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const server = buildServer(biz, base);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
