# Orderly

A back office for home bakers and made-to-order sellers who take orders in WhatsApp/Instagram DMs and get paid on a personal UPI ID.

**There is no AI in this app.** No AI keys, no AI libraries. The seller connects it to their own Claude over MCP. Claude reads their DMs, screenshots, menus or sheets and calls Orderly's tools; the app stores, checks, calculates and shows the result.

## What's in it

**Web app** (plain words, big buttons, works on a phone)

| Page | What it does |
|---|---|
| **Today** | What's due in the next 7 days, who still owes money, and customer payments waiting for you to confirm. |
| **Orders** | Every order with status tabs (Open, Unpaid, Delivered, All), filters by due date (Overdue, Next 7 days, This month, Next month, or any From/To) and by customer name. Click a name, date or status to change it. |
| **Order detail** | Items, payments, the customer link to send on WhatsApp. Item names suggest products from the catalogue and fill in the price. |
| **Products** | The catalogue: names, prices, on sale or off. Edit in place, add one at a time, or upload a CSV price list with a preview before saving. |
| **Recipes** | Cost a piece and margin a piece for every product, worked out from ingredient pack prices. Open a recipe to edit its ingredients, yield and packaging. |
| **Make list** | For a date range: how much of each ingredient to buy, how many packs, and which perishables must be used within their opened shelf life, with the order dates they serve. |
| **Money** | Revenue, ingredient cost, overhead, margin and margin % for one month or any range of months (with This month, Last month, Last 3 months, This financial year, Last 12 months). Month-by-month trend, performance by product (with share of sales, and each product month by month), money collected vs still to collect, and the month's expenses. |
| **Settings** | Business name, UPI ID and QR, logo, connecting Claude, and the Team. |

**Customer page** `/o/<link>`: the amount due, UPI QR and ID with copy buttons, a "Pay in a UPI app" button on phones, an "I've paid" form, and a printable receipt once paid. No login.

**Claude connector** `/mcp`, with sign-in. Tools:

| Area | Tools |
|---|---|
| Orders and payments | `list_orders`, `add_order`, `update_order`, `record_payment`, `import_orders` |
| Products | `list_products`, `save_products` (up to 200 at once) |
| Recipes | `save_recipe`, `remove_recipe` |
| Money | `add_expense`, `remove_expense`, `profit_summary` (one month or a range) |
| Kitchen | `make_list` |

Things to say to Claude once connected:

- "Here is my menu" (with a photo or a price list) → products saved after a preview.
- "Add an order for Priya, 2 brownie boxes, due Saturday" → the catalogue price fills in.
- "Here's how I make the brownies: 100 g flour, 100 g butter, 2 eggs…" → Claude asks for pack sizes and prices, then saves the recipe.
- "Gas this month was about ₹730, a ₹1,100 cylinder lasts six weeks" → saved as an estimated expense with that note.
- "What do I need to buy for this weekend?" · "How did April to June go?"

## Rules the app enforces

- Totals, balances, payment status, recipe costs and margins are computed, never typed or stored.
- Money a customer reports does not count until the seller confirms it.
- The same UPI reference cannot be counted twice.
- An item given by name takes the catalogue price unless a price is given. Each order keeps the price it was sold at, so changing a price never changes old orders.
- An item that is not a product, or whose product has no recipe, shows "cost unknown", never zero, and the margin is flagged as too high.
- Overhead is each month's expenses, shared across that month's orders by revenue. A range of months is exactly the sum of its months. One expense per month and category: saving it again replaces it.
- Every business sees only its own data.

## Team and permissions

The owner invites emails in **Settings → Team** and ticks what each may do: add orders, import many orders, change orders, record and confirm payments, manage products and prices, manage recipes, add expenses, see profit and margins, see the make list. Seeing orders and products is always on.

The same permissions apply in the web app and through Claude: a teammate's Claude only lists the tools they are allowed, and the app hides pages and buttons they can't use. Changes take effect on their next request. Removing someone cuts off their Claude straight away.

## Deploy on Vercel (about 10 minutes)

1. Push this folder to a GitHub repo.
2. Vercel → **Add New → Project** → import the repo. Leave the defaults.
3. In the project: **Storage → Create Database → Neon (Postgres)** → connect it to all environments. This sets `DATABASE_URL`. Tables are created automatically on the first visit.
4. **Settings → Environment Variables**, for all environments:

   | Name | Needed? | Value |
   |---|---|---|
   | `SESSION_SECRET` | Yes | A long random string, e.g. from `openssl rand -hex 32`. Signs logins. Changing it logs everyone out once. |
   | `CRON_SECRET` | Recommended | Another random string. Vercel sends it to the daily reminder, so nobody else can trigger it. |
   | `RESEND_API_KEY` | Optional | For the 8 am IST reminder email. Without it the reminder just skips. |
   | `MAIL_FROM` | Optional | e.g. `Kudough <orders@yourdomain.com>`, with the domain verified in Resend. |

5. **Deployments → ⋯ → Redeploy** so the variables are picked up.
6. Open the production address → **Create account** → Settings → add your UPI ID and QR.

Every push to `main` redeploys. All requests go to the Express app through `api/index.js` (see `vercel.json`).

## Connect Claude

1. Settings → **Connect Claude** → copy the address, `https://<your-app>/mcp`. It is the same for everyone.
2. In Claude: **Settings → Connectors → Add custom connector** → paste it → **Add**. Leave sign-in on "Sign in now" and the client on "Register automatically".
3. Click **Connect**. An Orderly sign-in opens: log in, check the email and what Claude will be allowed to do, and press **Allow**.
4. Start a new chat and say "show my orders".

The address goes into Claude; **invite links** (`/join/…`) go into a browser, once, for a new teammate to set a password. Free Claude plans allow one custom connector, which is enough.

## Run locally

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/orderly npm start          # http://localhost:3000
DATABASE_URL=postgres://user:pass@localhost:5432/orderly \
  BASE=http://localhost:3000 npm test                                        # end-to-end test with a real MCP client
```

The test signs in like Claude does (OAuth + PKCE) and covers orders, payments, the catalogue, costing, ranges, filters, team permissions and tenant isolation. With `DATABASE_URL` set it also plants old-style data to check the product migration; without it that part is skipped.

## Code layout

- `server.js`: all web pages and routes, the customer page, the cron, and the MCP mount.
- `lib/core.js`: all order, payment, catalogue, costing and expense logic. Web pages and Claude tools call the same functions.
- `lib/mcp.js`: the Claude tools. `lib/access.js`: Claude sign-in (OAuth) and team permissions.
- `lib/db.js`: Postgres and the auto-created tables. `lib/ui.js`: shared page shell, styles and icons.

## Notes

- Sign-in is OAuth 2.1 with PKCE and dynamic client registration, built into the app. Tokens are stored hashed; access tokens last an hour, refresh tokens 90 days.
- The old `/mcp/<private link>` addresses are switched off and answer with a message telling people to add `/mcp` and sign in.
- When a business first signs in after the catalogue was added, its existing recipes and order item names become products (priced at their latest sale) and are linked, once.
- Images (logo, QR) are stored in the database, so nothing is written to disk.
