# Stripe

Index: https://backenly.com/llms.txt · Integrations: https://backenly.com/docs/agents/integrations.md

## Connecting

```
integrations { action: "connect", integrationId: "stripe", apiKey: "sk_test_…", webhookSecret: "whsec_…" }
```

The secret key (`sk_test_…` or `sk_live_…`) is checked with Stripe before it is stored. The webhook signing secret cannot be checked by an API call, so it is stored as unverifiable.

Storing the key from an agent also creates a `POST /checkout/session` function and a `stripe-webhook` handler, and if an orders or payments table exists, it gains the Stripe session and status columns.

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
- `request(method, path, body?, headers?)`: any other Stripe endpoint. Stripe's API is form-encoded and `request` sends JSON, so prefer the helpers above.

Subscription plans, a payment event log and the rest are built by asking for them.
