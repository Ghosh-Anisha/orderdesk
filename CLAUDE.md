# Orderly: notes for Claude Code

Back office for home bakers who take orders in DMs and get paid on a personal UPI ID. The seller's own Claude talks to this app over MCP. **There must be no AI inside the app**: no AI SDKs, no AI keys, ever. This is a hard rule from the assignment.

## Layout
- `server.js`: all web routes (Today, Orders, Products, Recipes, Make list, Money, Settings), customer page, cron, MCP mount. Exports the Express app (Vercel runs it as one function).
- `lib/core.js`: all order and payment logic. `lib/mcp.js`: the Claude tools (orders, payments, recipes, expenses, profit, make list). `lib/access.js`: team permissions and Claude sign-in (OAuth). `lib/db.js`: Postgres + auto-created tables. `lib/ui.js`: shared HTML shell and CSS.
- `npm test` runs `test/e2e.mjs` with a real MCP client. Keep it green. Start with `DATABASE_URL=... npm start`, then `DATABASE_URL=... BASE=http://localhost:3000 npm test` (DATABASE_URL lets the test plant old-style data for the migration check; without it that part is skipped).

## Rules to keep
- Totals, balances, payment status, recipe costs and margins are computed, never stored.
- Costing goes through product_id. An item with no product or no recipe is "cost unknown", never zero.
- Order items keep the price they were sold at; catalogue changes never alter old orders.
- Customer-reported payments do not count until the seller confirms.
- Same UPI reference cannot be recorded twice per business.
- Every query filters by business id. Tool errors are plain English.
- Web pages and Claude tools call the same functions in `lib/core.js`; never duplicate the logic in a route.
- Permissions use the tool names (`can(user, tool)`) and guard both the MCP tools and the web routes. The owner can do everything.
- Vercel has no disk: images stay in the database.

## Design job (the next task): make it top notch
Sources to follow: Anthropic frontend-design skill, ui-ux-pro-max-skill, Impeccable (run `npx impeccable detect .` and fix what it flags).

Direction
- Fonts today: Bricolage Grotesque (headings) + Figtree (body). Keep or change on purpose, but not Inter.
- Palette today: berry #8A2646, pistachio, saffron on a cool grey-green. Avoid cream plus terracotta, purple gradients, near-black plus neon.
- Spend the boldness in one place: the customer pay page (`/o/<token>`). The amount due is the hero. Everything else stays quiet and disciplined.
- No cards inside cards, no icon tile above every heading, no all-caps eyebrow labels, no accenting one word in a headline, no gradient washes, no fade-in on every section.
- Motion only in response to an action (copy confirmed, payment confirmed, save flash). Respect `prefers-reduced-motion`.

Checklist before calling it done
- Check at 375, 768, 1024 and 1440px wide. No clipped chips or tables (the orders table is tight on a phone).
- Text contrast at least 4.5:1, visible keyboard focus, buttons at least 44px tall.
- Status is never colour alone (chips already carry words).
- Empty states say what to do next. Errors say what went wrong and how to fix it. Same word for the same action everywhere.
- SVG icons (Lucide or Heroicons) if icons are used, never emoji.
- Real screenshots of Today, Orders, Order detail, Settings and the customer page.
