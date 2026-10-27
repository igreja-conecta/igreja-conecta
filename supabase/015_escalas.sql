-- =====================================================================
-- Igreja Conecta — ministérios e escalas (Fase 2)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - A liderança (administrador, secretaria e líderes) cria os ministérios e
--   escolhe quem lidera cada um (qualquer pessoa do cadastro)
-- - O líder do ministério põe e tira pessoas da equipe e monta as escalas
--   (data, horário e a função de cada pessoa)
-- - O voluntário confirma ou pede troca; o líder recebe o pedido de troca
-- - Avisos na central e no celular: "você foi escalado" e lembrete na véspera
-- - Os membros veem o nome e a descrição dos ministérios; a equipe e as
--   escalas, só quem é do ministério (e a liderança)
-- - O ministério marcado "Recebe os avisos de visitantes" (ex.: Acolhimento)
--   recebe o aviso de cada visitante e acompanha os cadastros. Sem ele, o
--   aviso continua indo para a liderança.
--
-- Os lembretes saem pelo envio de 10 em 10 minutos (scripts/enviar-lembretes.mjs).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Funcionalidade e tipo de notificação
-- ---------------------------------------------------------------------
create or replace function public.ministries_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'escalas')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.ministries_on(uuid) from public, anon;
grant execute on function public.ministries_on(uuid) to authenticated;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'oracao', 'visitante',
                  'devocional', 'leitura', 'escala'));

-- ---------------------------------------------------------------------
-- 2. Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.ministries (
  id                uuid primary key default gen_random_uuid(),
  church_id         uuid not null references public.churches on delete cascade,
  name              text not null check (char_length(name) between 2 and 60),
  description       text check (char_length(description) <= 500),
  receives_visitors boolean not null default false,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists ministries_church_idx on public.ministries (church_id, name);
-- Só um ministério por igreja recebe os avisos de visitantes.
create unique index if not exists ministries_visitors_idx on public.ministries (church_id) where receives_visitors;

create table if not exists public.ministry_members (
  ministry_id uuid not null references public.ministries on delete cascade,
  member_id   uuid not null references public.members on delete cascade,
  role        text not null default 'membro' check (role in ('lider', 'membro')),
  added_at    timestamptz not null default now(),
  primary key (ministry_id, member_id)
);
create index if not exists ministry_members_member_idx on public.ministry_members (member_id);

create table if not exists public.schedules (
  id           uuid primary key default gen_random_uuid(),
  ministry_id  uuid not null references public.ministries on delete cascade,
  service_date date not null,
  service_time time,
  title        text check (char_length(title) <= 80),
  notes        text check (char_length(notes) <= 500),
  created_by   uuid default auth.uid() references auth.users on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists schedules_ministry_idx on public.schedules (ministry_id, service_date);
create index if not exists schedules_date_idx on public.schedules (service_date);

-- Uma linha por pessoa escalada.
create table if not exists public.schedule_slots (
  id          uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.schedules on delete cascade,
  member_id   uuid not null references public.members on delete cascade,
  task        text check (char_length(task) <= 40),
  status      text not null default 'pendente' check (status in ('pendente', 'confirmado', 'troca')),
  swap_reason text check (char_length(swap_reason) <= 200),
  answered_at timestamptz,
  reminded_at timestamptz,
  unique (schedule_id, member_id)
);
create index if not exists schedule_slots_member_idx on public.schedule_slots (member_id);

-- ---------------------------------------------------------------------
-- 3. Funções das regras de acesso
-- ---------------------------------------------------------------------
-- Ministérios de que a pessoa faz parte (p_lead: só os que ela lidera).
create or replace function public.my_ministry_ids(p_lead boolean default false)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select mm.ministry_id
  from public.ministry_members mm
  join public.members m on m.id = mm.member_id
  join public.ministries mi on mi.id = mm.ministry_id
  where m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
    and m.church_id = mi.church_id and mi.active
    and public.ministries_on(mi.church_id)
    and (not p_lead or mm.role = 'lider')
$$;

-- Pode cuidar do ministério: a liderança da igreja ou quem lidera o ministério.
create or replace function public.can_manage_ministry(p_ministry uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.ministries mi
                 where mi.id = p_ministry and public.is_leader(mi.church_id) and public.ministries_on(mi.church_id))
      or p_ministry in (select public.my_ministry_ids(true))
$$;

-- Escalas em que a pessoa está (mesmo que tenha saído da equipe depois).
create or replace function public.my_schedule_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select sl.schedule_id
  from public.schedule_slots sl
  join public.members m on m.id = sl.member_id
  where m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
    and public.ministries_on(m.church_id)
$$;

-- Pode ver a escala: quem cuida do ministério, a equipe e quem está nela.
create or replace function public.can_see_schedule(p_schedule uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.schedules s
    where s.id = p_schedule
      and (public.can_manage_ministry(s.ministry_id) or s.ministry_id in (select public.my_ministry_ids()))
  ) or p_schedule in (select public.my_schedule_ids())
$$;

revoke execute on function public.my_ministry_ids(boolean) from public, anon;
revoke execute on function public.can_manage_ministry(uuid) from public, anon;
revoke execute on function public.my_schedule_ids() from public, anon;
revoke execute on function public.can_see_schedule(uuid) from public, anon;
grant execute on function public.my_ministry_ids(boolean) to authenticated;
grant execute on function public.can_manage_ministry(uuid) to authenticated;
grant execute on function public.my_schedule_ids() to authenticated;
grant execute on function public.can_see_schedule(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Regras de acesso
-- ---------------------------------------------------------------------
-- Ministérios: todos os membros veem os ativos; a liderança cria, edita e apaga.
alter table public.ministries enable row level security;
drop policy if exists "ministerios le" on public.ministries;
create policy "ministerios le" on public.ministries for select to authenticated
  using (public.ministries_on(church_id)
         and ((church_id in (select public.my_church_ids()) and active)
              or church_id in (select public.my_church_ids('lideranca'))));
drop policy if exists "ministerios lideranca cria" on public.ministries;
create policy "ministerios lideranca cria" on public.ministries for insert to authenticated
  with check (church_id in (select public.my_church_ids('lideranca')) and public.ministries_on(church_id));
drop policy if exists "ministerios lideranca edita" on public.ministries;
create policy "ministerios lideranca edita" on public.ministries for update to authenticated
  using (church_id in (select public.my_church_ids('lideranca')))
  with check (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "ministerios lideranca apaga" on public.ministries;
create policy "ministerios lideranca apaga" on public.ministries for delete to authenticated
  using (church_id in (select public.my_church_ids('lideranca')));
revoke all on public.ministries from anon;
revoke update on public.ministries from authenticated;
grant update (name, description, receives_visitors, active, updated_at) on public.ministries to authenticated;

-- Equipe: a liderança cuida de tudo; o líder do ministério põe e tira pessoas
-- (quem é líder do ministério, só a liderança escolhe).
alter table public.ministry_members enable row level security;
drop policy if exists "ministerio equipe le" on public.ministry_members;
create policy "ministerio equipe le" on public.ministry_members for select to authenticated
  using (ministry_id in (select mi.id from public.ministries mi where mi.church_id in (select public.my_church_ids('lideranca')))
         or ministry_id in (select public.my_ministry_ids()));
drop policy if exists "ministerio equipe coloca" on public.ministry_members;
create policy "ministerio equipe coloca" on public.ministry_members for insert to authenticated
  with check (public.can_manage_ministry(ministry_id));
drop policy if exists "ministerio equipe muda" on public.ministry_members;
create policy "ministerio equipe muda" on public.ministry_members for update to authenticated
  using (ministry_id in (select mi.id from public.ministries mi where mi.church_id in (select public.my_church_ids('lideranca'))))
  with check (ministry_id in (select mi.id from public.ministries mi where mi.church_id in (select public.my_church_ids('lideranca'))));
drop policy if exists "ministerio equipe tira" on public.ministry_members;
create policy "ministerio equipe tira" on public.ministry_members for delete to authenticated
  using (public.can_manage_ministry(ministry_id)
         and (role = 'membro' or ministry_id in (select mi.id from public.ministries mi where mi.church_id in (select public.my_church_ids('lideranca')))));
revoke all on public.ministry_members from anon;
revoke update on public.ministry_members from authenticated;
grant update (role) on public.ministry_members to authenticated;

-- security definer: o líder do ministério (membro comum) não lê o cadastro dos outros, mas a
-- conferência da igreja precisa ler.
create or replace function public.ministry_members_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.ministries mi join public.members m on m.church_id = mi.church_id
    where mi.id = new.ministry_id and m.id = new.member_id
  ) then
    raise exception 'A pessoa precisa ser do cadastro da mesma igreja.' using errcode = '42501';
  end if;
  if auth.uid() is not null and new.role <> 'membro'
     and not exists (select 1 from public.ministries mi where mi.id = new.ministry_id and public.is_leader(mi.church_id)) then
    raise exception 'Só a liderança da igreja escolhe o líder do ministério.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists ministry_members_guard on public.ministry_members;
create trigger ministry_members_guard before insert or update on public.ministry_members
  for each row execute function public.ministry_members_guard();
revoke execute on function public.ministry_members_guard() from public, anon, authenticated;

-- Quem sai da equipe sai também das escalas que ainda não aconteceram.
create or replace function public.ministry_members_left()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.schedule_slots sl using public.schedules s
   where sl.schedule_id = s.id and s.ministry_id = old.ministry_id and sl.member_id = old.member_id
     and s.service_date >= public.today_br();
  return old;
end $$;
drop trigger if exists ministry_members_left on public.ministry_members;
create trigger ministry_members_left after delete on public.ministry_members
  for each row execute function public.ministry_members_left();
revoke execute on function public.ministry_members_left() from public, anon, authenticated;

-- Escalas: quem cuida do ministério apaga; criar e mudar, só por save_schedule.
alter table public.schedules enable row level security;
drop policy if exists "escalas le" on public.schedules;
create policy "escalas le" on public.schedules for select to authenticated
  using (public.can_see_schedule(id));
drop policy if exists "escalas apaga" on public.schedules;
create policy "escalas apaga" on public.schedules for delete to authenticated
  using (public.can_manage_ministry(ministry_id));
revoke all on public.schedules from anon;
revoke insert, update on public.schedules from authenticated;

-- Pessoas da escala: gravadas só por save_schedule e schedule_answer.
alter table public.schedule_slots enable row level security;
drop policy if exists "escalados le" on public.schedule_slots;
create policy "escalados le" on public.schedule_slots for select to authenticated
  using (public.can_see_schedule(schedule_id));
revoke all on public.schedule_slots from anon;
revoke insert, update, delete on public.schedule_slots from authenticated;

-- ---------------------------------------------------------------------
-- 5. Funções das telas
-- ---------------------------------------------------------------------
-- Ministérios da igreja. Líderes, tamanho da equipe, próxima escala e pedidos de troca:
-- só para quem é do ministério ou cuida dele.
create or replace function public.ministry_overview(p_church uuid)
returns table (id uuid, name text, description text, receives_visitors boolean, active boolean,
               my_role text, manage boolean, leaders text, team integer, next_date date, swaps integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_leader boolean := public.is_leader(p_church);
begin
  if not public.ministries_on(p_church) or p_church not in (select public.my_church_ids()) then
    return;
  end if;
  return query
  with mine as (
    select mm.ministry_id, mm.role
    from public.ministry_members mm join public.members m on m.id = mm.member_id
    where m.user_id = auth.uid() and m.church_id = p_church and m.status = 'ativo'
  )
  select mi.id, mi.name, mi.description, mi.receives_visitors, mi.active,
         mine.role,
         coalesce(v_leader or mine.role = 'lider', false),
         case when v_leader or mine.role is not null then (
           select string_agg(m.name, ', ' order by m.name)
           from public.ministry_members mm join public.members m on m.id = mm.member_id
           where mm.ministry_id = mi.id and mm.role = 'lider' and m.status = 'ativo') end,
         case when v_leader or mine.role is not null then (
           select count(*)::integer
           from public.ministry_members mm join public.members m on m.id = mm.member_id
           where mm.ministry_id = mi.id and m.status = 'ativo') end,
         case when v_leader or mine.role is not null then (
           select min(s.service_date) from public.schedules s
           where s.ministry_id = mi.id and s.service_date >= public.today_br()) end,
         case when v_leader or mine.role = 'lider' then (
           select count(*)::integer from public.schedule_slots sl join public.schedules s on s.id = sl.schedule_id
           where s.ministry_id = mi.id and sl.status = 'troca' and s.service_date >= public.today_br()) end
  from public.ministries mi
  left join mine on mine.ministry_id = mi.id
  where mi.church_id = p_church and (mi.active or v_leader)
  order by mi.active desc, mi.name;
end $$;

-- Equipe do ministério. Telefone: para quem cuida do ministério, ou de quem autorizou.
create or replace function public.ministry_roster(p_ministry uuid)
returns table (member_id uuid, name text, photo_path text, phone text, role text, is_me boolean, has_account boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_manage boolean := public.can_manage_ministry(p_ministry);
begin
  if not v_manage and p_ministry not in (select public.my_ministry_ids()) then
    return;
  end if;
  return query
  select m.id, m.name, m.photo_path,
         case when v_manage or m.show_phone or m.user_id = auth.uid() then m.phone end,
         mm.role, coalesce(m.user_id = auth.uid(), false),
         m.user_id is not null and m.consent_at is not null
  from public.ministry_members mm
  join public.members m on m.id = mm.member_id
  where mm.ministry_id = p_ministry and m.status = 'ativo'
  order by case mm.role when 'lider' then 0 else 1 end, m.name;
end $$;

-- Pessoas do cadastro que podem entrar na equipe (só o nome), para quem cuida do ministério.
create or replace function public.ministry_candidates(p_ministry uuid, p_search text)
returns table (member_id uuid, name text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.can_manage_ministry(p_ministry) or char_length(trim(coalesce(p_search, ''))) < 2 then
    return;
  end if;
  return query
  select m.id, m.name
  from public.members m
  join public.ministries mi on mi.id = p_ministry and mi.church_id = m.church_id
  where m.status = 'ativo'
    and public.unaccent_lower(m.name) like '%' || public.unaccent_lower(trim(p_search)) || '%'
    and not exists (select 1 from public.ministry_members mm where mm.ministry_id = p_ministry and mm.member_id = m.id)
  order by m.name
  limit 20;
end $$;

-- Escalas do ministério (dos últimos 30 dias em diante), com as pessoas de cada uma.
-- Quem não é da equipe vê só as escalas em que está. O motivo da troca: só para quem cuida
-- do ministério e para a própria pessoa.
create or replace function public.ministry_schedules(p_ministry uuid)
returns table (id uuid, service_date date, service_time time, title text, notes text, slots jsonb)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_manage boolean := public.can_manage_ministry(p_ministry);
  v_team boolean := v_manage or p_ministry in (select public.my_ministry_ids());
begin
  return query
  select s.id, s.service_date, s.service_time, s.title, s.notes,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'id', sl.id, 'member_id', m.id, 'name', m.name, 'task', sl.task, 'status', sl.status,
                    'swap_reason', case when v_manage or m.user_id = auth.uid() then sl.swap_reason end,
                    'is_me', coalesce(m.user_id = auth.uid(), false),
                    'has_account', m.user_id is not null and m.consent_at is not null)
                  order by sl.task nulls last, m.name)
           from public.schedule_slots sl join public.members m on m.id = sl.member_id
           where sl.schedule_id = s.id), '[]'::jsonb)
  from public.schedules s
  join public.ministries mi on mi.id = s.ministry_id
  where s.ministry_id = p_ministry and public.ministries_on(mi.church_id)
    and s.service_date >= public.today_br() - 30
    and (v_team or s.id in (select public.my_schedule_ids()))
  order by s.service_date, s.service_time nulls first
  limit 80;
end $$;

-- As minhas escalas de hoje em diante, em todos os ministérios da igreja.
create or replace function public.my_schedules(p_church uuid)
returns table (slot_id uuid, schedule_id uuid, ministry_id uuid, ministry_name text, service_date date,
               service_time time, title text, task text, status text, swap_reason text)
language sql stable security definer set search_path = '' as $$
  select sl.id, s.id, mi.id, mi.name, s.service_date, s.service_time, s.title, sl.task, sl.status, sl.swap_reason
  from public.schedule_slots sl
  join public.members m on m.id = sl.member_id
  join public.schedules s on s.id = sl.schedule_id
  join public.ministries mi on mi.id = s.ministry_id
  where m.user_id = auth.uid() and m.church_id = p_church and m.status = 'ativo' and m.consent_at is not null
    and mi.church_id = p_church and mi.active and public.ministries_on(p_church)
    and s.service_date >= public.today_br()
  order by s.service_date, s.service_time nulls first
  limit 30
$$;

-- "8/11 às 19h" (ou só a data, sem horário).
create or replace function public.schedule_when(p_date date, p_time time)
returns text language sql immutable set search_path = '' as $$
  select to_char(p_date, 'FMDD/MM')
         || case when p_time is null then ''
                 when extract(minute from p_time) = 0 then ' às ' || extract(hour from p_time)::integer || 'h'
                 else ' às ' || to_char(p_time, 'FMHH24"h"MI') end
$$;

-- Cria ou corrige a escala com as pessoas de uma vez. p_slots: [{"member_id": ..., "task": ...}].
-- Só entra quem é da equipe. Quem entrou recebe "Você foi escalado"; se a data ou o horário
-- mudarem, todos voltam a "pendente" e recebem o aviso da mudança.
create or replace function public.save_schedule(p_ministry uuid, p_id uuid, p_date date, p_time time,
                                                p_title text, p_notes text, p_slots jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_id;
  v_church uuid;
  v_ministry text;
  v_old public.schedules;
  v_moved boolean := false;
  v_before uuid[] := '{}';
begin
  if not public.can_manage_ministry(p_ministry) then
    raise exception 'Só o líder do ministério e a liderança montam as escalas.' using errcode = '42501';
  end if;
  select mi.church_id, mi.name into v_church, v_ministry from public.ministries mi where mi.id = p_ministry;
  if p_date is null or p_date < public.today_br() - 30 or p_date > public.today_br() + 366 then
    raise exception 'Data da escala inválida.';
  end if;
  if jsonb_typeof(coalesce(p_slots, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_slots, '[]'::jsonb)) > 40 then
    raise exception 'Escala com gente demais (no máximo 40 pessoas).';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) x
    where not exists (select 1 from public.ministry_members mm join public.members m on m.id = mm.member_id
                      where mm.ministry_id = p_ministry and m.status = 'ativo'
                        and mm.member_id::text = x->>'member_id')
  ) then
    raise exception 'Só dá para escalar quem é da equipe do ministério.' using errcode = '42501';
  end if;

  if v_id is null then
    insert into public.schedules (ministry_id, service_date, service_time, title, notes)
    values (p_ministry, p_date, p_time, nullif(trim(p_title), ''), nullif(trim(p_notes), ''))
    returning id into v_id;
  else
    select * into v_old from public.schedules where id = v_id and ministry_id = p_ministry;
    if v_old.id is null then
      raise exception 'Escala não encontrada.' using errcode = '42501';
    end if;
    v_moved := v_old.service_date <> p_date or v_old.service_time is distinct from p_time;
    update public.schedules
       set service_date = p_date, service_time = p_time, title = nullif(trim(p_title), ''),
           notes = nullif(trim(p_notes), ''), updated_at = now()
     where id = v_id;
    select coalesce(array_agg(sl.member_id), '{}') into v_before from public.schedule_slots sl where sl.schedule_id = v_id;
  end if;

  delete from public.schedule_slots sl
   where sl.schedule_id = v_id
     and sl.member_id::text not in (select x->>'member_id' from jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) x);
  insert into public.schedule_slots (schedule_id, member_id, task)
  select distinct on (x->>'member_id') v_id, (x->>'member_id')::uuid, nullif(trim(left(x->>'task', 40)), '')
  from jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) x
  on conflict (schedule_id, member_id) do update set task = excluded.task;
  if v_moved then
    update public.schedule_slots
       set status = 'pendente', swap_reason = null, answered_at = null, reminded_at = null
     where schedule_id = v_id;
  end if;

  -- Avisos (só de hoje em diante, e não para quem está montando a escala).
  if p_date >= public.today_br() then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    select m.user_id, v_church, 'escala',
           case when sl.member_id = any (v_before) then 'Escala mudou: ' || v_ministry
                else 'Você foi escalado: ' || v_ministry end,
           concat_ws(' · ', public.schedule_when(p_date, p_time), sl.task, nullif(trim(p_title), '')),
           '#/escalas', 'escala:' || sl.id || ':' || (extract(epoch from clock_timestamp()) * 1000)::bigint, true
    from public.schedule_slots sl
    join public.members m on m.id = sl.member_id
    where sl.schedule_id = v_id
      and (not (sl.member_id = any (v_before)) or v_moved)
      and m.user_id is not null and m.user_id <> auth.uid() and m.status = 'ativo' and m.consent_at is not null
    on conflict do nothing;
  end if;
  return v_id;
end $$;

-- O voluntário responde a própria escala: confirma ou pede troca (o líder recebe o pedido).
create or replace function public.schedule_answer(p_slot uuid, p_confirm boolean, p_reason text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v record;
  v_status text := case when p_confirm then 'confirmado' else 'troca' end;
begin
  select sl.id, sl.status, m.name, s.service_date, s.service_time, mi.id as ministry_id, mi.name as ministry, mi.church_id
    into v
  from public.schedule_slots sl
  join public.members m on m.id = sl.member_id
  join public.schedules s on s.id = sl.schedule_id
  join public.ministries mi on mi.id = s.ministry_id
  where sl.id = p_slot and m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
    and public.ministries_on(mi.church_id);
  if v.id is null then
    raise exception 'Escala não encontrada.' using errcode = '42501';
  end if;
  if v.service_date < public.today_br() then
    raise exception 'Essa escala já passou.';
  end if;
  update public.schedule_slots
     set status = v_status,
         swap_reason = case when p_confirm then null else nullif(trim(left(p_reason, 200)), '') end,
         answered_at = now()
   where id = p_slot;

  if not p_confirm and v.status <> 'troca' then
    -- Pedido de troca: os (outros) líderes do ministério; sem nenhum com conta, a liderança da igreja.
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    select d.user_id, v.church_id, 'escala', 'Pedido de troca: ' || v.ministry,
           split_part(v.name, ' ', 1) || ' não pode em ' || public.schedule_when(v.service_date, v.service_time),
           '#/ministerios/' || v.ministry_id, 'escala-troca:' || p_slot || ':' || (extract(epoch from clock_timestamp()) * 1000)::bigint, true
    from (
      with lideres as (
        select m.user_id from public.ministry_members mm join public.members m on m.id = mm.member_id
        where mm.ministry_id = v.ministry_id and mm.role = 'lider' and m.user_id <> auth.uid()
          and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
      )
      select l.user_id from lideres l
      union
      select m.user_id from public.members m
      where m.church_id = v.church_id and m.role in ('admin', 'secretaria', 'lider') and m.user_id <> auth.uid()
        and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
        and not exists (select 1 from lideres)
    ) d
    on conflict do nothing;
  end if;
  return v_status;
end $$;

revoke execute on function public.ministry_overview(uuid) from public, anon;
revoke execute on function public.ministry_roster(uuid) from public, anon;
revoke execute on function public.ministry_candidates(uuid, text) from public, anon;
revoke execute on function public.ministry_schedules(uuid) from public, anon;
revoke execute on function public.my_schedules(uuid) from public, anon;
revoke execute on function public.schedule_when(date, time) from public, anon;
revoke execute on function public.save_schedule(uuid, uuid, date, time, text, text, jsonb) from public, anon;
revoke execute on function public.schedule_answer(uuid, boolean, text) from public, anon;
grant execute on function public.ministry_overview(uuid) to authenticated;
grant execute on function public.ministry_roster(uuid) to authenticated;
grant execute on function public.ministry_candidates(uuid, text) to authenticated;
grant execute on function public.ministry_schedules(uuid) to authenticated;
grant execute on function public.my_schedules(uuid) to authenticated;
grant execute on function public.schedule_when(date, time) to authenticated;
grant execute on function public.save_schedule(uuid, uuid, date, time, text, text, jsonb) to authenticated;
grant execute on function public.schedule_answer(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Lembrete na véspera (envio de 10 em 10 minutos, com a senha ENVIO_SECRET)
-- ---------------------------------------------------------------------
create or replace function public.deliver_schedule_reminders(p_secret text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'America/Sao_Paulo';
  v_count integer;
begin
  perform public.envio_check_secret(p_secret);
  if extract(hour from v_now) < 7 or extract(hour from v_now) >= 21 then
    return 0;
  end if;
  with marcados as (
    update public.schedule_slots sl
       set reminded_at = now()
      from public.schedules s, public.ministries mi, public.members m
     where s.id = sl.schedule_id and mi.id = s.ministry_id and m.id = sl.member_id
       and sl.reminded_at is null and sl.status <> 'troca'
       and s.service_date = v_now::date + 1
       and mi.active and public.ministries_on(mi.church_id)
       and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
    returning sl.id, sl.task, m.user_id, mi.church_id, mi.name, s.service_date, s.service_time, s.title
  )
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select x.user_id, x.church_id, 'escala', 'Amanhã você serve: ' || x.name,
         concat_ws(' · ', public.schedule_when(x.service_date, x.service_time), x.task, x.title),
         '#/escalas', 'escala-lembrete:' || x.id, true
  from marcados x
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.deliver_schedule_reminders(text) from public;
grant execute on function public.deliver_schedule_reminders(text) to anon;

-- ---------------------------------------------------------------------
-- 7. Visitantes: a equipe do ministério que recebe os avisos (ex.: Acolhimento)
-- ---------------------------------------------------------------------
-- Contas da equipe que recebe os avisos de visitantes da igreja (vazio se não houver).
create or replace function public.visitor_team_users(p_church uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select distinct m.user_id
  from public.ministries mi
  join public.ministry_members mm on mm.ministry_id = mi.id
  join public.members m on m.id = mm.member_id
  where mi.church_id = p_church and mi.receives_visitors and mi.active and public.ministries_on(p_church)
    and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
$$;
revoke execute on function public.visitor_team_users(uuid) from public, anon, authenticated;

-- Igrejas em que a pessoa está na equipe dos visitantes.
create or replace function public.my_visitor_churches()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select mi.church_id
  from public.ministries mi
  join public.ministry_members mm on mm.ministry_id = mi.id
  join public.members m on m.id = mm.member_id
  where mi.receives_visitors and mi.active and public.ministries_on(mi.church_id)
    and m.church_id = mi.church_id and m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
$$;
revoke execute on function public.my_visitor_churches() from public, anon;
grant execute on function public.my_visitor_churches() to authenticated;

-- Campo calculado do cadastro (members.visitor_team): o app mostra a tela Visitantes para a equipe.
create or replace function public.visitor_team(m public.members)
returns boolean language sql stable security definer set search_path = '' as $$
  select m.user_id = auth.uid() and m.church_id in (select public.my_visitor_churches())
$$;
revoke execute on function public.visitor_team(public.members) from public, anon;
grant execute on function public.visitor_team(public.members) to authenticated;

-- A equipe lê e acompanha (situação e anotações). Apagar e cadastrar como membro: só a liderança.
drop policy if exists "visitantes equipe le" on public.visitors;
create policy "visitantes equipe le" on public.visitors for select to authenticated
  using (church_id in (select public.my_visitor_churches()));
drop policy if exists "visitantes equipe edita" on public.visitors;
create policy "visitantes equipe edita" on public.visitors for update to authenticated
  using (church_id in (select public.my_visitor_churches()))
  with check (church_id in (select public.my_visitor_churches()));

-- Cadastro público: agora o aviso vai para a equipe (sem ela, para a liderança).
create or replace function public.register_visitor(
  p_church uuid, p_name text, p_phone text, p_email text, p_first_time boolean, p_source text,
  p_wants_contact boolean, p_message text, p_consent boolean, p_website text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_ip text;
  v_hash text;
  v_id uuid;
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  -- Campo escondido que só robôs preenchem: finge que deu certo e não grava nada.
  if coalesce(p_website, '') <> '' then
    return true;
  end if;
  if not exists (
    select 1 from public.churches c
    where c.id = p_church and c.active and coalesce((c.features->>'visitantes')::boolean, false)
  ) then
    raise exception 'O cadastro de visitantes não está ligado nesta igreja.' using errcode = '42501';
  end if;
  if not coalesce(p_consent, false) then
    raise exception 'Para enviar, marque a autorização.' using errcode = '22023';
  end if;

  -- Limite de envios: por aparelho (endereço de internet, guardado só como impressão digital) e por igreja.
  v_ip := split_part(coalesce((current_setting('request.headers', true)::json)->>'x-forwarded-for', ''), ',', 1);
  v_hash := case when v_ip <> '' then encode(extensions.digest(v_ip || ':' || p_church::text, 'sha256'), 'hex') end;
  if v_hash is not null and (select count(*) from public.visitors v
                             where v.ip_hash = v_hash and v.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Muitos cadastros enviados daqui. Tente de novo mais tarde.' using errcode = '54000';
  end if;
  if (select count(*) from public.visitors v
      where v.church_id = p_church and v.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Muitos cadastros nesta hora. Tente de novo mais tarde.' using errcode = '54000';
  end if;

  insert into public.visitors (church_id, name, phone, email, first_time, source, wants_contact, message, consent_at, ip_hash)
  values (p_church, v_name, nullif(trim(p_phone), ''), nullif(lower(trim(p_email)), ''), p_first_time,
          nullif(p_source, ''), coalesce(p_wants_contact, true), nullif(trim(p_message), ''), now(), v_hash)
  returning id into v_id;

  -- Aviso para a equipe dos visitantes ou, sem ela, para a liderança (central do app e celular).
  -- O texto do visitante não vai na notificação.
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select d.user_id, p_church, 'visitante',
         'Novo visitante: ' || split_part(v_name, ' ', 1),
         concat_ws(' · ',
           case when p_first_time then 'Primeira vez' end,
           case when coalesce(p_wants_contact, true) then 'Quer que alguém fale com ele' else 'Não pediu contato' end),
         '#/visitantes/' || v_id, 'visitante:' || v_id, true
  from (
    select t.user_id from public.visitor_team_users(p_church) t(user_id)
    union
    select m.user_id from public.members m
    where m.church_id = p_church and m.role in ('admin', 'secretaria', 'lider') and m.status = 'ativo'
      and m.user_id is not null and m.consent_at is not null
      and not exists (select 1 from public.visitor_team_users(p_church))
  ) d
  on conflict do nothing;
  return true;
end $$;
revoke execute on function public.register_visitor(uuid, text, text, text, boolean, text, boolean, text, boolean, text) from public;
grant execute on function public.register_visitor(uuid, text, text, text, boolean, text, boolean, text, boolean, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. Os próprios dados: os ministérios e as escalas
-- ---------------------------------------------------------------------
create or replace function public.export_my_data()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Entre na sua conta.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'exportado_em', now(),
    'aviso', 'Dados que o Igreja Conecta guarda sobre você. Dados de outras pessoas não aparecem aqui.',
    'conta', (
      select jsonb_build_object(
        'email', u.email,
        'criada_em', u.created_at,
        'ultimo_acesso', u.last_sign_in_at,
        'entrou_com', coalesce(u.raw_app_meta_data->'providers', '[]'::jsonb),
        'administrador_da_plataforma', exists (select 1 from public.platform_admins p where p.user_id = u.id))
      from auth.users u where u.id = v_user),
    'igrejas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'igreja', c.name,
        'endereco_no_app', '/i/' || c.slug || '/',
        'papel', m.role,
        'situacao', m.status,
        'convite_aceito_em', m.consent_at,
        'cadastrado_em', m.created_at,
        'cadastro', jsonb_build_object(
          'nome', m.name,
          'email', m.email,
          'telefone', m.phone,
          'nascimento', m.birth_date,
          'casamento', m.wedding_date,
          'batismo', m.baptism_date,
          'foto', m.photo_path,
          'mostra_aniversario_aos_membros', m.show_birthday,
          'mostra_casamento_aos_membros', m.show_wedding,
          'mostra_batismo_aos_membros', m.show_baptism,
          'mostra_telefone_aos_membros', m.show_phone),
        'celulas', coalesce((
          select jsonb_agg(jsonb_build_object(
            'celula', ce.name,
            'papel', cm.role,
            'desde', cm.added_at,
            'presencas', coalesce((
              select jsonb_agg(e.meeting_date order by e.meeting_date desc)
              from public.cell_attendance a join public.cell_meetings e on e.id = a.meeting_id
              where a.member_id = m.id and e.cell_id = ce.id), '[]'::jsonb)) order by ce.name)
          from public.cell_members cm join public.cells ce on ce.id = cm.cell_id
          where cm.member_id = m.id), '[]'::jsonb),
        'ministerios', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ministerio', mi.name,
            'papel', mm.role,
            'desde', mm.added_at) order by mi.name)
          from public.ministry_members mm join public.ministries mi on mi.id = mm.ministry_id
          where mm.member_id = m.id), '[]'::jsonb),
        'escalas', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ministerio', mi.name,
            'data', s.service_date,
            'horario', s.service_time,
            'funcao', sl.task,
            'situacao', sl.status,
            'motivo_da_troca', sl.swap_reason,
            'respondida_em', sl.answered_at) order by s.service_date desc)
          from public.schedule_slots sl
          join public.schedules s on s.id = sl.schedule_id
          join public.ministries mi on mi.id = s.ministry_id
          where sl.member_id = m.id), '[]'::jsonb),
        'mensagens_enviadas', coalesce((
          select jsonb_agg(jsonb_build_object('tipo', l.kind, 'canal', l.channel, 'data', l.target_date, 'situacao', l.status)
                           order by l.target_date desc)
          from public.message_log l where l.member_id = m.id), '[]'::jsonb))
        order by c.name)
      from public.members m join public.churches c on c.id = m.church_id
      where m.user_id = v_user), '[]'::jsonb),
    'pedidos_de_oracao', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'pedido', p.body,
                                          'para', case when p.audience = 'igreja' then 'a igreja' else 'os pastores' end,
                                          'anonimo', p.anonymous, 'situacao', p.status, 'enviado_em', p.created_at,
                                          'deus_respondeu_em', p.answered_at) order by p.created_at desc)
      from public.prayer_requests p join public.churches c on c.id = p.church_id
      where p.user_id = v_user), '[]'::jsonb),
    'orando_por', (select count(*) from public.prayer_praying x where x.user_id = v_user),
    'planos_de_leitura', coalesce((
      select jsonb_agg(jsonb_build_object(
        'igreja', c.name,
        'plano', public.reading_plan_title(p.plan_key),
        'inicio', p.start_date,
        'entrou_em', pm.joined_at,
        'lembrete', pm.remind,
        'dias_lidos', coalesce((
          select jsonb_agg(jsonb_build_object('dia', r.day, 'marcado_em', r.read_at) order by r.day)
          from public.reading_progress r where r.plan_id = p.id and r.user_id = v_user), '[]'::jsonb))
        order by pm.joined_at)
      from public.reading_plan_members pm
      join public.reading_plans p on p.id = pm.plan_id
      join public.churches c on c.id = p.church_id
      where pm.user_id = v_user), '[]'::jsonb),
    'amem_em_devocionais', (select count(*) from public.devotional_amens a where a.user_id = v_user),
    'notificacoes', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'tipo', n.kind, 'titulo', n.title, 'texto', n.body,
                                          'criada_em', n.created_at, 'lida_em', n.read_at) order by n.created_at desc)
      from public.notifications n join public.churches c on c.id = n.church_id
      where n.user_id = v_user), '[]'::jsonb),
    'aparelhos_com_notificacao', coalesce((
      select jsonb_agg(jsonb_build_object('servico', split_part(split_part(ps.endpoint, '://', 2), '/', 1), 'ativado_em', ps.created_at))
      from public.push_subscriptions ps where ps.user_id = v_user), '[]'::jsonb),
    'publicado_por_voce', jsonb_build_object(
      'eventos', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'titulo', e.title, 'inicio', e.starts_at, 'criado_em', e.created_at))
        from public.events e join public.churches c on c.id = e.church_id where e.created_by = v_user), '[]'::jsonb),
      'avisos', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'titulo', a.title, 'criado_em', a.created_at))
        from public.announcements a join public.churches c on c.id = a.church_id where a.created_by = v_user), '[]'::jsonb),
      'devocionais', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'titulo', d.title, 'data', d.publish_date, 'criado_em', d.created_at))
        from public.devotionals d join public.churches c on c.id = d.church_id where d.created_by = v_user), '[]'::jsonb),
      'escalas_montadas', (select count(*) from public.schedules s where s.created_by = v_user),
      'cadastros_feitos', (select count(*) from public.members x where x.created_by = v_user))
  );
end $$;
-- Sair da igreja apaga o cadastro, e com ele a equipe e as escalas (on delete cascade).

-- ---------------------------------------------------------------------
-- 9. Dados de teste: as igrejas de teste ligam as escalas
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"escalas": true}'::jsonb
where slug in ('teste-a', 'teste-b');
