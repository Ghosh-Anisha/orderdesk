import pg from 'pg';

// dates stay as 'YYYY-MM-DD' strings, numerics/bigints become numbers
pg.types.setTypeParser(1082, v => v);
pg.types.setTypeParser(1700, v => parseFloat(v));
pg.types.setTypeParser(20, v => parseInt(v, 10));

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const local = !url || /localhost|127\.0\.0\.1/.test(url);

export const pool = new pg.Pool({
  connectionString: url,
  max: 3,
  idleTimeoutMillis: 10000,
  ssl: local ? false : { rejectUnauthorized: false },
});

export const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  upi_id TEXT NOT NULL DEFAULT '',
  logo TEXT,
  qr TEXT,
  mcp_token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  number INT NOT NULL,
  customer TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  due_date DATE NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  public_token TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','delivered','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, number)
);
CREATE INDEX IF NOT EXISTS orders_biz_due ON orders (business_id, due_date);
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qty NUMERIC NOT NULL CHECK (qty > 0),
  unit_paise INT NOT NULL CHECK (unit_paise >= 0)
);
CREATE INDEX IF NOT EXISTS items_order ON order_items (order_id);
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_paise INT NOT NULL CHECK (amount_paise > 0),
  paid_on DATE NOT NULL,
  upi_ref TEXT,
  state TEXT NOT NULL DEFAULT 'confirmed' CHECK (state IN ('reported','confirmed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pay_order ON payments (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS pay_ref_unique ON payments (business_id, upi_ref) WHERE upi_ref IS NOT NULL;
-- costing: what things cost to make. Money in paise, quantities in the ingredient's own unit.
CREATE TABLE IF NOT EXISTS ingredients (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('g','ml','piece')),
  pack_size NUMERIC NOT NULL CHECK (pack_size > 0),
  pack_price_paise INT NOT NULL CHECK (pack_price_paise >= 0),
  use_within_days_after_opening INT CHECK (use_within_days_after_opening > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ingredients_name ON ingredients (business_id, lower(name));
CREATE TABLE IF NOT EXISTS recipes (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  yield_qty NUMERIC NOT NULL CHECK (yield_qty > 0),
  packaging_paise INT NOT NULL DEFAULT 0 CHECK (packaging_paise >= 0),
  notes TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS recipes_name ON recipes (business_id, lower(name));
CREATE TABLE IF NOT EXISTS recipe_lines (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  recipe_id INT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id INT NOT NULL REFERENCES ingredients(id),
  qty NUMERIC NOT NULL CHECK (qty > 0),
  UNIQUE (recipe_id, ingredient_id)
);
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  category TEXT NOT NULL,
  amount_paise INT NOT NULL CHECK (amount_paise > 0),
  note TEXT NOT NULL DEFAULT '',
  is_estimate BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_biz_month ON expenses (business_id, month);
-- team: the owner invites emails and picks which Claude tools each one may use (NULL tools = all)
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE users ADD COLUMN IF NOT EXISTS tools TEXT[];
CREATE TABLE IF NOT EXISTS invites (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  tools TEXT[] NOT NULL,
  token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, email)
);
-- Claude sign-in (OAuth 2.1 with PKCE). Codes and tokens are stored as sha256 hashes.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_user ON oauth_tokens (user_id);
`;

let ready;
export function ensureSchema() {
  if (!ready) ready = pool.query(SCHEMA).catch(e => { ready = null; throw e; });
  return ready;
}
