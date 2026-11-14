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
