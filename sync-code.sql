-- Additive migration: leaves public.shidan_workspaces and its policies untouched.
begin;
create schema if not exists shidan_code_private;
revoke all on schema shidan_code_private from public, anon, authenticated;
create table if not exists shidan_code_private.workspaces (
  code_hash text primary key,
  payload jsonb,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
alter table shidan_code_private.workspaces enable row level security;
revoke all on shidan_code_private.workspaces from public, anon, authenticated;

create or replace function public.shidan_code_open(p_code text, p_create boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare h text; result jsonb;
begin
  if p_code is null or p_code !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023', message='INVALID_SYNC_CODE';
  end if;
  h := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_code, 'UTF8')), 'hex');
  if p_create then
    insert into shidan_code_private.workspaces(code_hash) values(h) on conflict do nothing;
  end if;
  select pg_catalog.jsonb_build_object('payload',w.payload,'revision',w.revision)
    into result from shidan_code_private.workspaces w where w.code_hash=h;
  if result is null then
    raise exception using errcode='P0002', message='SYNC_CODE_NOT_FOUND';
  end if;
  return result;
end $$;

create or replace function public.shidan_code_save(p_code text, p_payload jsonb, p_revision bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare h text; next_revision bigint;
begin
  if p_code is null or p_code !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023', message='INVALID_SYNC_CODE';
  end if;
  if p_revision is null or p_revision < 0 or p_payload is null
     or pg_catalog.jsonb_typeof(p_payload) <> 'object'
     or pg_catalog.octet_length(p_payload::text) > 5000000 then
    raise exception using errcode='22023', message='INVALID_WORKSPACE';
  end if;
  h := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_code, 'UTF8')), 'hex');
  update shidan_code_private.workspaces set payload=p_payload,
    revision=revision+1,updated_at=pg_catalog.now()
    where code_hash=h and revision=p_revision returning revision into next_revision;
  if next_revision is null then
    raise exception using errcode='40001', message='SYNC_CONFLICT';
  end if;
  return next_revision;
end $$;
revoke all on function public.shidan_code_open(text,boolean) from public;
revoke all on function public.shidan_code_save(text,jsonb,bigint) from public;
grant execute on function public.shidan_code_open(text,boolean) to anon,authenticated;
grant execute on function public.shidan_code_save(text,jsonb,bigint) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
