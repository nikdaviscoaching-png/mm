# Mineral Murals — hosted storefront and Seller Hub

This is the saved hosted app, built on Cloudflare Workers, D1 and R2 through Sites. It is not a static ZIP that can be dropped into Vercel unchanged.

- Customers: `/`.
- Your editing side: `/seller` → sign in with the owner's ChatGPT account.
- Payment setup: `/seller#connections` → Website payments · Stripe.
- Resume development: read `CURRENT-STATE.md` first, without reopening the chat history.

The public storefront, collection museum, original blue branding and photograph magnifier are retained. Drafts, uploads, orders and inventory live in the cloud. Heavy video/RAW processing uses your paired private Mac worker; typed listings work without paid model inference. The separate Mac/local archive remains intact.

Stripe is primary; eligible card/wallet options appear at its secure guest checkout. Optional PayPal Business credentials enable PayPal and eligible US Venmo alongside Stripe. Payments are not live until real accounts, shipping/tax behavior, webhook reachability and deliberate live activation are complete. See `docs/PAYMENTS.md`.

Build: `node scripts/build-app.mjs`, then `node scripts/validate-artifact.mjs`.
Tests: `node --test cloud/core.test.mjs cloud/operations.test.mjs cloud/payments.test.mjs`.
Local preview: `node scripts/dev.mjs` (isolated local data, simulated owner).
Publish with the Sites source helper and the existing project in `.openai/hosting.json`; retain its current private audience. Apply all migrations in `drizzle/`.

Large photographs are separate R2 objects, not embedded in the build. Original provided archives are preserved separately. A small source/deployment package does not contain those full originals or merchant secrets. Etsy/eBay require their own developer applications, shop authorization and one-time listing defaults. Marketplace transaction fees still apply; unpaid/unknown orders do not mark stock sold. Sale removal jobs and conflicts are visible in the Hub. Unattended polling needs an actual configured schedule.
