import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const B = process.env.BASE || 'http://localhost:3111';
const run = Date.now();
import crypto from 'node:crypto';
const form = (body, cookie) => ({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body) });
async function signup(name) {
  const r = await fetch(B + '/signup', form({ name, email: `${name.toLowerCase()}${run}@t.com`, password: 'password123' }));
  assert.equal(r.status, 302, 'signup redirect');
  return { cookie: r.headers.get('set-cookie').split(';')[0] };
}
// Does what Claude does: discover, register, sign in with PKCE, swap the code for tokens.
async function signIn(cookie, { verifierOverride } = {}) {
  const meta = await (await fetch(B + '/.well-known/oauth-protected-resource')).json();
  const as = await (await fetch(meta.authorization_servers[0] + '/.well-known/oauth-authorization-server')).json();
  const redirect_uri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await (await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect_uri] }) })).json();
  const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' };
  const consent = await (await fetch(as.authorization_endpoint + '?' + new URLSearchParams(params), { headers: { cookie } })).text();
  assert.ok(consent.includes('Allow'), 'consent screen shown');
  const r = await fetch(as.authorization_endpoint, form({ ...params, decision: 'allow' }, cookie));
  const loc = new URL(r.headers.get('location')); assert.equal(loc.searchParams.get('state'), 'xyz');
  const code = loc.searchParams.get('code');
  const tok = await fetch(as.token_endpoint, form({ grant_type: 'authorization_code', code, code_verifier: verifierOverride || verifier, client_id: reg.client_id, redirect_uri }));
  return { status: tok.status, ...(await tok.json()), code, client_id: reg.client_id, token_endpoint: as.token_endpoint, consent };
}
const refused = async tok => { try { await (await connect(tok)).call('list_orders', {}); return false; } catch { return true; } };
async function connect(accessToken) {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(B + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; return { err: r.isError, t, j: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };
  return { c, call };
}
const ok = (m) => console.log('  ✓', m);

const A = await signup('Kudough'), Z = await signup('Other');
let u = await fetch(B + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
assert.equal(u.status, 401); assert.match(u.headers.get('www-authenticate'), /resource_metadata=".*\/.well-known\/oauth-protected-resource"/); ok('no sign-in → 401 pointing Claude to sign-in');
const bad = await signIn(A.cookie, { verifierOverride: 'wrong-verifier-wrong-verifier-wrong-verifier' });
assert.equal(bad.status, 400); assert.equal(bad.error, 'invalid_grant'); ok('wrong PKCE verifier refused');
const At = await signIn(A.cookie); assert.equal(At.status, 200); assert.ok(At.access_token && At.refresh_token); ok('owner signs in with OAuth + PKCE');
const reuse = await fetch(At.token_endpoint, form({ grant_type: 'authorization_code', code: At.code, code_verifier: 'x', client_id: At.client_id }));
assert.equal(reuse.status, 400); ok('sign-in code works only once');
const { c, call } = await connect(At.access_token);
const tools = (await c.listTools()).tools.map(t => t.name).sort();
assert.deepEqual(tools, ['add_expense', 'add_order', 'import_orders', 'list_orders', 'make_list', 'profit_summary', 'record_payment', 'save_recipe', 'update_order']); ok('connects over MCP, owner sees all 9 tools');

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

// ---- costing and margins, on a worked example in March 2027
const mk = async (customer, due_date, items) => (await call('add_order', { customer, due_date, items })).j;
const meera = await mk('Meera', '2027-03-05', [{ name: 'Brownie box of 6', qty: 2, unit_price: 620 }]);
const kabir = await mk('Kabir', '2027-03-12', [{ name: 'cupcakes', qty: 12, unit_price: 90 }, { name: 'Gift card', qty: 1, unit_price: 200 }]);
const zoya = await mk('Zoya', '2027-03-20', [{ name: 'Brownie box of 6', qty: 1, unit_price: 620 }]);
await call('update_order', { order: zoya.order, state: 'cancelled' });
r = await call('save_recipe', { name: 'Brownie box of 6', yield_qty: 1, lines: [{ ingredient: 'Flour', qty: 100 }] });
assert.ok(r.err && /new ingredient/.test(r.t) && /unit \(g, ml or piece\), pack size, pack price/.test(r.t)); ok('new ingredient without pack details → asks for them, saves nothing');
r = await call('save_recipe', { name: 'Brownie box of 6', yield_qty: 1, packaging_cost: 18, lines: [
  { ingredient: 'Flour', qty: 100, unit: 'g', pack_size: 1000, pack_price: 60 }, { ingredient: 'Butter', qty: 100, unit: 'g', pack_size: 500, pack_price: 250 },
  { ingredient: 'Cocoa', qty: 20, unit: 'g', pack_size: 100, pack_price: 100 }, { ingredient: 'Eggs', qty: 2, unit: 'piece', pack_size: 6, pack_price: 48 }] });
assert.equal(r.j.batch_cost, 92); assert.equal(r.j.cost_per_item, 110); ok('recipe cost: (6+50+20+16)/1 + ₹18 packaging = ₹110 a box');
r = await call('save_recipe', { name: 'Cupcakes', yield_qty: 12, packaging_cost: 3, lines: [{ ingredient: 'flour', qty: 200 }, { ingredient: 'Butter', qty: 120 }, { ingredient: 'Eggs', qty: 3 },
  { ingredient: 'Cream', qty: 120, unit: 'ml', pack_size: 200, pack_price: 80, use_within_days_after_opening: 3 }] });
assert.equal(r.j.batch_cost, 144); assert.equal(r.j.cost_per_item, 15); ok('ingredients reused by name; ₹144/12 + ₹3 = ₹15 a cupcake');
r = await call('save_recipe', { name: 'Cupcakes', yield_qty: 12, lines: [{ ingredient: 'Butter', qty: 120, unit: 'ml' }] });
assert.ok(r.err && /measured in g/.test(r.t)); ok('unit mismatch refused in plain English');
r = await call('add_expense', { month: '2027-03', category: 'rent share', amount: 204, is_estimate: true });
assert.ok(r.err && /how it was worked out/.test(r.t)); ok('estimate without a note is refused');
r = await call('add_expense', { month: 'March', category: 'gas', amount: 300 }); assert.ok(r.err && /YYYY-MM/.test(r.t)); ok('bad month → plain error');
await call('add_expense', { month: '2027-03', category: 'gas', amount: 300 });
r = await call('add_expense', { month: '2027-03', category: 'rent share', amount: 204, is_estimate: true, note: '₹6,120 rent, kitchen is 1/30 of the flat' });
assert.equal(r.j.month_expenses_total, 504); ok('expenses saved, month total ₹504');
await call('record_payment', { order: meera.order, amount: 1240, upi_ref: 'MAR001' });
await call('record_payment', { order: kabir.order, amount: 500, upi_ref: 'MAR002' });
await fetch(kabir.customer_page.replace(/^https?:\/\/[^/]+/, B) + '/paid', form({ amount: '780', upi_ref: '777766665555' }));
r = await call('profit_summary', { month: '2027-03' }); const P = r.j;
assert.equal(P.orders, 2); assert.equal(P.revenue, 2520); assert.equal(P.cost, 400); assert.equal(P.overhead, 504); assert.equal(P.margin, 1616); assert.equal(P.margin_percent, 64.1);
ok('margin maths: ₹2,520 revenue − ₹400 cost − ₹504 overhead = ₹1,616 (cancelled order left out)');
const item = n => P.margin_by_item.find(i => i.item.toLowerCase() === n);
assert.deepEqual([item('brownie box of 6').cost, item('brownie box of 6').overhead_share, item('brownie box of 6').margin], [220, 248, 772]);
assert.deepEqual([item('cupcakes').cost, item('cupcakes').overhead_share, item('cupcakes').margin, item('cupcakes').cost_per_item], [180, 216, 684, 15]);
ok('overhead shared by revenue: brownies ₹248, cupcakes ₹216; item margins ₹772 and ₹684');
assert.equal(item('gift card').cost, 'cost unknown'); assert.equal(item('gift card').margin, 'cost unknown'); assert.equal(item('gift card').overhead_share, 40);
assert.deepEqual(P.cost_unknown_for, ['Gift card']); assert.match(P.warning, /too high/); ok('item with no recipe shows "cost unknown", never zero, and the total is flagged');
assert.deepEqual([P.collected, P.outstanding, P.reported_awaiting_confirmation], [1740, 780, 780]); ok('collected ₹1,740 vs outstanding ₹780; customer-reported ₹780 not counted');
assert.ok(P.overhead_detail.find(e => e.category === 'rent share').estimate); ok('estimated expenses are marked with how they were estimated');
r = await call('make_list', { due_from: '2027-03-01', due_to: '2027-03-31' });
const need = n => r.j.ingredients.find(i => i.ingredient === n);
assert.equal(r.j.open_orders, 2); assert.deepEqual([need('Flour').need, need('Butter').need, need('Cocoa').need, need('Eggs').need, need('Cream').need], [400, 320, 40, 7, 120]);
assert.equal(need('Eggs').packs, 2); assert.deepEqual(r.j.perishables, ['Cream']); assert.equal(need('Cream').warning, undefined); assert.equal(r.j.no_recipe[0].item, 'Gift card');
ok('make list: flour 400 g, butter 320 g, cocoa 40 g, 7 eggs (2 packs), cream 120 ml flagged perishable; gift card has no recipe');
await mk('Ira', '2027-03-20', [{ name: 'Cupcakes', qty: 6, unit_price: 90 }]);
r = await call('make_list', { due_from: '2027-03-01', due_to: '2027-03-31' });
assert.equal(need('Cream').need, 180); assert.match(need('Cream').warning, /more than 3 days apart/); ok('cream needed 8 days apart → warns an opened pack will not last');
r = await call('save_recipe', { name: 'Brownie box of 6', yield_qty: 1, lines: [{ ingredient: 'Flour', qty: 100, pack_price: 120 }, { ingredient: 'Butter', qty: 100 }, { ingredient: 'Cocoa', qty: 20 }, { ingredient: 'Eggs', qty: 2 }] });
assert.equal(r.j.cost_per_item, 116); r = await call('save_recipe', { name: 'Cupcakes', yield_qty: 12, lines: [{ ingredient: 'Flour', qty: 200 }, { ingredient: 'Butter', qty: 120 }, { ingredient: 'Eggs', qty: 3 }, { ingredient: 'Cream', qty: 120 }] });
assert.equal(r.j.cost_per_item, 16); ok('new flour price flows into every recipe (costs are computed, not stored); packaging kept');

// isolation
const z = await connect((await signIn(Z.cookie)).access_token);
r = await z.call('list_orders', {}); assert.match(r.t, /No orders/); ok('second business sees none of the first business\'s orders');
r = await z.call('update_order', { order: 1, state: 'cancelled' }); assert.ok(r.err); ok('second business cannot touch order #1');
r = await z.call('profit_summary', { month: '2027-03' }); assert.match(r.t, /No orders due/); ok('second business sees none of the first business\'s profit');
r = await z.call('make_list', { due_from: '2027-03-01', due_to: '2027-03-31' }); assert.match(r.t, /No open orders/); ok('second business gets an empty make list');
r = await z.call('save_recipe', { name: 'Brownie box of 6', yield_qty: 1, lines: [{ ingredient: 'Flour', qty: 100 }] }); assert.ok(r.err && /new ingredient/.test(r.t)); ok('first business\'s ingredients are invisible to the second');
await z.call('save_recipe', { name: 'Brownie box of 6', yield_qty: 1, lines: [{ ingredient: 'Flour', qty: 100, unit: 'g', pack_size: 1000, pack_price: 999 }] });
r = await call('profit_summary', { month: '2027-03' }); assert.equal(r.j.margin_by_item.find(i => i.item === 'Brownie box of 6').cost_per_item, 116); ok('second business\'s same-named recipe does not change the first business\'s costs');
const old = await fetch(B + '/mcp/not-a-real-token', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' }); assert.equal(old.status, 410); assert.match((await old.json()).error.message, /replaced by sign-in/); ok('old secret links are switched off with a plain message');
assert.ok(await refused('made-up-token')); ok('made-up token refused');

// team: owner invites a helper who may add orders but not touch money
let set = await (await fetch(B + '/settings', { headers: { cookie: A.cookie } })).text();
assert.ok(set.includes('Team') && set.includes(B + '/mcp')); ok('settings shows Team and the one connector address');
await fetch(B + '/team/invite', form({ email: `helper${run}@t.com`, tools: 'add_order' }, A.cookie));
set = await (await fetch(B + '/settings', { headers: { cookie: A.cookie } })).text();
const join = set.match(/data-copy="(https?:\/\/[^"]+\/join\/[^"]+)"/)[1].replace(/^https?:\/\/[^/]+/, B);
let jr = await fetch(B + '/signup', form({ name: 'Sneaky', email: `helper${run}@t.com`, password: 'password123' })); assert.equal(jr.status, 400); ok('invited email cannot sign up as a separate business');
jr = await fetch(join, form({ password: 'helperpass1' })); assert.equal(jr.status, 302);
const H = { cookie: jr.headers.get('set-cookie').split(';')[0] }; ok('helper joins from the invite link');
assert.equal((await fetch(join)).status, 404); ok('invite link works only once');
const Ht = await signIn(H.cookie); assert.ok(Ht.consent.includes('Not allowed for this email') && Ht.consent.includes('Record and confirm payments')); ok('helper consent screen lists what is not allowed');
const hc = await connect(Ht.access_token);
assert.deepEqual((await hc.c.listTools()).tools.map(t => t.name).sort(), ['add_order', 'list_orders']); ok('helper\'s Claude only lists the tools they may use');
r = await hc.call('list_orders', {}); assert.ok(r.j.length >= 1); ok('helper sees the owner\'s orders through Claude');
r = await hc.call('add_order', { customer: 'Dev', due_date: '2026-12-01', items: [{ name: 'Cookie tin', qty: 1, unit_price: 450 }] }); assert.ok(!r.err); ok('helper can add an order');
r = await hc.call('record_payment', { order: 1, amount: 10, upi_ref: 'HELPER123' }); assert.ok(r.err && /not allowed to use "Record and confirm payments"/.test(r.t)); ok('helper cannot record payments (plain-English refusal)');
r = await hc.call('update_order', { order: 1, notes: 'x' }); assert.ok(r.err && /not allowed/.test(r.t)); ok('helper cannot change orders');
r = await hc.call('profit_summary', { month: '2027-03' }); assert.ok(r.err && /See profit and margins/.test(r.t)); ok('helper cannot see profit unless the owner allows it');
assert.equal((await fetch(B + '/orders/2/payments', form({ amount: 5 }, H.cookie))).status, 403); ok('web app applies the same rule (403)');
assert.equal((await fetch(B + '/team/invite', form({ email: 'x@y.com' }, H.cookie))).status, 302); assert.ok(!(await (await fetch(B + '/settings', { headers: { cookie: A.cookie } })).text()).includes('x@y.com')); ok('helper cannot invite people');
const mid = set.match(/action="\/team\/members\/(\d+)"/)?.[1] || (await (await fetch(B + '/settings', { headers: { cookie: A.cookie } })).text()).match(/action="\/team\/members\/(\d+)"/)[1];
await fetch(B + `/team/members/${mid}`, form([['tools', 'add_order'], ['tools', 'record_payment']], A.cookie));
r = await hc.call('record_payment', { order: 2, amount: 10, upi_ref: 'HELPER123' }); assert.ok(!r.err, r.t); ok('owner allows payments → helper\'s existing connection can now record');
const ref = await fetch(Ht.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: Ht.refresh_token }));
const Hr = await ref.json(); assert.ok(Hr.access_token); ok('refresh token gives a new access token');
assert.equal((await fetch(Ht.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: Ht.refresh_token }))).status, 400); ok('old refresh token cannot be reused');
await fetch(B + `/team/members/${mid}/remove`, form({}, A.cookie));
assert.ok(await refused(Hr.access_token)); ok('removed helper\'s Claude connection stops working');
html = await (await fetch(B + '/orders/1', { headers: { cookie: Z.cookie }, redirect: 'manual' })).text(); assert.ok(!html.includes('Priya') ); ok('web: other business cannot open order #1');
assert.equal((await fetch(B + '/orders', { redirect: 'manual' })).status, 302); ok('web: logged-out visitors go to login');
console.log('\nALL PASSED');
process.exit(0);
