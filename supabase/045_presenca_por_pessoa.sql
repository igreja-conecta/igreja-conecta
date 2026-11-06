-- 045: relatório de presenças e ausências por pessoa (para a pastoral: administrador e líderes).
-- Rode no SQL Editor ANTES de publicar o app. Pode rodar de novo.
--
-- Para cada membro ativo, no período: quantas listas de presença contam para ele, em quantas veio,
-- quantas faltou e a última presença. Só contam as listas desde que a pessoa entrou para a igreja
-- ("Membro desde" ou, sem ele, o dia do cadastro) — ou desde a primeira presença, se veio antes.
-- Só números e o nome: sem telefone, e-mail ou como a presença foi marcada.

create or replace function public.attendance_people(p_church uuid, p_from date, p_to date)
returns table (member_id uuid, name text, since date, sessions integer, present integer, absent integer, last_present date)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_to date := least(p_to, public.today_br());
begin
  if not coalesce(public.can_see_absences(p_church), false) then
    raise exception 'Só o administrador e os líderes veem as presenças por pessoa.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Período inválido (até 400 dias).';
  end if;
  return query
  with ss as (
    select s.id, s.session_date from public.attendance_sessions s
    where s.church_id = p_church and s.session_date between p_from and v_to
  ),
  pr as (
    select a.member_id, ss.session_date from public.attendance a join ss on ss.id = a.session_id
  ),
  mm as (
    select m.id, m.name,
           coalesce(m.member_since, (m.created_at at time zone 'America/Sao_Paulo')::date) as joined,
           (select min(pr.session_date) from pr where pr.member_id = m.id) as first_in
    from public.members m
    where m.church_id = p_church and m.status = 'ativo'
  ),
  calc as (
    select mm.id, mm.name, mm.joined, least(mm.joined, coalesce(mm.first_in, mm.joined)) as start_at,
           (select count(*) from pr where pr.member_id = mm.id)::integer as present
    from mm
  )
  select c.id, c.name, c.joined,
         n.total,
         c.present,
         greatest(n.total - c.present, 0),
         (select max(s.session_date) from public.attendance a
            join public.attendance_sessions s on s.id = a.session_id
           where a.member_id = c.id and s.church_id = p_church and s.session_date <= v_to)
  from calc c
  cross join lateral (select count(*)::integer as total from ss where ss.session_date >= c.start_at) n
  order by c.name;
end $$;
revoke execute on function public.attendance_people(uuid, date, date) from public, anon;
grant execute on function public.attendance_people(uuid, date, date) to authenticated;
