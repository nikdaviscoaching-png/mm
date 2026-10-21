# Payments

Stripe is the primary provider. Customers choose **Buy now** or **Secure checkout**, review the exact pieces and shipping total, then continue to Stripe for card and eligible Apple Pay, Google Pay, Link and other enabled immediate payment methods. No Mineral Murals account is required. The normal Stripe-hosted page displays the relevant methods for that buyer, rather than a list of dead wallet buttons.

PayPal and eligible Venmo use a separate PayPal Business integration on the same checkout page. PayPal's supported v5 JavaScript SDK checks button eligibility. Venmo requires eligible US merchant/buyer accounts and USD. PayPal-through-Stripe is region-restricted; this app does not depend on Stripe's paid preview adapter.

## Owner setup

Open `/seller#connections`, then **Website payments · Stripe**. Start in Test mode. Save the Stripe test secret key and webhook signing secret in the private form, never in chat or source files. Enable desired methods in the Stripe Dashboard. Add PayPal sandbox client ID/secret if desired. Confirm the shipping rate and allowed destinations once.

This implementation does not add sales tax automatically. The owner must review the required tax behavior before enabling checkout. If tax collection is required, implement and test it before launch; checking the review box does not calculate taxes.

Register a Stripe webhook at `https://YOUR_PUBLIC_HOST/api/payments/stripe/webhook` for:
- checkout.session.completed
- checkout.session.expired
- checkout.session.async_payment_succeeded
- checkout.session.async_payment_failed

Private Sites are not publicly reachable by Stripe. Complete public host/owner security setup before registering a live endpoint. Use immediate card/wallet methods in the dashboard for prompt stock confirmation. Delayed payment methods keep inventory held until verified payment or an investigated failure.

Test mode never marks real specimens sold. Merchant credentials must match the chosen mode. Live checkout additionally requires runtime secret `MM_PAYMENTS_LIVE=true`; keep it unset until real account-connected testing and deliberate launch.

## Inventory and verification

Server-side prices override browser values. A live checkout reserves each quantity-one specimen atomically. A separate buyer cannot start another website checkout for the same held specimen. Stripe sessions expire after approximately 31 minutes; holds release only after Stripe confirms expiry or cancellation. PayPal can be canceled before capture; capture and cancellation use conditional state updates.

Signed Stripe notifications trigger server-to-server verification. PayPal captures run only on the server and are verified before fulfillment. A browser redirect alone never marks an order paid. Confirmed payments, sold stock, and linked marketplace removal jobs commit in one database transaction. Payment retries are idempotent. Cross-channel conflicts create `paid_needs_review` orders rather than overwriting the first sale; the owner must resolve them with the affected buyer. External marketplace removal remains eventual and needs connected accounts and processing.

Receipts require an unguessable token and expose no buyer address or email. Buyer details remain in authenticated Seller Hub orders. Original source images and credentials remain private. Payment processor fees apply; free hosting does not mean free payment processing.

Use **Check pending payments** to reconcile unfinished checkouts. Long-running unattended reconciliation still needs an actual configured schedule. A network failure during initial session creation deliberately retains stock until the original attempt can be recovered or the provider outcome investigated; do not manually remove holds without checking the provider.

## Validation

`node --test cloud/core.test.mjs cloud/operations.test.mjs cloud/payments.test.mjs`

43 tests pass. Payment tests use mocked provider responses and real SQLite statements, not a live merchant account. They cover authoritative totals, dynamic wallet parameters, test/live isolation, signatures, guest receipt privacy, duplicate checkout attempts, holds, cross-channel conflicts, encrypted credentials, PayPal capture and atomic sale/delist writes.

Official references:
- https://docs.stripe.com/payments/checkout/payment-methods
- https://docs.stripe.com/payments/paypal
- https://docs.stripe.com/events/manage-webhook-endpoints
- https://developer.paypal.com/sdk/js/v5/reference
- https://developer.paypal.com/v5/venmo/overview
