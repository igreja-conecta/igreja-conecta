-- 046: evento da agenda com lista de presença automática.
-- Rode no SQL Editor ANTES de publicar o app. Pode rodar de novo.
--
-- Quem cria o evento marca "Fazer lista de presença". No dia de cada ocorrência (evento semanal:
-- uma lista por semana), a lista é aberta sozinha com o nome do evento e ligada a ele:
--   - na hora, ao salvar um evento que acontece hoje (gatilho);
--   - e a cada 10 minutos pelo relógio do banco (pg_cron), para os dias seguintes.
-- Se já existe uma lista com o mesmo nome no mesmo dia (aberta à mão), fica essa (índice único do 033).
-- Desligar a opção não apaga as listas já feitas. Só vale com a Presença nos cultos ligada.

alter table public.events add column if not exists attendance boolean not null default false;
-- Quem edita o evento (liderança, pela regra "events lideranca edita" do 005) liga e desliga.
grant update (attendance) on public.events to authenticated;

-- Abre as listas de hoje (horário de Brasília) dos eventos com a opção ligada. p_event: só a de um
-- evento (usado pelo gatilho). Devolve quantas listas novas abriu.
create or replace function public.open_event_attendance(p_event uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_today date := public.today_br();
  v_from timestamptz := v_today::timestamp at time zone 'America/Sao_Paulo';
  v_n integer;
begin
  insert into public.attendance_sessions (church_id, title, session_date, event_id)
  select o.church_id, left(regexp_replace(trim(o.title), '\s+', ' ', 'g'), 80), v_today, o.event_id
  from public.event_occurrences(v_from, v_from + interval '1 day') o
  join public.events e on e.id = o.event_id
  where e.attendance
    and (p_event is null or e.id = p_event)
    and (o.starts_at at time zone 'America/Sao_Paulo')::date = v_today
    and public.attendance_on(o.church_id)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function public.open_event_attendance(uuid) from public, anon, authenticated;

-- Ao criar o evento ou ligar a opção (ou mudar data/nome), se acontece hoje, a lista já aparece.
create or replace function public.events_attendance_now()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.attendance then
    perform public.open_event_attendance(new.id);
  end if;
  return null;
end $$;
revoke execute on function public.events_attendance_now() from public, anon, authenticated;

drop trigger if exists events_attendance_now on public.events;
create trigger events_attendance_now
  after insert or update of attendance, starts_at, title, repeat_weekly, repeat_until on public.events
  for each row execute function public.events_attendance_now();

-- Relógio: a cada 10 minutos (o mesmo nome substitui o agendamento, se já existir).
select cron.schedule('presenca-agenda', '*/10 * * * *', $$select public.open_event_attendance()$$);
