import express from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { q, ensureSchema } from './lib/db.js';
import * as core from './lib/core.js';
import { mcpHandler } from './lib/mcp.js';
import { page, esc, inr, when, chip, icon, copyBtn } from './lib/ui.js';

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
const authForm = (title, action, fields, foot, err) => page(title, `<div class="auth"><p class="auth-brand">Orderly</p><h1>${title}</h1>
<p class="muted">Orders, payments and a page your customers can pay from. Claude does the typing.</p>
${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}<form method="post" action="${action}" class="sec">${fields}<button class="wide" style="margin-top:20px">${title}</button></form><p>${foot}</p></div>`);
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
const dayBox = d => { const x = new Date(d + 'T00:00:00Z'); return `<span class="day" aria-hidden="true"><b>${x.getUTCDate()}</b>${x.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })}</span>`; };
const orderRow = (o, t) => `<div class="row orow">${dayBox(o.due_date)}<div class="who"><a href="/orders/${o.number}"><b>${esc(o.customer)}</b></a> <span class="muted">#${o.number}</span>
<div class="muted">${o.state === 'open' && o.due_date < t ? '<b class="late">Late</b> · ' : ''}<span class="sr">${when(o.due_date)} · </span>${o.items.map(i => esc(i.name)).slice(0, 2).join(', ')}${o.items.length > 2 ? '…' : ''}</div></div>
<div class="end">${chip(o.pay)}<span class="num"><b>${inr(o.balance || o.total)}</b>${o.balance ? ' <span class="muted">due</span>' : ''}</span></div></div>`;

app.get('/', authed, h(async (req, res) => {
  const bid = req.user.bid;
  const all = (await core.listOrders(bid)).filter(o => o.state !== 'cancelled');
  const confirm = await core.paymentsToConfirm(bid);
  const t = core.today(), week = new Date(Date.parse(t) + 7 * 864e5).toISOString().slice(0, 10);
  const soon = all.filter(o => o.state === 'open' && o.due_date <= week);
  const owed = all.filter(o => o.balance > 0);
  const owedSum = owed.reduce((s, o) => s + o.balance, 0);
  let body = `<div class="head"><div><h1>Today</h1><p class="muted">${when(t)}</p></div>${all.length ? `<a class="btn" href="/orders/new">${icon('plus')}Add an order</a>` : ''}</div>`;
  if (!all.length) body += `<div class="sec empty"><h2>No orders yet</h2><p>Add your first order here, or connect Claude and ask it to bring orders in from your DMs or a sheet.</p>
    <div class="btns"><a class="btn" href="/orders/new">${icon('plus')}Add an order</a><a class="btn ghost" href="/settings#claude">Connect Claude</a></div></div>`;
  else {
    body += `<dl class="stats"><div><dt>Due in 7 days</dt><dd>${soon.length}</dd></div><div><dt>Waiting for money</dt><dd>${inr(owedSum)}</dd></div><div><dt>To confirm</dt><dd>${confirm.length}</dd></div></dl>`;
    if (confirm.length) body += `<section class="sec hot"><h2>Payments to confirm</h2><p class="muted">Customers say they paid. Check your UPI app first, then confirm.</p>${confirm.map(p => `<div class="row"><div><b>${esc(p.customer)}</b> <span class="muted">· order <a href="/orders/${p.number}">#${p.number}</a></span><div><b class="num">${inr(p.amount_paise)}</b> <span class="muted">· ref <span class="mono">${esc(p.upi_ref || 'none given')}</span></span></div></div>
      <form method="post" action="/payments/${p.id}/confirm" class="btns end"><button class="small">${icon('check')}Confirm</button><button class="small ghost" formaction="/payments/${p.id}/delete">Not received</button></form></div>`).join('')}</section>`;
    body += `<section class="sec"><h2>Coming up in the next 7 days</h2>${soon.length ? soon.map(o => orderRow(o, t)).join('') : '<p class="muted" style="margin:0">Nothing due this week. New orders will show here.</p>'}</section>
      <section class="sec"><h2>Waiting for money</h2>${owed.length ? owed.map(o => orderRow(o, t)).join('') : '<p class="muted" style="margin:0">Everyone has paid.</p>'}</section>`;
  }
  res.send(page('Today', body, { user: req.user, nav: 'today' }));
}));

// ---- orders
const itemRows = items => (items.length ? items : [{ name: '', qty: 1, unit_paise: 0 }]).map(i => `<tr><td class="c-item"><input name="iname" value="${esc(i.name)}" placeholder="e.g. Brownie box of 6" aria-label="Item"></td>
<td class="c-qty"><input name="iqty" type="number" inputmode="decimal" step="any" min="0" value="${i.qty}" aria-label="Quantity"></td><td class="c-price"><input name="iprice" type="number" inputmode="decimal" step="any" min="0" value="${i.unit_paise ? i.unit_paise / 100 : ''}" placeholder="₹ each" aria-label="Price each in rupees"></td></tr>`).join('');
const itemsTable = items => `<table id="items" class="itable"><thead><tr><th>Item</th><th>Qty</th><th>Price each (₹)</th></tr></thead><tbody>${itemRows(items)}</tbody></table>
<div class="btns" style="margin-top:10px"><button type="button" class="ghost small" data-additem>${icon('plus')}Add item</button><span class="muted">To remove an item, clear its name.</span></div>`;
const readItems = b => {
  const arr = v => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const n = arr(b.iname), qy = arr(b.iqty), p = arr(b.iprice);
  return n.map((name, i) => ({ name, qty: qy[i], unit_price: p[i] })).filter(i => String(i.name).trim() || i.unit_price);
};

const VIEWS = { open: o => o.state === 'open', unpaid: o => o.state !== 'cancelled' && o.balance > 0, delivered: o => o.state === 'delivered', all: () => true };
const stateSelect = (o, attrs) => `<select name="state" ${attrs}>${[['open', 'Open'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']].map(([v, l]) => `<option value="${v}"${o.state === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;

app.get('/orders', authed, h(async (req, res) => {
  const show = req.query.show in VIEWS ? req.query.show : 'open';
  const rows = await core.listOrders(req.user.bid);
  const list = rows.filter(VIEWS[show]);
  const sv = o => `data-save="/orders/${o.number}/field"`;
  const body = `<div class="head"><h1>Orders</h1><a class="btn" href="/orders/new">${icon('plus')}Add an order</a></div>
  <nav class="tabs" aria-label="Show orders">${[['open', 'Open'], ['unpaid', 'Unpaid'], ['delivered', 'Delivered'], ['all', 'All']].map(([k, l]) => `<a href="/orders?show=${k}"${show === k ? ' aria-current="page"' : ''}>${l} <span class="n">${rows.filter(VIEWS[k]).length}</span></a>`).join('')}</nav>
  ${list.length ? `<div class="sec flush"><table class="otable"><thead><tr><th>#</th><th>Customer</th><th>Due</th><th>Status</th><th class="num">Total</th><th>Payment</th></tr></thead><tbody>
  ${list.map(o => `<tr><td class="c-no"><a href="/orders/${o.number}" aria-label="Open order ${o.number}">#${o.number}</a></td>
  <td class="c-name"><input name="customer" value="${esc(o.customer)}" aria-label="Customer, order ${o.number}" ${sv(o)}></td>
  <td class="c-due"><input type="date" name="due_date" value="${o.due_date}" aria-label="Due date, order ${o.number}" ${sv(o)}></td>
  <td class="c-state">${stateSelect(o, `aria-label="Status, order ${o.number}" ${sv(o)}`)}</td>
  <td class="c-total num">${inr(o.total)}</td><td class="c-pay">${chip(o.pay)}${o.balance && o.paid ? `<span class="muted left">${inr(o.balance)} left</span>` : ''}</td></tr>`).join('')}</tbody></table></div>
  <p class="muted">Change a name, date or status right in the list. It saves by itself.</p>`
    : `<div class="sec empty"><h2>${rows.length ? `No ${show === 'all' ? '' : show + ' '}orders` : 'No orders yet'}</h2><p>${rows.length ? 'Try another view above, or add a new order.' : 'Add an order, or connect Claude and ask it to bring orders in from your DMs or a sheet.'}</p><div class="btns"><a class="btn" href="/orders/new">${icon('plus')}Add an order</a>${rows.length ? '' : '<a class="btn ghost" href="/settings#claude">Connect Claude</a>'}</div></div>`}`;
  res.send(page('Orders', body, { user: req.user, nav: 'orders' }));
}));

const newOrderForm = (v = {}) => `<a class="back" href="/orders">${icon('back')}Orders</a><div class="head"><h1>New order</h1></div><form method="post" action="/orders/new" class="sec">
<div class="grid2"><div><label for="c">Customer</label><input id="c" name="customer" required value="${esc(v.customer)}" autocomplete="off"></div>
<div><label for="ct">Phone or Instagram <span class="hint">(optional)</span></label><input id="ct" name="contact" value="${esc(v.contact)}" autocomplete="off"></div>
<div><label for="d">Due date</label><input id="d" type="date" name="due_date" required value="${esc(v.due_date || core.today())}"></div></div>
<label for="n">Notes <span class="hint">(optional)</span></label><input id="n" name="notes" value="${esc(v.notes)}" placeholder="Eggless, message on cake…">
<h2 style="margin-top:28px">Items</h2>${itemsTable(v.items?.length ? v.items.map(i => ({ ...i, unit_paise: core.toPaise(i.unit_price || 0) })) : [])}
<div class="formfoot"><button>Save order</button><a class="btn ghost" href="/orders">Cancel</a></div></form>`;
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
  let o; try { o = await core.getOrder(req.user.bid, +req.params.n); } catch (e) { if (e instanceof core.UserError) return res.status(404).send(page('Not found', `<div class="sec empty"><h2>${esc(e.message)}</h2><p>It may have a different number. Find it in your orders list.</p><div class="btns"><a class="btn" href="/orders">Back to orders</a></div></div>`, { user: req.user, nav: 'orders' })); throw e; }
  const link = `${base(req)}/o/${o.public_token}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(`Hi ${o.customer}, here is your order from ${req.user.biz_name}. You can see the amount and pay here: ${link}`)}`;
  const sv = `data-save="/orders/${o.number}/field"`;
  const body = `<a class="back" href="/orders">${icon('back')}Orders</a>
  <div class="head"><div><h1>${esc(o.customer)}</h1><p class="muted">Order #${o.number} · due ${when(o.due_date)}</p></div>
  <div class="bal">${chip(o.pay)}<b class="num">${o.balance ? inr(o.balance) : inr(o.total)}</b><span class="muted">${o.balance ? 'still due' : 'paid in full'}</span></div></div>
  <div class="split"><div>
  <section class="sec"><h2>Details</h2><div class="grid2"><div><label for="f1">Customer</label><input id="f1" name="customer" value="${esc(o.customer)}" ${sv}></div>
  <div><label for="f2">Phone or Instagram</label><input id="f2" name="contact" value="${esc(o.contact)}" ${sv}></div>
  <div><label for="f3">Due date</label><input id="f3" type="date" name="due_date" value="${o.due_date}" ${sv}></div>
  <div><label for="f4">Status</label>${stateSelect(o, `id="f4" ${sv}`)}</div></div>
  <label for="f5">Notes</label><input id="f5" name="notes" value="${esc(o.notes)}" ${sv}><p class="muted" style="margin:10px 0 0">Changes here save by themselves.</p></section>
  <form method="post" action="/orders/${o.number}/items" class="sec"><h2>Items</h2>${itemsTable(o.items)}<div class="formfoot"><button>Save items</button><b class="num">Total ${inr(o.total)}</b></div></form>
  </div><div>
  <section class="sec"><h2>Payments</h2>${o.payments.map(p => `<div class="row"><div><b class="num">${inr(p.amount_paise)}</b> <span class="muted">${when(p.paid_on)}${p.upi_ref ? ' · ref <span class="mono">' + esc(p.upi_ref) + '</span>' : ''}</span>${p.state === 'reported' ? '<div><span class="chip waiting">Customer says paid</span></div>' : ''}</div>
    <form method="post" class="btns">${p.state === 'reported' ? `<button class="small" formaction="/payments/${p.id}/confirm">${icon('check')}Confirm</button><button class="small ghost" formaction="/payments/${p.id}/delete">Not received</button>` : `<button class="small ghost" formaction="/payments/${p.id}/delete">Remove</button>`}</form></div>`).join('') || '<p class="muted">No payments yet.</p>'}
  <form method="post" action="/orders/${o.number}/payments" class="subform"><h3>Record a payment</h3><div class="grid2"><div><label for="pa">Amount received (₹)</label><input id="pa" name="amount" type="number" inputmode="decimal" step="any" min="0" required value="${o.balance ? o.balance / 100 : ''}"></div>
  <div><label for="pd">Date</label><input id="pd" name="paid_on" type="date" value="${core.today()}"></div></div><label for="pr">UPI reference <span class="hint">(optional, stops double counting)</span></label><input id="pr" name="upi_ref" autocomplete="off"><button style="margin-top:16px">Record payment</button></form></section>
  <section class="sec"><h2>Customer link</h2><p class="muted">They see the amount, your QR and UPI ID, and can tell you when they have paid.</p>
  <div class="copy"><input readonly value="${esc(link)}" aria-label="Customer link">${copyBtn(link)}</div>
  <div class="btns" style="margin-top:12px"><a class="btn small ghost" href="${wa}" target="_blank" rel="noopener">${icon('send')}Send on WhatsApp</a><a class="btn small ghost" href="${esc(link)}" target="_blank" rel="noopener">${icon('open')}Preview</a></div></section>
  </div></div>`;
  res.send(page(`${o.customer} · order #${o.number}`, body, { user: req.user, nav: 'orders', flash: { ok: req.query.ok, err: req.query.err } }));
}));

// ---- settings
app.get('/settings', authed, h(async (req, res) => {
  const u = req.user, url = `${base(req)}/mcp/${u.mcp_token}`;
  const img = (id, src, cls, alt) => src ? `<img id="${id}_p" class="${cls}" src="${src}" alt="${alt}" style="margin-top:10px">` : '';
  const body = `<div class="head"><h1>Settings</h1></div>${req.query.welcome ? '<div class="okmsg" role="status">Account created. Add your UPI details below, then connect Claude.</div>' : ''}
  <div class="split"><form method="post" action="/settings" class="sec"><h2>Your business</h2>
  <label for="bn">Business name</label><input id="bn" name="name" value="${esc(u.biz_name)}" required>
  <label for="up">UPI ID customers pay to</label><input id="up" name="upi_id" value="${esc(u.upi_id)}" placeholder="name@bank" autocapitalize="off" autocomplete="off" spellcheck="false">
  ${u.upi_id ? '' : '<p class="muted" style="margin:6px 0 0">Without a UPI ID, customers see a note asking them to message you.</p>'}
  <label for="qrf">UPI QR code <span class="hint">(optional, a screenshot from your UPI app)</span></label><input id="qrf" type="file" accept="image/*" data-img="700" data-target="qr" data-cls="qr"><input type="hidden" id="qr" name="qr">${img('qr', u.qr, 'qr', 'Your UPI QR code')}
  <label for="lg">Logo <span class="hint">(optional)</span></label><input id="lg" type="file" accept="image/*" data-img="400" data-target="logo" data-cls="logo"><input type="hidden" id="logo" name="logo">${img('logo', u.logo, 'logo', 'Your logo')}
  <div class="formfoot"><button>Save settings</button></div></form>
  <section class="sec" id="claude"><h2>Connect Claude</h2><p class="muted">Then you can tell Claude "add an order for Priya, 12 brownies, Saturday", or drop in a sheet or a screenshot of your DMs, and it fills this app for you.</p>
  <ol class="steps"><li>Copy your private link below.</li><li>In Claude, open <b>Customize → Connectors → + → Add custom connector</b>.</li><li>Name it <b>${esc(u.biz_name)}</b>, paste the link, choose <b>No sign in</b>, and add it.</li><li>Open a new chat and say "show my orders".</li></ol>
  <div class="copy"><input readonly value="${esc(url)}" aria-label="Private Claude link">${copyBtn(url)}</div>
  <p class="muted" style="margin-top:10px">Anyone with this link can read and change your orders, so keep it private.</p>
  <form method="post" action="/settings/reset-link" class="subform"><h3>Link shared by mistake?</h3><p class="muted">Make a new link. The old one stops working, so paste the new one into Claude.</p><button class="small ghost">Make a new link</button></form></section></div>`;
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
// The amount is split so the ₹ sign can sit small; the aria-label keeps it one readable number.
const bigAmount = p => { const s = inr(p); return `<div class="amt" style="--len:${s.length - 0.5}" aria-label="${s}"><span class="cur" aria-hidden="true">₹</span><span aria-hidden="true">${s.slice(1)}</span></div>`; };
const bizMark = b => `<div class="pay-biz">${b.logo ? `<img src="${b.logo}" alt="">` : ''}<span>${esc(b.name)}</span></div>`;
const payShell = (b, hero, sheet, tone = '') => page(`${b.name} · your order`, `<main class="pay"><section class="pay-hero ${tone}"><div class="in">${bizMark(b)}${hero}</div></section>
<section class="pay-sheet"><div class="in">${sheet}</div></section></main>`, { bare: 'paybody', theme: { done: '#2F5A21', off: '#1E2230' }[tone] || '#8A2646' });
const itemsList = o => `<ul class="lines">${o.items.map(i => `<li><span>${esc(i.name)} <span class="muted">× ${i.qty}</span></span><span>${inr(Math.round(i.qty * i.unit_paise))}</span></li>`).join('')}
<li class="tot"><span>Total</span><span>${inr(o.total)}</span></li>${o.paid && o.balance ? `<li class="got"><span>Received so far</span><span>${inr(o.paid)}</span></li>` : ''}</ul>`;
const upiLink = (b, o, amount) => `upi://pay?${new URLSearchParams({ pa: b.upi_id, pn: b.name, am: (amount / 100).toFixed(2), cu: 'INR', tn: `Order ${o.number}` })}`;

app.get('/o/:token', h(async (req, res) => {
  const r = await core.getByPublicToken(req.params.token);
  if (!r) return res.status(404).send(page('Link not found', `<div class="sec empty" style="margin-top:40px"><h1>This order link does not work</h1><p>It may have been copied only in part. Ask the seller to send the link again.</p></div>`));
  const { order: o, business: b } = r;
  const tok = esc(req.params.token), first = esc(o.customer.split(' ')[0]);
  const due = Math.max(o.balance - o.reported, 0);
  const err = req.query.err ? `<div class="err" role="alert">${esc(req.query.err)}</div>` : '';
  const order = `<div class="pay-part"><h2>Order #${o.number} · ${when(o.due_date)}</h2>${itemsList(o)}</div>`;

  if (o.state === 'cancelled') return res.send(payShell(b,
    `<p class="pay-for">Order #${o.number} for ${esc(o.customer)}</p><div class="amt words">This order was cancelled</div><p class="pay-note">Nothing to pay</p>`,
    `${order}<div class="pay-part"><p style="margin:0">If this is a mistake, message ${esc(b.name)}.</p></div>`, 'off'));

  if (o.pay === 'paid') return res.send(payShell(b,
    `<span class="stamp go">${icon('check')}</span><p class="pay-for" style="margin-top:20px">Paid in full. Thank you, ${first}.</p>${bigAmount(o.total)}<p class="pay-note">Order #${o.number} · ${when(o.due_date)}</p>`,
    `${order}<div class="pay-part"><a class="btn wide noprint" href="/o/${tok}/receipt">${icon('print')}Get receipt</a></div>`, 'done'));

  const reportedNote = o.reported ? `You told us you paid ${inr(o.reported)}. ${esc(b.name)} will confirm it soon.` : '';
  if (o.reported && !due) return res.send(payShell(b,
    `${req.query.sent ? `<span class="stamp go" style="background:var(--saffron);color:var(--ink)">${icon('check')}</span>` : ''}<p class="pay-for">Hi ${first}, your payment is on its way to ${esc(b.name)}.</p>${bigAmount(o.reported)}
    <p class="pay-note">${icon('clock')}Waiting for ${esc(b.name)} to confirm</p>`,
    `<div class="pay-part" role="status"><h2>Nothing more to do</h2><p style="margin:0">${reportedNote} They check their UPI app, then this page will say Paid.</p></div>${order}${err}`));

  const toPay = o.reported ? due : o.balance;
  const pay = `<div class="pay-part"><h2>Pay by UPI</h2>
    ${b.qr ? `<div class="pay-qr"><img class="qr" src="${b.qr}" alt="UPI QR code for ${esc(b.name)}"><span class="muted">Scan with any UPI app</span></div>` : ''}
    ${b.upi_id ? `<div class="kv"><div><span class="k">UPI ID</span><span class="v mono">${esc(b.upi_id)}</span></div>${copyBtn(b.upi_id)}</div>` : `<p class="muted">${esc(b.name)} has not added a UPI ID yet. Message them to ask how to pay.</p>`}
    <div class="kv"><div><span class="k">Amount</span><span class="v">${inr(toPay)}</span></div>${copyBtn(String(toPay / 100))}</div></div>
    <form method="post" action="/o/${tok}/paid" class="pay-part" id="paid"><h2>Already paid?</h2><p class="muted">Tell ${esc(b.name)} so they can check it and mark it paid.</p>${err}
    <label for="a">Amount you paid (₹)</label><input id="a" name="amount" type="number" inputmode="decimal" step="any" min="1" required value="${toPay / 100}">
    <label for="r">UPI reference number</label><input id="r" name="upi_ref" required minlength="6" maxlength="30" placeholder="e.g. 4082 7391 5526" autocomplete="off" aria-describedby="r-hint"><p class="muted" id="r-hint" style="margin:6px 0 0">The 12-digit number your payment app shows under the payment.</p>
    <button class="wide" style="margin-top:20px">I've paid</button></form>`;
  res.send(payShell(b,
    `<p class="pay-for">Hi ${first}, ${o.reported ? 'left to pay' : o.paid ? 'still to pay' : 'your total is'}</p>${bigAmount(toPay)}
    <p class="pay-note">Order #${o.number} · due ${when(o.due_date)}</p>${o.reported ? `<p class="pay-note">${icon('clock')}${inr(o.reported)} you sent is waiting to be confirmed</p>` : ''}
    ${b.upi_id ? `<a class="btn upi-app noprint" href="${esc(upiLink(b, o, toPay))}">${icon('phone')}Pay ${inr(toPay)} in a UPI app</a>` : ''}`,
    `${reportedNote ? `<div class="pay-part" role="status"><p style="margin:0">${reportedNote}</p></div>` : ''}${order}${pay}`));
}));
app.post('/o/:token/paid', h(async (req, res) => {
  const r = await core.getByPublicToken(req.params.token); if (!r) return res.sendStatus(404);
  const ref = String(req.body.upi_ref || '').replace(/\s+/g, '');
  try {
    if (!/^[A-Za-z0-9]{6,30}$/.test(ref)) throw new core.UserError('That UPI reference does not look right. Copy the 12-digit number from your payment app, letters and numbers only.');
    if (r.order.state === 'cancelled') throw new core.UserError('This order was cancelled, so there is nothing to pay.');
    await core.recordPayment(r.business.id, r.order.number, { amount: req.body.amount, upi_ref: ref }, 'reported');
    res.redirect(`/o/${req.params.token}?sent=1`);
  } catch (e) { if (e instanceof core.UserError) return res.redirect(`/o/${req.params.token}?err=${encodeURIComponent(e.message)}#paid`); throw e; }
}));
app.get('/o/:token/receipt', h(async (req, res) => {
  const r = await core.getByPublicToken(req.params.token);
  if (!r || r.order.pay !== 'paid') return res.redirect(`/o/${req.params.token}`);
  const { order: o, business: b } = r;
  const got = o.payments.filter(p => p.state === 'confirmed');
  const last = got.map(p => p.paid_on).sort().pop();
  res.send(page(`Receipt #${o.number} · ${b.name}`, `<main class="receipt"><div class="head"><div>${b.logo ? `<img class="logo" src="${b.logo}" alt="" style="margin-bottom:12px">` : ''}<h1>${esc(b.name)}</h1></div><span class="chip paid">Paid</span></div>
    <h2>Receipt for order #${o.number}</h2>
    <p class="muted">${esc(o.customer)} · due ${when(o.due_date)}<br>Paid in full${last ? ' on ' + when(last) : ''}</p>${itemsList(o)}
    <div style="margin-top:20px">${got.map(p => `<p class="muted" style="margin:2px 0">Received ${inr(p.amount_paise)} on ${when(p.paid_on)}${p.upi_ref ? ' · ref <span class="mono">' + esc(p.upi_ref) + '</span>' : ''}</p>`).join('')}</div>
    <div class="btns noprint" style="margin-top:28px"><button onclick="print()">${icon('print')}Print or save as PDF</button><a class="btn ghost" href="/o/${esc(req.params.token)}">Back to order</a></div></main>`, { bare: 'paybody' }));
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

app.use((err, req, res, next) => { console.error(err); res.status(500).send(page('Something went wrong', '<div class="sec empty" style="margin-top:40px"><h1>Something went wrong on our side</h1><p>Your last change may not have saved. Go back and try again. If it keeps happening, tell the person who set this up.</p><div class="btns"><a class="btn" href="/">Go to Today</a></div></div>')); });

if (!process.env.VERCEL) app.listen(process.env.PORT || 3000, () => console.log('Orderly on :' + (process.env.PORT || 3000)));
export default app;
