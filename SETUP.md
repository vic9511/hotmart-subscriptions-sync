# Setup Guide

Follow these steps to configure Supabase, deploy the Edge Functions, connect Hotmart webhooks, and test the end‑to‑end flow.

---

## 1) Create a Supabase project

- Sign in to Supabase and create a new project.

---

## 2) Apply the database schema and helper

Use the Supabase SQL Editor to run the provided SQL files in this order:

1. `database/db.sql`
2. `database/fn_subscription_access_by_email.sql`

This creates the `subscriptions` current‑state table, the `subscription_events` audit log, and the SQL helper used by the verification function.

---

## 3) Create Edge Functions

Create four Edge Functions with the following names and sources from the `edge-functions/` directory:

- `hotmart-webhook-purchase-approved`
- `hotmart-webhook-purchase-invalid`
- `hotmart-webhook-subscription-cancellation`
- `verify-subscription`

Settings per function:

- For the three Hotmart webhook consumers (`hotmart-webhook-*`):
    - Disable “Verify JWT with legacy secret” (these endpoints must accept unauthenticated requests from Hotmart).
- For `verify-subscription`:
    - Keep “Verify JWT with legacy secret” enabled (only your app should call it).

Environment variables (set in Project → Edge Functions → Secrets):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (required for the webhook consumers to perform privileged writes)

Deploy each function from the dashboard or using the Supabase CLI.

---

## 4) Create a Hotmart product (Subscription)

- In Hotmart, create your product in Subscription mode and configure its plans as needed.
- This implementation supports the following plans (make sure you use the exact plan name in hotmart):
    - BASIC
    - PRO
    - VIP

---

## 5) Configure Hotmart webhooks for the product

Point each event to the corresponding Supabase Edge Function URL, for example:

```
https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/hotmart-webhook-purchase-approved
https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/hotmart-webhook-purchase-invalid
https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/hotmart-webhook-subscription-cancellation
```

Map events as follows:

- Purchase Approved → `hotmart-webhook-purchase-approved`
- Purchase Protest → `hotmart-webhook-purchase-invalid`
- Purchase Chargeback → `hotmart-webhook-purchase-invalid`
- Purchase Delayed → `hotmart-webhook-purchase-invalid`
- Subscription Cancellation → `hotmart-webhook-subscription-cancellation`

---

## 6) Test the integration

Use Hotmart’s webhook tester to send sample events to your endpoints. Start with a “Purchase Approved” event and verify a new subscription row appears in your database:

- Hotmart Webhook Tester: [app.hotmart.com/tools/webhook](https://app.hotmart.com/tools/webhook/)

Send test events for each configured webhook to ensure the audit log and current state update correctly.

---

## 7) Integrate in your application

From your application, call the `verify-subscription` Edge Function to determine whether a user has an active subscription and to read the plan information (`BASIC | PRO | VIP`).

You can use a simple HTTP POST with the user’s email in the JSON body and an authenticated JWT in the `Authorization` header.

---

That’s it. Your Supabase database will stay in sync with Hotmart events, and your app can use the verification endpoint to gate access and read plan details.
