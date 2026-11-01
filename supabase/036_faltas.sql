-- =====================================================================
-- Igreja Conecta — presença nos cultos, entrega 4: aviso de quem está faltando
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - Quem está faltando: vinha (2 presenças ou mais nos últimos 4 meses) e não aparece
--   há N semanas (padrão 3; o administrador muda em Configurar), contando só se a igreja
--   fez pelo menos N listas desde a última presença (férias sem lista não contam)
-- - Quem vê e recebe o aviso: a pastoral (administrador e líderes), como os pedidos de oração
-- - Aviso semanal (segunda-feira, a partir das 9h), sem nomes no texto: os nomes ficam na tela
-- - "Estou acompanhando": tira a pessoa da lista por algumas semanas
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Configuração: semanas sem vir para entrar na lista (0 = sem aviso)
-- ---------------------------------------------------------------------
alter table public.churches add column if not exists absence_alert_weeks smallint not null default 3
  check (absence_alert_weeks between 0 and 12);
grant update (absence_alert_weeks) on public.churches to authenticated;

-- ---------------------------------------------------------------------
-- 2. "Estou acompanhando"
-- ---------------------------------------------------------------------
create table if not exists public.absence_followups (
  member_id  uuid primary key references public.members on delete cascade,
  church_id  uuid not null references public.churches on delete cascade,
  until      date not null,
  by_user    uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
alter table public.absence_followups enable row level security;
revoke all on public.absence_followups from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Quem está faltando (para a tela e para o aviso)
-- ---------------------------------------------------------------------
-- Sem checagem de quem pede: só as funções abaixo chamam.
create or replace function public.absence_rows(p_church uuid)
returns table (member_id uuid, name text, phone text, last_present date, presences integer, missed integer,
               followed_until date, followed_by text)
language sql stable security definer set search_path = '' as $$
  with cfg as (
    select c.absence_alert_weeks w from public.churches c where c.id = p_church
  ),
  mine as (
    select a.member_id, max(s.session_date) last_present,
           count(*) filter (where s.session_date >= public.today_br() - 120) presences
    from public.attendance a
    join public.attendance_sessions s on s.id = a.session_id
    where a.church_id = p_church
    group by a.member_id
  )
  select m.id, m.name, m.phone, x.last_present, x.presences::integer,
         (select count(*) from public.attendance_sessions s2
           where s2.church_id = p_church and s2.session_date > x.last_present and s2.session_date <= public.today_br())::integer,
         f.until, (select u.name from public.members u where u.church_id = p_church and u.user_id = f.by_user limit 1)
  from mine x
  join public.members m on m.id = x.member_id
  cross join cfg
  left join public.absence_followups f on f.member_id = m.id and f.until >= public.today_br()
  where m.status = 'ativo' and cfg.w > 0
    and x.presences >= 2
    and x.last_present < public.today_br() - 7 * cfg.w
    and (select count(*) from public.attendance_sessions s2
          where s2.church_id = p_church and s2.session_date > x.last_present and s2.session_date <= public.today_br()) >= cfg.w
  order by x.last_present, m.name
$$;
revoke execute on function public.absence_rows(uuid) from public, anon, authenticated;

-- A pastoral (administrador e líderes), com a presença ligada.
create or replace function public.can_see_absences(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.attendance_on(p_church) and p_church in (select public.my_church_ids('pastoral'))
$$;
revoke execute on function public.can_see_absences(uuid) from public, anon;
grant execute on function public.can_see_absences(uuid) to authenticated;

create or replace function public.absence_list(p_church uuid)
returns table (member_id uuid, name text, phone text, last_present date, presences integer, missed integer,
               followed_until date, followed_by text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(public.can_see_absences(p_church), false) then
    raise exception 'Só a pastoral vê quem está faltando.' using errcode = '42501';
  end if;
  return query select * from public.absence_rows(p_church);
end $$;

-- "Estou acompanhando" por p_weeks semanas (1 a 12); 0 tira a marca.
create or replace function public.absence_follow(p_member uuid, p_weeks integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid;
begin
  select m.church_id into v_church from public.members m where m.id = p_member;
  if v_church is null or not coalesce(public.can_see_absences(v_church), false) then
    raise exception 'Só a pastoral marca o acompanhamento.' using errcode = '42501';
  end if;
  if p_weeks is null or p_weeks not between 0 and 12 then
    raise exception 'Escolha de 1 a 12 semanas.';
  end if;
  if p_weeks = 0 then
    delete from public.absence_followups where member_id = p_member;
  else
    insert into public.absence_followups (member_id, church_id, until)
    values (p_member, v_church, public.today_br() + 7 * p_weeks)
    on conflict (member_id) do update set until = excluded.until, by_user = auth.uid(), created_at = now();
  end if;
end $$;

revoke execute on function public.absence_list(uuid) from public, anon;
revoke execute on function public.absence_follow(uuid, integer) from public, anon;
grant execute on function public.absence_list(uuid) to authenticated;
grant execute on function public.absence_follow(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Aviso semanal para a pastoral (envio a cada 10 minutos, com a senha ENVIO_SECRET):
--    segunda-feira, a partir das 9h; um por semana; sem nomes no texto
-- ---------------------------------------------------------------------
create or replace function public.deliver_absence_alerts(p_secret text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'America/Sao_Paulo';
  v_week date := public.today_br() - (extract(isodow from public.today_br())::integer - 1);
  v_count integer := 0;
  v_rows integer;
  c record;
  v_n integer;
begin
  perform public.envio_check_secret(p_secret);
  if extract(isodow from v_now) <> 1 or extract(hour from v_now) < 9 or extract(hour from v_now) >= 21 then
    return 0;
  end if;
  for c in
    select ch.id from public.churches ch
    where ch.active and ch.absence_alert_weeks > 0 and coalesce((ch.features->>'presenca')::boolean, false)
  loop
    select count(*) into v_n from public.absence_rows(c.id) r where r.followed_until is null;
    continue when v_n = 0;
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    select m.user_id, c.id, 'presenca',
           case when v_n = 1 then '1 pessoa está faltando aos cultos' else v_n || ' pessoas estão faltando aos cultos' end,
           'Toque para ver quem é e marcar quem você vai procurar.',
           '#/presenca/faltas', 'faltas:' || c.id || ':' || v_week, true
    from public.members m
    where m.church_id = c.id and m.role in ('admin', 'lider') and m.status = 'ativo'
      and m.user_id is not null and m.consent_at is not null
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;
  return v_count;
end $$;
revoke execute on function public.deliver_absence_alerts(text) from public;
grant execute on function public.deliver_absence_alerts(text) to anon;
