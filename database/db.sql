-- Enable required extensions
create extension if not exists citext;     -- case-insensitive text type (great for emails)
create extension if not exists pgcrypto;   -- provides gen_random_uuid()

-- Domain enums (keep these narrow and explicit)
create type subscription_status as enum ('ACTIVE', 'INACTIVE');
create type subscription_plan   as enum ('BASIC', 'PRO', 'VIP');

-- Core table: one row per subscriber (matched by buyer_email)
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),                 -- internal PK
  
  user_id uuid references auth.users(id) on delete set null,     -- link to Supabase Auth (optional)
  buyer_email citext not null,                                   -- normalized, case-insensitive email
  subscriber_code text,                                          -- Hotmart subscriber code (optional)
  plan   subscription_plan   not null default 'BASIC',           -- BASIC / PRO / VIP
  status subscription_status not null default 'INACTIVE',        -- ACTIVE / INACTIVE

  date_next_charge timestamptz,                                  -- next charge date from Hotmart
  cancel_pending boolean not null default false,                 -- true after SUBSCRIPTION_CANCELLATION

  -- Timestamps
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure one subscription per email (adjust if you later support multiple products)
create unique index ux_subscriptions_email on public.subscriptions (buyer_email);

-- Common query accelerators
create index ix_subscriptions_status       on public.subscriptions (status);
create index ix_subscriptions_next_charge  on public.subscriptions (date_next_charge);

-- Helper: auto-maintain updated_at on every update
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists trg_subscriptions_updated_at on public.subscriptions;
create trigger trg_subscriptions_updated_at
before update on public.subscriptions
for each row
execute function public.set_updated_at();

-- Event log table: append-only history of webhook payloads
create table public.subscription_events (
  id uuid primary key default gen_random_uuid(),                 -- internal PK for the event row
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  event_id text,                                                 -- provider's event id (optional)
  event_type text not null,                                      -- e.g., PURCHASE_APPROVED, SUBSCRIPTION_CANCELLATION
  payload jsonb not null,                                        -- raw webhook payload
  received_at timestamptz not null default now()                 -- server receive time
);
