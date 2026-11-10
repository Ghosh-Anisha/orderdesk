import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const B = process.env.BASE || 'http://localhost:3111';
const run = Date.now();
async function signup(name) {
  const r = await fetch(B + '/signup', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name, email: `${name.toLowerCase()}${run}@t.com`, password: 'password123' }) });
  assert.equal(r.status, 302, 'signup redirect');
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(B + '/settings', { headers: { cookie } })).text();
  const mcp = html.match(/value="([^"]+\/mcp\/[^"]+)"/)[1].replace(/^https?:\/\/[^/]+/, B);
  return { cookie, mcp };
}
async function connect(url) {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; return { err: r.isError, t, j: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };
  return { c, call };
}
const ok = (m) => console.log('  ✓', m);

const A = await signup('Kudough'), Z = await signup('Other');
const { c, call } = await connect(A.mcp);
const tools = (await c.listTools()).tools.map(t => t.name).sort();
assert.deepEqual(tools, ['add_order', 'import_orders', 'list_orders', 'record_payment', 'update_order']); ok('connects over MCP, 5 tools listed');

let r = await call('list_orders', {}); assert.match(r.t, /No orders/); ok('empty business says so plainly');
r = await call('add_order', { customer: 'Priya', due_date: '2026-11-14', items: [{ name: 'Brownie box of 6', qty: 2, unit_price: 620 }], contact: '@priya' });
assert.equal(r.j.order, 1); assert.equal(r.j.total, 1240); assert.equal(r.j.balance_due, 1240); assert.equal(r.j.payment_status, 'unpaid'); ok('add_order → #1, total ₹1240');
const pubLink = r.j.customer_page.replace(/^https?:\/\/[^/]+/, B);
r = await call('add_order', { customer: 'priya', due_date: '2026-11-14', items: [{ name: 'x', qty: 2, unit_price: 620 }] });
assert.ok(r.err && /already this order/.test(r.t)); ok('duplicate order refused with plain message');
r = await call('add_order', { customer: 'X', due_date: '14/11/2026', items: [{ name: 'a', qty: 1, unit_price: 5 }] });
assert.ok(r.err && /YYYY-MM-DD/.test(r.t)); ok('bad date → plain-English error');
r = await call('record_payment', { order: 1, amount: 500, upi_ref: 'ref111111' }); assert.equal(r.j.balance_due, 740); assert.equal(r.j.payment_status, 'part-paid'); ok('part payment → balance 740');
r = await call('record_payment', { order: 1, amount: 100, upi_ref: 'REF111111' }); assert.ok(r.err && /already recorded/.test(r.t)); ok('duplicate UPI ref refused (case-insensitive)');
r = await call('update_order', { order: 1, state: 'delivered', due_date: '2026-11-15' }); assert.equal(r.j.state, 'delivered'); assert.equal(r.j.due_date, '2026-11-15'); ok('update_order');
r = await call('update_order', { order: 99, state: 'open' }); assert.ok(r.err && /no order #99/.test(r.t)); ok('unknown order → plain error');

// customer page: logged out, only this order
let html = await (await fetch(pubLink)).text();
assert.ok(html.includes('₹740') && html.includes('Priya') && !html.includes('Kudough@') ); ok('customer page shows ₹740 due, no login');
let rr = await fetch(pubLink + '/paid', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ amount: '740', upi_ref: '4082 7391 5526' }) });
assert.equal(rr.status, 302);
html = await (await fetch(pubLink)).text(); assert.ok(/told us you paid/.test(html)); ok('"I\'ve paid" creates a reported payment');
r = await call('list_orders', { payment: 'unpaid' }); assert.equal(r.j[0].balance_due, 740); assert.equal(r.j[0].reported_awaiting_confirmation, 740); ok('reported money does NOT reduce balance until confirmed');
let dash = await (await fetch(B + '/', { headers: { cookie: A.cookie } })).text(); assert.ok(dash.includes('Payments to confirm')); 
const pid = dash.match(/\/payments\/(\d+)\/confirm/)[1];
await fetch(`${B}/payments/${pid}/confirm`, { method: 'POST', redirect: 'manual', headers: { cookie: A.cookie } });
r = await call('list_orders', {}); assert.equal(r.j[0].payment_status, 'paid'); ok('seller confirms → order paid');
rr = await fetch(pubLink + '/receipt'); assert.ok((await rr.text()).includes('Receipt for order #1')); ok('receipt available once paid');

// import
const orders = [
  { customer: 'Asha', due_date: '2026-11-20', items: [{ name: 'Cupcakes', qty: 12, unit_price: 90 }], payments: [{ amount: 500, upi_ref: 'AAA111' }] },
  { customer: 'Ben', due_date: '2026-11-21', items: [{ name: 'Cake', qty: 1, unit_price: 1800 }] },
  { customer: 'Priya', due_date: '2026-11-15', items: [{ name: 'Brownie box of 6', qty: 2, unit_price: 620 }] },
  { customer: 'Bad', due_date: 'tomorrow', items: [{ name: 'Cake', qty: 1, unit_price: 100 }] },
  { customer: 'Cara', due_date: '2026-11-22', items: [{ name: 'Cake', qty: 1, unit_price: 700 }], payments: [{ amount: 100, upi_ref: 'REF111111' }] },
];
r = await call('import_orders', { orders });
assert.equal(r.j.created.length, 3); assert.equal(r.j.skipped_duplicates.length, 1); assert.equal(r.j.errors.length, 1); assert.ok(r.j.created[2].warnings); ok('import: 3 created, 1 duplicate skipped, 1 bad row reported, dup payment ref warned');
r = await call('import_orders', { orders }); assert.equal(r.j.created.length, 0, 'rerun is idempotent'); assert.equal(r.j.skipped_duplicates.length, 4); ok('re-running the same import creates nothing new');
r = await call('list_orders', { due_from: '2026-11-20', due_to: '2026-11-21' }); assert.equal(r.j.length, 2); ok('date filter works');

// isolation
const z = await connect(Z.mcp);
r = await z.call('list_orders', {}); assert.match(r.t, /No orders/); ok('second business sees none of the first business\'s orders');
r = await z.call('update_order', { order: 1, state: 'cancelled' }); assert.ok(r.err); ok('second business cannot touch order #1');
const bad = await fetch(B + '/mcp/not-a-real-token', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' }); assert.equal(bad.status, 404); ok('wrong secret link → 404');
html = await (await fetch(B + '/orders/1', { headers: { cookie: Z.cookie }, redirect: 'manual' })).text(); assert.ok(!html.includes('Priya') ); ok('web: other business cannot open order #1');
assert.equal((await fetch(B + '/orders', { redirect: 'manual' })).status, 302); ok('web: logged-out visitors go to login');
console.log('\nALL PASSED');
process.exit(0);
