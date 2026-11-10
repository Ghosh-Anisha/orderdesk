import express from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { q, ensureSchema } from './lib/db.js';
import * as core from './lib/core.js';
import { mcpHandler } from './lib/mcp.js';
import { page, esc, inr, when, chip } from './lib/ui.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('orderly:' + (process.env.DATABASE_URL || process.env.POSTGRES_URL || 'dev')).digest('hex');
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const base = req => `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`;
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(a => a[0]));
const setSession = (req, res, uid) => {
  const v = `${uid}.${sign(String(uid))}`;
  res.setHeader('Set-Cookie', `sid=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${base(req).startsWith('https') ? '; Secure' : ''}`);
};

app.get('/health', (req, res) => res.json({ ok: true }));
app.use(h(async (req, res, next) => { await ensureSchema(); next(); }));

// ---- auth
async function loadUser(req) {
  const sid = cookies(req).sid; if (!sid) return null;
  const [uid, sig] = sid.split('.');
  if (!sig || sign(uid) !== sig) return null;
  const r = await q('SELECT u.id, u.email, b.id AS bid, b.name AS biz_name, b.upi_id, b.logo, b.qr, b.mcp_token FROM users u JOIN businesses b ON b.id=u.business_id WHERE u.id=$1', [uid]);
  return r.rows[0] || null;
}
const authed = h(async (req, res, next) => {
  req.user = await loadUser(req);
  if (!req.user) return res.redirect('/login');
  next();
});
const authForm = (title, action, fields, foot, err) => page(title, `<div style="max-width:420px;margin:48px auto"><h1>${title}</h1>
<p class="muted" style="margin:.5rem 0 0">Orders, payments and a page your customers can pay from. Claude does the typing.</p>
<form method="post" action="${action}" class="sec" style="margin-top:20px">${fields}<button style="width:100%;margin-top:18px">${title}</button></form><p>${foot}</p></div>`, { flash: { err } });

app.get('/signup', (req, res) => res.send(authForm('Create account', '/signup',
  `<label for="n">Business name</label><input id="n" name="name" required placeholder="e.g. Kudough"><label for="e">Email</label><input id="e" type="email" name="email" required><label for="p">Password (8 or more characters)</label><input id="p" type="password" name="password" minlength="8" required>`,
  'Have an account? <a href="/login">Log in</a>')));
app.post('/signup', h(async (req, res) => {
  const { name = '', email = '', password = '' } = req.body; const e = email.trim().toLowerCase();
  const again = err => res.status(400).send(authForm('Create account', '/signup',
    `<label for="n">Business name</label><input id="n" name="name" required value="${esc(name)}"><label for="e">Email</label><input id="e" type="email" name="email" required value="${esc(email)}"><label for="p">Password (8 or more characters)</label><input id="p" type="password" name="password" minlength="8" required>`,
    'Have an account? <a href="/login">Log in</a>', err));
  if (!name.trim()) return again('Add your business name.');
  if (!/^\S+@\S+\.\S+$/.test(e)) return again('That email does not look right.');
  if (password.length < 8) return again('Use a password of at least 8 characters.');
  if ((await q('SELECT 1 FROM users WHERE email=$1', [e])).rowCount) return again('That email already has an account. Log in instead.');
  const b = (await q('INSERT INTO businesses (name, mcp_token) VALUES ($1,$2) RETURNING id', [name.trim(), core.token(32)])).rows[0];
  const u = (await q('INSERT INTO users (business_id,email,password_hash) VALUES ($1,$2,$3) RETURNING id', [b.id, e, await bcrypt.hash(password, 10)])).rows[0];
  setSession(req, res, u.id); res.redirect('/settings?welcome=1');
}));
const loginForm = (err, email = '') => authForm('Log in', '/login',
  `<label for="e">Email</label><input id="e" type="email" name="email" required value="${esc(email)}"><label for="p">Password</label><input id="p" type="password" name="password" required>`,
  'New here? <a href="/signup">Create an account</a>', err);
app.get('/login', (req, res) => res.send(loginForm()));
app.post('/login', h(async (req, res) => {
  const e = (req.body.email || '').trim().toLowerCase();
  const u = (await q('SELECT id,password_hash FROM users WHERE email=$1', [e])).rows[0];
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) return res.status(401).send(loginForm('Email or password is wrong.', e));
  setSession(req, res, u.id); res.redirect('/');
}));
app.get('/logout', (req, res) => { res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0'); res.redirect('/login'); });

// ---- today
const orderRow = o => `<div class="row"><div><a href="/orders/${o.number}"><b>#${o.number} ${esc(o.customer)}</b></a><div class="muted">${when(o.due_date)} · ${o.items.map(i => esc(i.name)).slice(0, 2).join(', ')}${o.items.length > 2 ? '…' : ''}</div></div>
<div style="text-align:right">${chip(o.pay)} <b class="num">${o.balance ? inr(o.balance) + ' due' : inr(o.total)}</b></div></div>`;

app.get('/', authed, h(async (req, res) => {
  const bid = req.user.bid;
  const all = (await core.listOrders(bid)).filter(o => o.state !== 'cancelled');
  const confirm = await core.paymentsToConfirm(bid);
  const t = core.today(), week = new Date(Date.parse(t) + 7 * 864e5).toISOString().slice(0, 10);
  const soon = all.filter(o => o.state === 'open' && o.due_date <= week);
  const owed = all.filter(o => o.balance > 0);
  let body = `<h1>Today</h1><p class="muted" style="margin:.3rem 0 20px">${when(t)}</p>`;
  if (!all.length) body += `<div class="sec empty"><h2>No orders yet</h2><p>Add your first order here, or ask Claude to add them from your DMs or a sheet.</p>
    <a class="btn" href="/orders/new">Add an order</a> <a class="btn ghost" href="/settings">Connect Claude</a></div>`;
  else {
    if (confirm.length) body += `<div class="sec hot"><h2>Payments to confirm</h2><p class="muted" style="margin-top:0">Customers say they paid. Check your UPI app, then confirm.</p>${confirm.map(p => `<div class="row"><div><b>${esc(p.customer)}</b> · order #${p.number}<div class="muted">${inr(p.amount_paise)} · ref <span class="mono">${esc(p.upi_ref || 'none given')}</span></div></div>
      <form method="post" action="/payments/${p.id}/confirm" style="display:flex;gap:8px"><button class="small">Confirm</button><button class="small ghost" formaction="/payments/${p.id}/delete">Not received</button></form></div>`).join('')}</div>`;
    body += `<div class="sec"><h2>Coming up (next 7 days)</h2>${soon.length ? soon.map(orderRow).join('') : '<p class="muted">Nothing due this week.</p>'}</div>
      <div class="sec"><h2>Waiting for money · ${inr(owed.reduce((s, o) => s + o.balance, 0))}</h2>${owed.length ? owed.map(orderRow).join('') : '<p class="muted">Everyone has paid.</p>'}</div>
      <a class="btn" href="/orders/new">Add an order</a>`;
  }
  res.send(page('Today', body, { user: req.user, nav: 'today' }));
}));

// ---- orders
const itemRows = items => (items.length ? items : [{ name: '', qty: 1, unit_paise: 0 }]).map(i => `<tr><td><input name="iname" value="${esc(i.name)}" placeholder="Item" aria-label="Item"></td>
<td style="width:70px"><input name="iqty" type="number" step="any" min="0" value="${i.qty}" aria-label="Quantity"></td><td style="width:110px"><input name="iprice" type="number" step="any" min="0" value="${i.unit_paise ? i.unit_paise / 100 : ''}" placeholder="₹ each" aria-label="Price each"></td></tr>`).join('');
const itemsTable = items => `<table id="items"><thead><tr><th>Item</th><th>Qty</th><th>Price each</th></tr></thead><tbody>${itemRows(items)}</tbody></table>
<button type="button" class="ghost small" style="margin-top:8px" data-additem>+ Add item</button>`;
const readItems = b => {
  const arr = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const n = arr(b.iname), qy = arr(b.iqty), p = arr(b.iprice);
  return n.map((name, i) => ({ name, qty: qy[i], unit_price: p[i] })).filter(i => String(i.name).trim() || i.unit_price);
};

app.get('/orders', authed, h(async (req, res) => {
  const show = req.query.show || 'open';
  let rows = await core.listOrders(req.user.bid);
  const tabs = { open: o => o.state === 'open', unpaid: o => o.state !== 'cancelled' && o.balance > 0, delivered: o => o.state === 'delivered', all: () => true };
  const list = rows.filter(tabs[show] || tabs.open);
  const body = `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px"><h1>Orders</h1><a class="btn" href="/orders/new">Add an order</a></div>
  <p>${[['open', 'Open'], ['unpaid', 'Unpaid'], ['delivered', 'Delivered'], ['all', 'All']].map(([k, l]) => `<a href="/orders?show=${k}" class="btn small ${show === k ? '' : 'ghost'}" style="margin-right:6px">${l}</a>`).join('')}</p>
  <div class="sec" style="padding:8px;overflow-x:auto">${list.length ? `<table><thead><tr><th>#</th><th>Customer</th><th>Due</th><th class="hide-sm">Status</th><th class="num hide-sm">Total</th><th>Payment</th></tr></thead><tbody>
  ${list.map(o => `<tr><td><a href="/orders/${o.number}">${o.number}</a></td><td style="min-width:110px"><input name="customer" value="${esc(o.customer)}" data-save="/orders/${o.number}/field"></td>
  <td style="min-width:140px"><input type="date" name="due_date" value="${o.due_date}" data-save="/orders/${o.number}/field"></td>
  <td class="hide-sm"><select name="state" data-save="/orders/${o.number}/field">${['open', 'delivered', 'cancelled'].map(s => `<option ${o.state === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
  <td class="num hide-sm">${inr(o.total)}</td><td>${chip(o.pay)}${o.balance && o.paid ? `<div class="muted">${inr(o.balance)} left</div>` : ''}</td></tr>`).join('')}</tbody></table>
  <p class="muted" style="padding:0 6px">Click a name, date or status to change it. It saves by itself.</p>`
      : `<div class="empty"><h2>Nothing here</h2><p>${rows.length ? 'No orders in this view.' : 'Add an order, or ask Claude to bring them in from your DMs or a sheet.'}</p></div>`}</div>`;
  res.send(page('Orders', body, { user: req.user, nav: 'orders' }));
}));

const newOrderForm = (v = {}, err) => `<h1>New order</h1><form method="post" action="/orders/new" class="sec" style="margin-top:16px">
<div class="grid2"><div><label for="c">Customer</label><input id="c" name="customer" required value="${esc(v.customer)}"></div>
<div><label for="ct">Phone or Instagram</label><input id="ct" name="contact" value="${esc(v.contact)}"></div>
<div><label for="d">Due date</label><input id="d" type="date" name="due_date" required value="${esc(v.due_date || core.today())}"></div>
<div><label for="n">Notes</label><input id="n" name="notes" value="${esc(v.notes)}" placeholder="Eggless, message on cake…"></div></div>
<label>Items</label>${itemsTable(v.items?.length ? v.items.map(i => ({ ...i, unit_paise: core.toPaise(i.unit_price || 0) })) : [])}
<button style="margin-top:18px">Save order</button></form>`;
app.get('/orders/new', authed, (req, res) => res.send(page('New order', newOrderForm(), { user: req.user, nav: 'orders' })));
app.post('/orders/new', authed, h(async (req, res) => {
  const b = req.body, items = readItems(b);
  try {
    const r = await core.addOrder(req.user.bid, { customer: b.customer, contact: b.contact, due_date: b.due_date, notes: b.notes, items }, { allowDuplicate: true });
    res.redirect(`/orders/${r.number}`);
  } catch (e) {
    if (!(e instanceof core.UserError)) throw e;
    res.status(400).send(page('New order', newOrderForm({ ...b, items }), { user: req.user, nav: 'orders', flash: { err: e.message } }));
  }
}));

app.post('/orders/:n/field', authed, h(async (req, res) => {
  try {
    await core.updateOrder(req.user.bid, +req.params.n, { [req.body.field]: req.body.value });
    res.json({ ok: true, reload: ['state', 'due_date'].includes(req.body.field) && false });
  } catch (e) { if (e instanceof core.UserError) return res.status(400).json({ error: e.message }); throw e; }
}));
app.post('/orders/:n/items', authed, h(async (req, res) => {
  try { await core.updateOrder(req.user.bid, +req.params.n, { items: readItems(req.body) }); res.redirect(`/orders/${req.params.n}?ok=Items+saved`); }
  catch (e) { if (e instanceof core.UserError) return res.redirect(`/orders/${req.params.n}?err=${encodeURIComponent(e.message)}`); throw e; }
}));
app.post('/orders/:n/payments', authed, h(async (req, res) => {
  try { await core.recordPayment(req.user.bid, +req.params.n, { amount: req.body.amount, paid_on: req.body.paid_on, upi_ref: req.body.upi_ref }); res.redirect(`/orders/${req.params.n}?ok=Payment+saved`); }
  catch (e) { if (e instanceof core.UserError) return res.redirect(`/orders/${req.params.n}?err=${encodeURIComponent(e.message)}`); throw e; }
}));
app.post('/payments/:id/:action(confirm|delete)', authed, h(async (req, res) => {
  try { await core.setPaymentState(req.user.bid, +req.params.id, req.params.action); } catch (e) { if (!(e instanceof core.UserError)) throw e; }
  res.redirect(req.get('referer')?.startsWith(base(req)) ? req.get('referer') : '/');
}));

app.get('/orders/:n', authed, h(async (req, res) => {
  let o; try { o = await core.getOrder(req.user.bid, +req.params.n); } catch (e) { if (e instanceof core.UserError) return res.status(404).send(page('Not found', `<div class="sec empty"><h2>${esc(e.message)}</h2><a class="btn" href="/orders">Back to orders</a></div>`, { user: req.user, nav: 'orders' })); throw e; }
  const link = `${base(req)}/o/${o.public_token}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(`Hi ${o.customer}, here is your order from ${req.user.biz_name}. You can see the amount and pay here: ${link}`)}`;
  const sv = `data-save="/orders/${o.number}/field"`;
  const body = `<p><a href="/orders">← Orders</a></p><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:6px 0 16px"><h1>#${o.number} ${esc(o.customer)}</h1>${chip(o.pay)}</div>
  <div class="sec"><div class="grid2"><div><label for="f1">Customer</label><input id="f1" name="customer" value="${esc(o.customer)}" ${sv}></div>
  <div><label for="f2">Phone or Instagram</label><input id="f2" name="contact" value="${esc(o.contact)}" ${sv}></div>
  <div><label for="f3">Due date</label><input id="f3" type="date" name="due_date" value="${o.due_date}" ${sv}></div>
  <div><label for="f4">Status</label><select id="f4" name="state" ${sv}>${['open', 'delivered', 'cancelled'].map(s => `<option ${o.state === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div>
  <label for="f5">Notes</label><input id="f5" name="notes" value="${esc(o.notes)}" ${sv}><p class="muted">Changes here save by themselves.</p></div>
  <form method="post" action="/orders/${o.number}/items" class="sec"><h2>Items</h2>${itemsTable(o.items)}<div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px"><button class="small">Save items</button><b>Total ${inr(o.total)}</b></div></form>
  <div class="sec"><h2>Payments</h2>${o.payments.map(p => `<div class="row"><div><b>${inr(p.amount_paise)}</b> <span class="muted">${when(p.paid_on)}${p.upi_ref ? ' · ref <span class="mono">' + esc(p.upi_ref) + '</span>' : ''}</span> ${p.state === 'reported' ? '<span class="chip part-paid">Customer says paid</span>' : ''}</div>
    <form method="post" style="display:flex;gap:8px">${p.state === 'reported' ? `<button class="small" formaction="/payments/${p.id}/confirm">Confirm</button>` : ''}<button class="small ghost" formaction="/payments/${p.id}/delete">Remove</button></form></div>`).join('') || '<p class="muted">No payments yet.</p>'}
  <p><b>${o.balance ? inr(o.balance) + ' still due' : 'Fully paid'}</b></p>
  <form method="post" action="/orders/${o.number}/payments"><div class="grid2"><div><label for="pa">Amount received (₹)</label><input id="pa" name="amount" type="number" step="any" min="0" required value="${o.balance ? o.balance / 100 : ''}"></div>
  <div><label for="pd">Date</label><input id="pd" name="paid_on" type="date" value="${core.today()}"></div></div><label for="pr">UPI reference (optional, stops double counting)</label><input id="pr" name="upi_ref"><button class="small" style="margin-top:14px">Record payment</button></form></div>
  <div class="sec"><h2>Customer link</h2><p class="muted" style="margin-top:0">They see the amount, your QR and UPI ID, and can tell you when they have paid.</p>
  <div class="copy"><input readonly value="${esc(link)}" aria-label="Customer link"><button class="small" data-copy="${esc(link)}">Copy</button></div>
  <p style="margin-bottom:0"><a class="btn small ghost" href="${wa}" target="_blank" rel="noopener">Send on WhatsApp</a> <a class="btn small ghost" href="${esc(link)}" target="_blank">Preview</a></p></div>`;
  res.send(page(`Order #${o.number}`, body, { user: req.user, nav: 'orders', flash: { ok: req.query.ok, err: req.query.err } }));
}));

// ---- settings
app.get('/settings', authed, h(async (req, res) => {
  const u = req.user, url = `${base(req)}/mcp/${u.mcp_token}`;
  const body = `<h1>Settings</h1>${req.query.welcome ? '<p class="okmsg" style="margin-top:14px">Account created. Add your UPI details below, then connect Claude.</p>' : ''}
  <form method="post" action="/settings" class="sec" style="margin-top:16px"><h2>Your business</h2>
  <label for="bn">Business name</label><input id="bn" name="name" value="${esc(u.biz_name)}" required>
  <label for="up">UPI ID customers pay to</label><input id="up" name="upi_id" value="${esc(u.upi_id)}" placeholder="name@bank" autocapitalize="off">
  <label for="lg">Logo (optional)</label><input id="lg" type="file" accept="image/*" data-img="400" data-target="logo"><input type="hidden" id="logo" name="logo"><img id="logo_p" class="logo" ${u.logo ? `src="${u.logo}"` : 'hidden'} alt="Logo" style="margin-top:8px">
  <label for="qrf">Your UPI QR code (optional, screenshot from your UPI app)</label><input id="qrf" type="file" accept="image/*" data-img="700" data-target="qr"><input type="hidden" id="qr" name="qr"><img id="qr_p" class="qr" style="margin-left:0" ${u.qr ? `src="${u.qr}"` : 'hidden'} alt="UPI QR">
  <button style="margin-top:18px">Save settings</button></form>
  <div class="sec"><h2>Connect Claude</h2><p class="muted" style="margin-top:0">Once connected, you can tell Claude "add an order for Priya, 12 brownies, Saturday" or drop in a sheet or screenshot of DMs and it fills this app for you.</p>
  <ol class="steps"><li>Copy your private link below.</li><li>In Claude, open <b>Customize → Connectors → + → Add custom connector</b>.</li><li>Name it <b>${esc(u.biz_name)}</b>, paste the link, choose <b>No sign in</b>, and add it.</li><li>Open a new chat and say "show my orders".</li></ol>
  <div class="copy"><input readonly value="${esc(url)}" aria-label="Private Claude link"><button class="small" data-copy="${esc(url)}">Copy</button></div>
  <p class="muted">Anyone with this link can read and change your orders, so keep it private.</p>
  <form method="post" action="/settings/reset-link"><button class="small ghost">Make a new link</button> <span class="muted">The old one stops working.</span></form></div>`;
  res.send(page('Settings', body, { user: u, nav: 'settings', flash: { ok: req.query.ok } }));
}));
app.post('/settings', authed, h(async (req, res) => {
  const { name, upi_id = '', logo, qr } = req.body;
  const img = v => (v && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 900000) ? v : null;
  await q('UPDATE businesses SET name=$2, upi_id=$3, logo=COALESCE($4,logo), qr=COALESCE($5,qr) WHERE id=$1', [req.user.bid, (name || req.user.biz_name).trim(), upi_id.trim(), img(logo), img(qr)]);
  res.redirect('/settings?ok=Saved');
}));
app.post('/settings/reset-link', authed, h(async (req, res) => {
  await q('UPDATE businesses SET mcp_token=$2 WHERE id=$1', [req.user.bid, core.token(32)]); res.redirect('/settings?ok=New+link+ready.+Update+it+in+Claude.');
}));

// ---- customer page
const publicShell = (b, inner) => page(`${b.name} · your order`, `<div class="pay-card">${b.logo ? `<img class="logo" src="${b.logo}" alt="">` : `<h2 style="margin:0">${esc(b.name)}</h2>`}${inner}</div>`);
const itemsList = o => `<table style="margin:12px 0"><tbody>${o.items.map(i => `<tr><td>${esc(i.name)} × ${i.qty}</td><td class="num">${inr(Math.round(i.qty * i.unit_paise))}</td></tr>`).join('')}<tr><td><b>Total</b></td><td class="num"><b>${inr(o.total)}</b></td></tr></tbody></table>`;
app.get('/o/:token', h(async (req, res) => {
  const r = await core.getByPublicToken(req.params.token);
  if (!r) return res.status(404).send(page('Not found', '<div class="sec empty" style="margin-top:40px"><h2>This order link is not valid</h2><p>Ask the seller to send it again.</p></div>'));
  const { order: o, business: b } = r;
  const pending = o.payments.filter(p => p.state === 'reported');
  let inner = `<p class="muted" style="margin:18px 0 0">Order for ${esc(o.customer)} · ${when(o.due_date)}</p>`;
  if (o.state === 'cancelled') inner += `<h1 style="margin:10px 0">This order was cancelled</h1>`;
  else if (o.pay === 'paid') inner += `<div class="big" style="color:var(--pista-d)">Paid, thank you!</div>${itemsList(o)}<a class="btn noprint" href="/o/${req.params.token}/receipt">Get receipt</a>`;
  else {
    const due = o.balance - o.reported;
    inner += `<div class="big">${inr(o.balance)}</div><p style="margin:0">to pay</p>${itemsList(o)}`;
    if (pending.length) inner += `<div class="okmsg">You told us you paid ${inr(o.reported)}. ${esc(b.name)} will confirm it soon.</div>`;
    if (due > 0 || !pending.length) inner += `<div class="sec"><h2>Pay by UPI</h2>
      ${b.qr ? `<img class="qr" src="${b.qr}" alt="UPI QR code">` : ''}
      ${b.upi_id ? `<label>UPI ID</label><div class="copy"><input readonly value="${esc(b.upi_id)}"><button class="small" data-copy="${esc(b.upi_id)}">Copy</button></div>` : '<p class="muted">The seller has not added a UPI ID yet. Message them to pay.</p>'}
      <label>Amount</label><div class="copy"><input readonly value="${o.balance / 100}"><button class="small" data-copy="${o.balance / 100}">Copy</button></div></div>
      <form method="post" action="/o/${req.params.token}/paid" class="sec"><h2>Already paid?</h2><p class="muted" style="margin-top:0">Tell ${esc(b.name)} so they can mark it paid.</p>
      <label for="a">Amount you paid (₹)</label><input id="a" name="amount" type="number" step="any" min="1" required value="${Math.max(due, 0) / 100 || o.balance / 100}">
      <label for="r">UPI reference number</label><input id="r" name="upi_ref" required minlength="6" maxlength="30" placeholder="From your payment app, e.g. 4082 7391 5526" autocomplete="off">
      <button style="width:100%;margin-top:16px">I've paid</button></form>`;
  }
  res.send(publicShell(b, inner + (req.query.err ? `<div class="err" role="alert">${esc(req.query.err)}</div>` : '')));
}));
app.post('/o/:token/paid', h(async (req, res) => {
  const r = await core.getByPublicToken(req.params.token); if (!r) return res.sendStatus(404);
  const ref = String(req.body.upi_ref || '').replace(/\s+/g, '');
  try {
    if (!/^[A-Za-z0-9]{6,30}$/.test(ref)) throw new core.UserError('Enter the reference number from your payment app (letters and numbers only).');
    if (r.order.state === 'cancelled') throw new core.UserError('This order was cancelled.');
    await core.recordPayment(r.business.id, r.order.number, { amount: req.body.amount, upi_ref: ref }, 'reported');
    res.redirect(`/o/${req.params.token}`);
  } catch (e) { if (e instanceof core.UserError) return res.redirect(`/o/${req.params.token}?err=${encodeURIComponent(e.message)}`); throw e; }
}));
app.get('/o/:token/receipt', h(async (req, res) => {
  const r = await core.getByPublicToken(req.params.token);
  if (!r || r.order.pay !== 'paid') return res.redirect(`/o/${req.params.token}`);
  const { order: o, business: b } = r;
  const last = o.payments.filter(p => p.state === 'confirmed').map(p => p.paid_on).sort().pop();
  res.send(page(`Receipt #${o.number}`, `<div class="pay-card">${b.logo ? `<img class="logo" src="${b.logo}" alt="">` : ''}<h1 style="margin-top:12px">${esc(b.name)}</h1><h2 style="margin-top:20px">Receipt for order #${o.number}</h2>
    <p class="muted">${esc(o.customer)} · delivered ${when(o.due_date)}<br>Paid in full${last ? ' on ' + when(last) : ''}</p>${itemsList(o)}
    ${o.payments.filter(p => p.state === 'confirmed').map(p => `<p class="muted" style="margin:2px 0">Received ${inr(p.amount_paise)} on ${when(p.paid_on)}${p.upi_ref ? ' · ref ' + esc(p.upi_ref) : ''}</p>`).join('')}
    <p class="noprint" style="margin-top:24px"><button onclick="print()">Print or save as PDF</button></p></div>`));
}));

// ---- Claude connector + daily reminder
app.post('/mcp/:token', h(mcpHandler));
app.all('/mcp/:token', (req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST.' }, id: null }));

app.get('/cron/reminders', h(async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.sendStatus(401);
  const t = core.today(), tomorrow = new Date(Date.parse(t) + 864e5).toISOString().slice(0, 10);
  const sent = [];
  for (const b of (await q('SELECT b.id,b.name,(SELECT email FROM users WHERE business_id=b.id ORDER BY id LIMIT 1) email FROM businesses b')).rows) {
    const due = (await core.listOrders(b.id, { state: 'open', due_to: tomorrow })).filter(o => o.due_date >= t);
    if (!due.length || !b.email) continue;
    const text = `Orders due today and tomorrow:\n` + due.map(o => `#${o.number} ${o.customer}, ${o.due_date}, ${o.balance ? inr(o.balance) + ' still to collect' : 'paid'}`).join('\n');
    if (process.env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: process.env.MAIL_FROM || 'Orderly <onboarding@resend.dev>', to: b.email, subject: `${due.length} order${due.length > 1 ? 's' : ''} coming up`, text }) });
      sent.push({ business: b.id, ok: r.ok });
    } else sent.push({ business: b.id, skipped: 'RESEND_API_KEY not set', orders: due.length });
  }
  res.json({ ok: true, sent });
}));

app.use((err, req, res, next) => { console.error(err); res.status(500).send(page('Error', '<div class="sec empty" style="margin-top:40px"><h2>Something went wrong</h2><p>Try again. If it keeps happening, tell the person who set this up.</p><a class="btn" href="/">Go home</a></div>')); });

if (!process.env.VERCEL) app.listen(process.env.PORT || 3000, () => console.log('Orderly on :' + (process.env.PORT || 3000)));
export default app;
