# Orderly

A back office for home bakers and made-to-order sellers who take orders in WhatsApp/Instagram DMs and get paid on a personal UPI ID.

**There is no AI in this app.** No AI keys, no AI libraries. The seller connects it to their own Claude over MCP. Claude reads their DMs, screenshots or sheets and calls five tools; the app stores, checks and shows the result.

- **Web app:** Today, Orders (click a name, date or status to edit), Order detail, Settings. Plain words, big buttons, works on a phone.
- **Customer page** `/o/<link>`: amount due, UPI QR and ID with copy buttons, "I've paid" form, printable receipt. No login.
- **Claude connector** `/mcp/<private link>`: `list_orders`, `add_order`, `update_order`, `record_payment`, `import_orders`.
- **Rules the app enforces:** same UPI reference cannot be counted twice; money a customer reports does not count until the seller confirms; totals and balances are computed, never typed; every business sees only its own data.

## Deploy (about 10 minutes)

1. Push this folder to a GitHub repo.
2. Vercel → **Add New → Project** → import the repo. Leave the defaults.
3. In the project: **Storage → Create Database → Neon (Postgres)** → connect it to the project. This sets `DATABASE_URL`. Tables are created automatically on first visit.
4. Redeploy once so the variable is picked up.
5. Optional: `RESEND_API_KEY` (and `MAIL_FROM`) for the 8 am IST reminder email, `CRON_SECRET` to lock the cron URL. Without them the app works; the reminder just skips.
6. Open the live URL → **Create account** → Settings → add UPI ID/QR.

## Connect Claude

Settings shows a private link like `https://<app>/mcp/<long random text>`.
In Claude: **Customize → Connectors → + → Add custom connector** → paste the link → **No sign in** → Add.
Then try: "Add an order for Priya, 2 boxes of 6 brownies at ₹620 each, due Saturday."
Free Claude plans allow one custom connector, which is enough.

## Run locally

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/orderly npm start   # http://localhost:3000
BASE=http://localhost:3000 npm test                                  # end-to-end test with a real MCP client
```

## Notes

- The private link is the key to a business's data (like an unlisted link). Settings has "Make a new link". OAuth sign-in is the proper next step.
- Images (logo, QR) are stored in the database, so nothing is written to disk.
- Later: recipes, ingredients, make-list, costing and margin, expenses.
