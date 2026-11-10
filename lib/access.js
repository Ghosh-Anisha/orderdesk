import crypto from 'node:crypto';
import { q } from './db.js';
import { page, esc, icon } from './ui.js';

// Who can do what. The owner can use every tool; each invited email gets the tools the owner ticked.
// The same names guard the web app, so a helper cannot do in the browser what Claude may not do for them.
export const TOOLS = [
  ['list_orders', 'See orders', 'Always on. Lists orders, what is due and who owes money.'],
  ['add_order', 'Add orders', 'Add one order at a time.'],
  ['import_orders', 'Import many orders', 'Bring in a whole sheet or chat history at once.'],
  ['update_order', 'Change orders', 'Edit names, dates, items and mark orders delivered or cancelled.'],
  ['record_payment', 'Record and confirm payments', 'Mark money as received and confirm what customers report.'],
];
export const TOOL_NAMES = TOOLS.map(t => t[0]);
export const toolLabel = n => TOOLS.find(t => t[0] === n)?.[1] || n;
export const can = (user, tool) => user.role === 'owner' || tool === 'list_orders' || (user.tools || []).includes(tool);
export const cleanTools = v => ['list_orders', ...TOOL_NAMES.filter(t => t !== 'list_orders' && [].concat(v || []).includes(t))];

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rand = () => crypto.randomBytes(32).toString('base64url');
export const baseUrl = req => `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`;
const ACCESS_SECS = 3600, REFRESH_DAYS = 90, CODE_SECS = 300;

// The person behind a Claude connection. Looked up on every call, so removing someone or changing
// their tools takes effect straight away.
export async function userForAccessToken(token) {
  if (!token) return null;
  const r = await q(`SELECT u.id, u.email, u.role, u.tools, b.id AS bid, b.name AS biz_name FROM oauth_tokens t
    JOIN users u ON u.id=t.user_id JOIN businesses b ON b.id=u.business_id
    WHERE t.token_hash=$1 AND t.kind='access' AND t.expires_at>now()`, [sha(token)]);
  return r.rows[0] || null;
}

async function issueTokens(clientId, userId) {
  const access = rand(), refresh = rand();
  await q(`INSERT INTO oauth_tokens (token_hash,kind,client_id,user_id,expires_at) VALUES
    ($1,'access',$3,$4,now()+make_interval(secs=>$5)), ($2,'refresh',$3,$4,now()+make_interval(days=>$6))`,
  [sha(access), sha(refresh), clientId, userId, ACCESS_SECS, REFRESH_DAYS]);
  await q("DELETE FROM oauth_tokens WHERE expires_at<now()");
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECS, refresh_token: refresh };
}

export const revokeUserTokens = userId => q('DELETE FROM oauth_tokens WHERE user_id=$1', [userId]);

export function mountAccess(app, { h, loadUser }) {
  const cors = (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', 'authorization, content-type, mcp-protocol-version'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); };
  const oauthErr = (res, status, error, error_description) => res.status(status).json({ error, error_description });

  // discovery: Claude reads these to find where to sign in
  const resourceMeta = (req, res) => res.json({ resource: `${baseUrl(req)}/mcp`, authorization_servers: [baseUrl(req)], bearer_methods_supported: ['header'], resource_name: 'Orderly' });
  app.all(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], cors, resourceMeta);
  const serverMeta = (req, res) => { const b = baseUrl(req); res.json({
    issuer: b, authorization_endpoint: `${b}/oauth/authorize`, token_endpoint: `${b}/oauth/token`, registration_endpoint: `${b}/oauth/register`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['orders'] }); };
  app.all(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], cors, serverMeta);

  // dynamic client registration (RFC 7591): Claude registers itself the first time
  app.all('/oauth/register', cors, h(async (req, res) => {
    if (req.method !== 'POST') return oauthErr(res, 405, 'invalid_request', 'Use POST.');
    const uris = req.body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(u => { try { const x = new URL(u); return x.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(x.hostname); } catch { return false; } }))
      return oauthErr(res, 400, 'invalid_redirect_uri', 'redirect_uris must be a list of https addresses.');
    const id = 'c_' + rand(), name = String(req.body.client_name || 'Claude').slice(0, 80);
    await q('INSERT INTO oauth_clients (id,name,redirect_uris) VALUES ($1,$2,$3)', [id, name, uris]);
    res.status(201).json({ client_id: id, client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(Date.now() / 1000) });
  }));

  // the sign-in and consent screen
  const readAuthz = async p => {
    const client = (await q('SELECT id,name,redirect_uris FROM oauth_clients WHERE id=$1', [String(p.client_id || '')])).rows[0];
    if (!client) return { fatal: 'This sign-in link is from an app Orderly does not know. Remove the connector in Claude and add it again.' };
    if (!client.redirect_uris.includes(p.redirect_uri)) return { fatal: 'This sign-in link points somewhere Orderly was not told about, so it was stopped. Add the connector in Claude again.' };
    const back = (params) => { const u = new URL(p.redirect_uri); for (const [k, v] of Object.entries({ ...params, state: p.state })) if (v) u.searchParams.set(k, v); return u.toString(); };
    if (p.response_type !== 'code') return { client, redirect: back({ error: 'unsupported_response_type' }) };
    if (!p.code_challenge || p.code_challenge_method !== 'S256') return { client, redirect: back({ error: 'invalid_request', error_description: 'PKCE with S256 is required.' }) };
    return { client, back };
  };
  const shell = (title, inner) => page(title, `<div class="auth"><p class="auth-brand">Orderly</p>${inner}</div>`);
  const keys = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];

  app.get('/oauth/authorize', h(async (req, res) => {
    res.set('X-Frame-Options', 'DENY'); res.set('Content-Security-Policy', "frame-ancestors 'none'");
    const a = await readAuthz(req.query);
    if (a.fatal) return res.status(400).send(shell('Cannot sign in', `<h1>Cannot connect Claude</h1><div class="err" role="alert">${esc(a.fatal)}</div>`));
    if (a.redirect) return res.redirect(a.redirect);
    const here = req.originalUrl;
    const user = await loadUser(req);
    if (!user) return res.redirect(`/login?next=${encodeURIComponent(here)}`);
    const hidden = keys.map(k => req.query[k] ? `<input type="hidden" name="${k}" value="${esc(req.query[k])}">` : '').join('');
    const yes = TOOLS.filter(t => can(user, t[0])), no = TOOLS.filter(t => !can(user, t[0]));
    const host = new URL(req.query.redirect_uri).host;
    res.send(shell('Connect Claude', `<h1>Connect ${esc(a.client.name)} to ${esc(user.biz_name)}?</h1>
      <p class="muted">You are signed in as <b>${esc(user.email)}</b>${user.role === 'owner' ? ' (owner)' : ''}. <a href="/logout?next=${encodeURIComponent(here)}">Not you?</a></p>
      <form method="post" action="/oauth/authorize" class="sec">${hidden}
      <h2>Claude will be able to</h2><ul class="perms">${yes.map(t => `<li>${icon('check')}<span><b>${t[1]}</b><br><span class="muted">${t[2]}</span></span></li>`).join('')}</ul>
      ${no.length ? `<h3 style="margin-top:16px">Not allowed for this email</h3><p class="muted">${no.map(t => t[1]).join(', ')}. The owner can change this in Settings → Team.</p>` : ''}
      <div class="formfoot"><button name="decision" value="allow">Allow</button><button name="decision" value="deny" class="ghost">Cancel</button></div>
      <p class="muted" style="margin:12px 0 0">You will be sent back to ${esc(host)}.</p></form>`));
  }));

  app.post('/oauth/authorize', h(async (req, res) => {
    const a = await readAuthz(req.body);
    if (a.fatal) return res.status(400).send(shell('Cannot sign in', `<h1>Cannot connect Claude</h1><div class="err" role="alert">${esc(a.fatal)}</div>`));
    if (a.redirect) return res.redirect(a.redirect);
    const user = await loadUser(req);
    if (!user) return res.redirect('/login');
    if (req.body.decision !== 'allow') return res.redirect(a.back({ error: 'access_denied', error_description: 'The person cancelled.' }));
    const code = rand();
    await q(`INSERT INTO oauth_codes (code_hash,client_id,user_id,redirect_uri,challenge,expires_at) VALUES ($1,$2,$3,$4,$5,now()+make_interval(secs=>$6))`,
      [sha(code), a.client.id, user.id, req.body.redirect_uri, req.body.code_challenge, CODE_SECS]);
    res.redirect(a.back({ code }));
  }));

  app.all('/oauth/token', cors, h(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') return oauthErr(res, 405, 'invalid_request', 'Use POST.');
    const b = req.body || {};
    if (b.grant_type === 'authorization_code') {
      const c = (await q('DELETE FROM oauth_codes WHERE code_hash=$1 RETURNING client_id,user_id,redirect_uri,challenge,expires_at', [sha(String(b.code || ''))])).rows[0];
      if (!c || c.expires_at < new Date()) return oauthErr(res, 400, 'invalid_grant', 'This sign-in code is wrong or expired. Connect again.');
      if (b.client_id && b.client_id !== c.client_id) return oauthErr(res, 400, 'invalid_grant', 'Code was issued to another client.');
      if (b.redirect_uri && b.redirect_uri !== c.redirect_uri) return oauthErr(res, 400, 'invalid_grant', 'redirect_uri does not match.');
      const verifier = String(b.code_verifier || '');
      if (crypto.createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return oauthErr(res, 400, 'invalid_grant', 'PKCE check failed.');
      return res.json(await issueTokens(c.client_id, c.user_id));
    }
    if (b.grant_type === 'refresh_token') {
      const t = (await q("DELETE FROM oauth_tokens WHERE token_hash=$1 AND kind='refresh' RETURNING client_id,user_id,expires_at", [sha(String(b.refresh_token || ''))])).rows[0];
      if (!t || t.expires_at < new Date()) return oauthErr(res, 400, 'invalid_grant', 'Signed out. Connect again.');
      return res.json(await issueTokens(t.client_id, t.user_id));
    }
    return oauthErr(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }));
}
