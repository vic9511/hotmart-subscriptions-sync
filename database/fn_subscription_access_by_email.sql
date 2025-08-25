-- Enforce rules:
-- #1 active  if status = 'ACTIVE'
-- #2 inactive if status = 'INACTIVE'
-- #3 inactive if status = 'ACTIVE' AND cancel_pending = true AND date_next_charge < now()
--    (and persist the change: status -> INACTIVE, cancel_pending -> false)

create or replace function public.subscription_access_by_email(p_email text)
returns table (
  has_access boolean,
  plan subscription_plan,
  status subscription_status,
  date_next_charge timestamptz,
  cancel_pending boolean,
  subscription_id uuid,
  user_id uuid
)
language sql
volatile                 -- performs UPDATE; cannot be STABLE
security definer         -- runs with the function owner's privileges
set search_path = public
as $$
  with tgt as (
    -- Target row (at most 1 due to the unique index on buyer_email)
    select id
    from public.subscriptions
    where buyer_email = p_email::citext
    limit 1
  ),
  upd as (
    -- Rule #3: if ACTIVE + cancel_pending + date_next_charge already passed => cut access and clear flag
    update public.subscriptions s
    set status = 'INACTIVE',
        cancel_pending = false
    from tgt
    where s.id = tgt.id
      and s.status = 'ACTIVE'
      and s.cancel_pending = true
      and s.date_next_charge is not null
      and s.date_next_charge < now()
    returning s.*
  ),
  src as (
    -- If we updated, use the updated row; otherwise, use the current row
    select * from upd
    union all
    select s.*
    from public.subscriptions s
    join tgt on s.id = tgt.id
    where not exists (select 1 from upd)
  )
  select
    -- After the potential update, this condition is enough:
    (s.status = 'ACTIVE') as has_access,  -- #1 and #2 are covered; #3 has been persisted above
    s.plan,
    s.status,
    s.date_next_charge,
    s.cancel_pending,
    s.id  as subscription_id,
    s.user_id
  from src s
  limit 1;
$$;
