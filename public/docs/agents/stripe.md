# Stripe

Index: https://backenly.com/llms.txt · Integrations: https://backenly.com/docs/agents/integrations.md

## Connecting

```
integrations { action: "connect", integrationId: "stripe", apiKey: "sk_test_…", webhookSecret: "whsec_…" }
```

The secret key (`sk_test_…` or `sk_live_…`) is checked with Stripe before it is stored. The webhook signing secret cannot be checked by an API call, so it is stored as unverifiable.

Storing the key from an agent also creates a `stripe-checkout-session` function (invoke it at `POST /api/v1/{projectId}/fn/stripe-checkout-session`) and a `stripe-webhook` handler that fires on verified Stripe deliveries, and if an orders or payments table exists, it gains the `stripeSessionId` and `status` columns.

## Receiving events

Stripe events arrive at `https://backenly.com/api/v1/{projectId}/webhooks/stripe`. It checks the `Stripe-Signature` HMAC with a five-minute replay window, and rejects every event until the project's webhook signing secret is stored. Stripe has no API for creating a webhook on a merchant's behalf, so the human pastes that URL into the Stripe dashboard and gives Backenly the signing secret.

## What the receiver applies

Before any function triggered by the webhook runs, the receiver applies these events to the project's own tables. It writes only the columns a table has, casts each value to its column's type, and writes a status in a spelling the column's CHECK or enum lists.

- `checkout.session.completed`: the order whose `orders.stripe_session_id` (or `orders.stripeSessionId`) is the session's id is marked paid, in `orders.payment_status` when the table has it and in `orders.status` otherwise, and `orders.stripe_payment_intent_id` gets the payment intent's id where that column exists. A `payments` row with that session id is marked paid too.
- `payment_intent.succeeded`: the order or payment that carries the payment intent's id (`orders.stripe_payment_intent_id`, or `payments.stripe_payment_intent_id` or `payments.provider_payment_id`) is marked paid. A `metadata.credits_amount` with a `metadata.user_id` adds the credits to that user's `credit_wallets.balance`, or else records them in `credit_transactions.amount`. A paid order's items (`order_items.quantity`) come off `products.stock_quantity`, and its user gets a notification.
- `customer.subscription.updated` and `customer.subscription.deleted`: the row whose `subscriptions.stripe_subscription_id` (or `subscriptions.provider_subscription_id`) is the subscription's id gets Stripe's status, spelled as `subscriptions.status` allows (`cancelled` on a table made by `create_table`), and `subscriptions.current_period_start`, `subscriptions.current_period_end` and `subscriptions.cancel_at_period_end` where it has those columns. A deleted subscription's user gets a notification.
- `invoice.payment_failed` sets the invoice's subscription to past_due and notifies its user. `invoice.paid` sets a past_due subscription back to active.

A notification is a `notifications` row with `user_id`, the text in `body` or `message`, `title` and `type`. Events from Stripe API version 2025-03-31.basil on are read as well as older ones: a subscription's period from its items, and an invoice's subscription from `parent.subscription_details`.

A table that does not exist is passed over. When a table exists but cannot take the change (it has no column to find the row by or to hold the value, its CHECK lists no value for Stripe's, or the database refuses the write), the event is reported as not applied, with the reason, in three places: the console's Monitoring → Logs, the event's row in payment_events when that table exists (`payment_events.processed` is false and `payment_events.error` says why), and the reply Stripe shows for the event. An event whose id is already in payment_events is not applied again.

## In a function

`ctx.integrations.stripe`:

- `createCheckoutSession({ lineItems, successUrl, cancelUrl, mode?, customerId?, customerEmail?, metadata? })` → `{ id, url }`
- `createPaymentIntent(amountCents, currency, customerId?)` → `{ id, clientSecret, status }`
- `createCustomer(email, name?, metadata?)` → `{ id, email }`
- `refund(paymentIntentId, amountCents?)` → `{ id, status }`
- `cancelSubscription(subscriptionId)` → `{ id, status }`
- `listCustomers(email?)` → `[{ id, email, name }]`
- `retrievePaymentIntent(paymentIntentId)` → the payment intent
- `request(method, path, body?, headers?)`: any other Stripe endpoint, such as `request('POST', '/products', { name: 'Pro plan', metadata: { tier: 'pro' } })`. The body is form-encoded, as Stripe takes it: nested objects and lists become `metadata[tier]` and `items[0][price]`. A path is relative to `https://api.stripe.com/v1`, and `/v1/products`, as Stripe's docs write it, works too.

Subscription plans, a payment event log and the rest are built by asking for them.
