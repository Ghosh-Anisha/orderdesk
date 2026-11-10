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
const z = await connect((await signIn(Z.cookie)).access_token);
r = await z.call('list_orders', {}); assert.match(r.t, /No orders/); ok('second business sees none of the first business\'s orders');
r = await z.call('update_order', { order: 1, state: 'cancelled' }); assert.ok(r.err); ok('second business cannot touch order #1');
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
r = await hc.call('list_orders', {}); assert.ok(r.j.length >= 1); ok('helper sees the owner\'s orders through Claude');
r = await hc.call('add_order', { customer: 'Dev', due_date: '2026-12-01', items: [{ name: 'Cookie tin', qty: 1, unit_price: 450 }] }); assert.ok(!r.err); ok('helper can add an order');
r = await hc.call('record_payment', { order: 1, amount: 10, upi_ref: 'HELPER123' }); assert.ok(r.err && /not allowed to use "Record and confirm payments"/.test(r.t)); ok('helper cannot record payments (plain-English refusal)');
r = await hc.call('update_order', { order: 1, notes: 'x' }); assert.ok(r.err && /not allowed/.test(r.t)); ok('helper cannot change orders');
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
