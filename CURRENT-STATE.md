# Resume here — 2026-10-21

Do not reread the conversation. Active source is this directory (Mineral-Murals-Hosted). Keep the separate Mineral-Murals local archive unchanged.

Latest user choice: Stripe is primary. Clean guest checkout, eligible Apple Pay/Google Pay/Link through Stripe, separate PayPal Business integration for PayPal/eligible US Venmo. User account/country clarification is pending. No real payment keys supplied; live payments are NOT enabled.

Implemented this turn:
- cloud/payments.js, drizzle/0002_payments.sql, checkout.html and assets/checkout.js.
- Owner setup in Seller Hub > Connections > Website payments. Encrypted merchant credentials; public API never exposes secrets.
- Authoritative prices, quantity-one atomic holds for live orders, signed Stripe webhook plus server reconciliation, server-side PayPal capture. Paid website orders atomically mark stock sold and enqueue linked Etsy/eBay removals. Test payments do not change real inventory.
- Guest checkout, saved basket, receipt token, cancellation and resume flow, correct pending/confirmed thank-you states, phone styling.
- Updated module bundler, migrations journal and asset cache handling.

Verification: 43 Node tests pass (12 core, 14 operations, 17 payments). Provider calls in payment tests are mocked; SQL uses actual temporary SQLite databases. Real Stripe/PayPal account checkout and wallet appearance are not verified without credentials. Browser verified the payment setup panel at 390x844. Native bridge tests from the prior session passed; not repeated for this payment-only change.

Hosting: existing owner-private Sites project appgprj_6ad7d175d9948191b4ff1e7a7b014083. Use .openai/hosting.json, preserve audience. At start of this turn latest version was 0 (not deployed). Check deployment result/version before any retry. Source helper owns commit/push/package. Never expose tool credentials. Old session secret values were not recoverable; runtime host keys remain configured, but migration bearer must be rotated before maintenance import.

Still requires launch work: configure real merchant accounts; confirm shipping and tax behavior; public webhook reachability before real payments; owner pin before public access; marketplace developer apps/authorization; configure unattended reconciliation. Private preview cannot receive Stripe webhooks from the internet. Live gate MM_PAYMENTS_LIVE must stay unset until an account-connected test and deliberate launch. Declaring tax reviewed does not calculate taxes.

Existing backend/museum/blue branding and photo magnifier are retained. Large photo assets are external R2 data, intentionally excluded from the small deployment artifact. Do not claim a source ZIP is a one-click Vercel deployment. Current app uses Cloudflare Workers/D1/R2 via Sites.

Preview: scripts/dev.mjs, http://127.0.0.1:8791, isolated data under ../../work/hosted-preview. It simulates local owner sign-in; production trusts Sites identity. Test fixtures/keys must never be migrated to business inventory or hosted production.

Hosted recovery completed: 48 records imported privately (unreviewed), 377 image objects uploaded to R2, 151,307,139 bytes. Owner first sign-in is still required; the live app remains owner-private. Version 1 deployed successfully at https://mineral-murals-seller-hub.orangepuppy9.chatgpt.site (source f4393f00994e012aff12a36a58c90c00d3e447fb). A final private redeployment follows to remove temporary migration access. Latest immutable deployment details are saved outside this source directory in ../Mineral-Murals-Deployment.json.

Screenshot checkout-desktop-test.png and checkout-mobile-test.png use an isolated synthetic test specimen in work/checkout-layout-qa and deliberately invalid preview keys. They verify layout only, not real wallets or merchant payments. These fixtures were never imported into hosted inventory.
