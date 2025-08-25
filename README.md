# hotmart-subscription-sync

**Supabase ↔ Hotmart integration** — syncs subscriptions, logs events, and verifies user access in your own database — **webhook-based**.

---

## Overview

This project wires **Hotmart webhooks** into **Supabase Edge Functions** and a minimal **Postgres schema** to keep subscription state in sync, log every incoming event, and expose a simple endpoint your app can call to gate access and read the user’s active plan.

### What it does

- **Receives Hotmart webhooks**:
  - `PURCHASE_APPROVED`
  - `PURCHASE_PROTEST`, `PURCHASE_CHARGEBACK`, `PURCHASE_DELAYED`
  - `SUBSCRIPTION_CANCELLATION`
- **Updates current state** in `public.subscriptions` (one row per buyer email).
- **Appends a full audit trail** to `public.subscription_events` (every webhook payload).
- **Verifies access** via an Edge Function `verify-subscription` (also links the Supabase Auth user ID to the subscription row).
- **Normalizes dates** coming from Hotmart (supports ms/seconds/ISO) and applies a **fallback** “same day next month” when a next charge date is missing.
- **Keeps your app simple**: the app only calls `verify-subscription` to decide **allow/deny** and read the **active plan** (`BASIC | PRO | VIP`).

---

## Tech Stack

- **Supabase** (Edge Functions, Postgres, Auth)
- **Deno** runtime for Edge Functions
- **TypeScript/JavaScript** for functions
- Hotmart **Webhooks**

---

## Repo structure

```
.
├─ README.md
├─ edge-functions/
│  ├─ hotmart-webhook-purchase-approved/
│  ├─ hotmart-webhook-purchase-invalid/        # handles PROTEST, CHARGEBACK, DELAYED
│  ├─ hotmart-webhook-subscription-cancellation/
│  └─ verify-subscription/
└─ database/
   ├─ db.sql                                   # schema: subscriptions + subscription_events + triggers
   └─ fn_subscription_access_by_email.sql      # SQL helper used by verify-subscription
```

---

## Database schema (summary)

### `public.subscriptions` — current state per buyer
- `buyer_email citext unique` — primary identity (case-insensitive)
- `subscriber_code text` — Hotmart `subscriber.code`
- `plan subscription_plan` — `BASIC | PRO | VIP`
- `status subscription_status` — `ACTIVE | INACTIVE`
- `date_next_charge timestamptz` — next renewal end/cutoff
- `cancel_pending boolean` — set by cancellation request
- Timestamps + `updated_at` trigger

### `public.subscription_events` — append-only audit log
- `subscription_id uuid` (FK → subscriptions.id)
- `event_id text` (Hotmart webhook id)
- `event_type text` (e.g., `PURCHASE_APPROVED`)
- `payload jsonb` (raw event body)
- `received_at timestamptz default now()`

> See `database/subscriptions.sql` for the full DDL and `subscription_access_by_email.sql` for the access helper used by `verify-subscription`.

---

## Edge Functions

### 1) `hotmart-webhook-purchase-approved`
- **On `PURCHASE_APPROVED`**:
  - Upserts `subscriptions` by `buyer_email`:
    - `status = ACTIVE`
    - `plan` parsed from product/plan name (`BASIC/PRO/VIP`)
    - `subscriber_code` from `data.subscription.subscriber.code`
    - `date_next_charge` from `data.purchase.date_next_charge` (ms/seconds/ISO), with **fallback to same day next month**.
    - `cancel_pending = false`
  - Inserts a log row in `subscription_events`.

### 2) `hotmart-webhook-purchase-invalid`
- **On `PURCHASE_PROTEST`, `PURCHASE_CHARGEBACK`, `PURCHASE_DELAYED`**:
  - Upserts `subscriptions` by `buyer_email` with `status = INACTIVE` (policy-driven; adjust if you want to treat `DELAYED` differently).
  - Logs the exact `event_type` in `subscription_events`.

### 3) `hotmart-webhook-subscription-cancellation`
- **On `SUBSCRIPTION_CANCELLATION`**:
  - Finds the row **by `subscriber_code`** (buyer email is not in the payload of this event).
  - Sets `cancel_pending = true`.
  - Sets `date_next_charge` from `data.date_next_charge` (root).
  - Logs the event in `subscription_events`.

### 4) `verify-subscription`
- Input: the **buyer email** (and uses the current Supabase Auth session to **sync `user_id`** onto the subscription row).
- Returns:
  - `hasActiveSubscription: boolean`
  - `plan: 'BASIC' | 'PRO' | 'VIP'` for UI gating
- Internally calls the SQL helper to:
  - Decide **access now** (e.g., respect `date_next_charge`, `status`, `cancel_pending`)
  - Perform housekeeping updates (e.g., flip to `INACTIVE` after end of cycle if applicable).

---

## Hotmart → Supabase event mapping

| Hotmart event               | Function                                      | Effect on `subscriptions`                                         | Logged? |
|----------------------------|-----------------------------------------------|-------------------------------------------------------------------|---------|
| `PURCHASE_APPROVED`        | `hotmart-webhook-purchase-approved`           | `status=ACTIVE`, set `plan`, `subscriber_code`, `date_next_charge` | ✅       |
| `PURCHASE_PROTEST`         | `hotmart-webhook-purchase-invalid`            | `status=INACTIVE`                                         | ✅       |
| `PURCHASE_CHARGEBACK`      | `hotmart-webhook-purchase-invalid`            | `status=INACTIVE`                                                 | ✅       |
| `PURCHASE_DELAYED`         | `hotmart-webhook-purchase-invalid`            | `status=INACTIVE`  | ✅       |
| `SUBSCRIPTION_CANCELLATION`| `hotmart-webhook-subscription-cancellation`   | `cancel_pending=true`, set `date_next_charge`                     | ✅       |

---

## Configuration

### Environment variables (Edge Function settings)
Set these for each Edge Function in the Supabase dashboard (Project Settings → Functions → Environment Variables):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

> The Service Role key is required server-side to perform privileged writes (webhook consumers). Do **not** expose it in clients.

### Hotmart webhooks
Point your Hotmart webhook endpoints to the public URL of each Edge Function, e.g.:

```
https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/hotmart-webhook-purchase-approved
https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/hotmart-webhook-purchase-invalid
https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/hotmart-webhook-subscription-cancellation
```

---

## Deploy & Run

Using the Supabase CLI:

```bash
# Login & link project
supabase login
supabase link --project-ref <YOUR-PROJECT-REF>

# Apply DB schema
psql "$SUPABASE_DB_URL" -f database/subscriptions.sql
psql "$SUPABASE_DB_URL" -f database/subscription_access_by_email.sql

# Deploy functions
supabase functions deploy hotmart-webhook-purchase-approved
supabase functions deploy hotmart-webhook-purchase-invalid
supabase functions deploy hotmart-webhook-subscription-cancellation
supabase functions deploy verify-subscription
```

> Ensure each function has its environment variables set in the dashboard before invoking.

---

## Testing (cURL)

**verify-subscription**
```bash
curl -X POST   "https://<REF>.supabase.co/functions/v1/verify-subscription"   -H "Authorization: Bearer <ANON-OR-USER-JWT>"   -H "Content-Type: application/json"   -d '{ "email": "alice@example.com" }'
# → { "hasActiveSubscription": true, "plan": "VIP" }
```

---
 