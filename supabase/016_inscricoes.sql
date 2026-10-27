-- =====================================================================
-- Igreja Conecta — inscrição em eventos (Fase 3)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - A liderança liga as inscrições num evento que não se repete (retiro,
--   curso), com número de vagas, prazo e lista de espera
-- - O membro se inscreve, entra na lista de espera ou cancela; quando abre
--   uma vaga, o primeiro da fila ganha a vaga sozinho
-- - A vaga é garantida pelo banco (uma inscrição por vez em cada evento)
-- - Os membros veem só quantas vagas restam; a lista de inscritos, só a liderança
-- - Aviso na central e no celular, e e-mail de confirmação (dentro do limite
--   diário de e-mails), pelo envio de 10 em 10 minutos
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Funcionalidade, tipo de notificação e o evento com inscrição
-- ---------------------------------------------------------------------
create or replace function public.registrations_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'inscricoes')::boolean and (c.features->>'agenda')::boolean
                   from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.registrations_on(uuid) from public, anon;
grant execute on function public.registrations_on(uuid) to authenticated;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'oracao', 'visitante',
                  'devocional', 'leitura', 'escala', 'inscricao'));

alter table public.events add column if not exists registration boolean not null default false;
alter table public.events add column if not exists capacity integer check (capacity between 1 and 5000);
alter table public.events add column if not exists registration_until timestamptz;
alter table public.events add column if not exists waitlist boolean not null default true;
alter table public.events drop constraint if exists events_registration_once;
alter table public.events add constraint events_registration_once check (not (registration and repeat_weekly));
grant update (registration, capacity, registration_until, waitlist) on public.events to authenticated;

-- ---------------------------------------------------------------------
-- 2. Inscrições
-- ---------------------------------------------------------------------
create table if not exists public.event_registrations (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events on delete cascade,
  member_id     uuid not null references public.members on delete cascade,
  status        text not null check (status in ('confirmada', 'espera')),
  created_at    timestamptz not null default now(),   -- ordem da lista de espera
  confirmed_at  timestamptz,
  email_pending boolean not null default false,
  emailed_at    timestamptz,
  unique (event_id, member_id)
);
create index if not exists event_registrations_event_idx on public.event_registrations (event_id, status, created_at);
create index if not exists event_registrations_member_idx on public.event_registrations (member_id);
create index if not exists event_registrations_email_idx on public.event_registrations (confirmed_at) where email_pending;

-- Cada um lê as próprias; a liderança lê as da igreja. Gravar, só pelas funções abaixo.
alter table public.event_registrations enable row level security;
drop policy if exists "inscricoes le" on public.event_registrations;
create policy "inscricoes le" on public.event_registrations for select to authenticated
  using (member_id in (select m.id from public.members m where m.user_id = auth.uid())
         or event_id in (select e.id from public.events e where e.church_id in (select public.my_church_ids('lideranca'))));
revoke all on public.event_registrations from anon;
revoke insert, update, delete on public.event_registrations from authenticated;

-- "8/11 às 19h", no horário de Brasília.
create or replace function public.event_when(p_at timestamptz)
returns text language sql stable set search_path = '' as $$
  select public.schedule_when((p_at at time zone 'America/Sao_Paulo')::date, (p_at at time zone 'America/Sao_Paulo')::time)
$$;
revoke execute on function public.event_when(timestamptz) from public, anon;
grant execute on function public.event_when(timestamptz) to authenticated;

-- Abriu vaga (alguém saiu ou a liderança aumentou as vagas): o primeiro da fila ganha a vaga.
create or replace function public.event_promote(p_event uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_free integer;
  v_count integer;
begin
  select * into e from public.events where id = p_event for update;
  if e.id is null or not e.registration or e.starts_at <= now() then
    return 0;
  end if;
  v_free := case when e.capacity is null then 5000
                 else e.capacity - (select count(*) from public.event_registrations r
                                    where r.event_id = p_event and r.status = 'confirmada')::integer end;
  if v_free <= 0 then
    return 0;
  end if;
  with fila as (
    select r.id from public.event_registrations r
    where r.event_id = p_event and r.status = 'espera'
    order by r.created_at
    limit v_free
    for update
  ), subiu as (
    update public.event_registrations r
       set status = 'confirmada', confirmed_at = now(), email_pending = true
      from fila where r.id = fila.id
    returning r.id, r.member_id
  )
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select m.user_id, e.church_id, 'inscricao', 'Abriu uma vaga: ' || e.title,
         'Sua inscrição está confirmada · ' || public.event_when(e.starts_at),
         '#/agenda/' || e.id, 'inscricao:' || s.id || ':confirmada', true
  from subiu s join public.members m on m.id = s.member_id
  where m.user_id is not null
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.event_promote(uuid) from public, anon, authenticated;

-- Quem sai (cancelou, foi tirado, saiu da igreja) libera a vaga.
create or replace function public.event_registrations_left()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'confirmada' then
    perform public.event_promote(old.event_id);
  end if;
  return old;
end $$;
drop trigger if exists event_registrations_left on public.event_registrations;
create trigger event_registrations_left after delete on public.event_registrations
  for each row execute function public.event_registrations_left();
revoke execute on function public.event_registrations_left() from public, anon, authenticated;

-- A liderança aumentou as vagas (ou ligou as inscrições de novo): a fila anda.
create or replace function public.events_registration_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.registration then
    perform public.event_promote(new.id);
  end if;
  return new;
end $$;
drop trigger if exists events_registration_changed on public.events;
create trigger events_registration_changed after update of capacity, registration on public.events
  for each row execute function public.events_registration_changed();
revoke execute on function public.events_registration_changed() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Funções das telas
-- ---------------------------------------------------------------------
-- Eventos com inscrição (de ontem em diante): vagas, quantos estão na fila e a situação da pessoa.
create or replace function public.event_registration_summary(p_church uuid)
returns table (event_id uuid, capacity integer, waitlist boolean, registration_until timestamptz, open boolean,
               confirmed integer, waiting integer, my_status text, my_position integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.is_member(p_church) or not public.registrations_on(p_church) then
    return;
  end if;
  return query
  select e.id, e.capacity, e.waitlist, e.registration_until,
         now() < e.starts_at and (e.registration_until is null or now() <= e.registration_until),
         (select count(*) from public.event_registrations r where r.event_id = e.id and r.status = 'confirmada')::integer,
         (select count(*) from public.event_registrations r where r.event_id = e.id and r.status = 'espera')::integer,
         mine.status,
         case when mine.status = 'espera' then (
           select count(*)::integer + 1 from public.event_registrations r
           where r.event_id = e.id and r.status = 'espera' and r.created_at < mine.created_at) end
  from public.events e
  left join lateral (
    select r.status, r.created_at from public.event_registrations r
    join public.members m on m.id = r.member_id
    where r.event_id = e.id and m.user_id = auth.uid()
  ) mine on true
  where e.church_id = p_church and e.registration and e.starts_at > now() - interval '1 day'
  order by e.starts_at;
end $$;

-- Inscrever-se (ou entrar na lista de espera). Devolve 'confirmada' ou 'espera'.
create or replace function public.event_register(p_event uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  e public.events;
  v_member uuid;
  v_status text;
  v_id uuid;
  v_position integer;
begin
  -- Trava o evento: duas pessoas ao mesmo tempo não pegam a mesma vaga.
  select * into e from public.events where id = p_event for update;
  if e.id is null or not e.registration or not public.registrations_on(e.church_id) then
    raise exception 'Este evento não tem inscrição.' using errcode = '42501';
  end if;
  select m.id into v_member from public.members m
  where m.church_id = e.church_id and m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null;
  if v_member is null then
    raise exception 'Só quem é da igreja se inscreve.' using errcode = '42501';
  end if;
  select r.status into v_status from public.event_registrations r where r.event_id = p_event and r.member_id = v_member;
  if v_status is not null then
    return v_status;
  end if;
  if now() >= e.starts_at or (e.registration_until is not null and now() > e.registration_until) then
    raise exception 'As inscrições estão encerradas.';
  end if;
  if e.capacity is null or (select count(*) from public.event_registrations r
                            where r.event_id = p_event and r.status = 'confirmada') < e.capacity then
    v_status := 'confirmada';
  elsif e.waitlist then
    v_status := 'espera';
  else
    raise exception 'As vagas acabaram.';
  end if;
  insert into public.event_registrations (event_id, member_id, status, confirmed_at, email_pending)
  values (p_event, v_member, v_status, case when v_status = 'confirmada' then now() end, v_status = 'confirmada')
  returning id into v_id;
  v_position := (select count(*) from public.event_registrations r where r.event_id = p_event and r.status = 'espera');

  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  values (auth.uid(), e.church_id, 'inscricao',
          case when v_status = 'confirmada' then 'Inscrição confirmada: ' else 'Lista de espera: ' end || e.title,
          case when v_status = 'confirmada' then public.event_when(e.starts_at)
               else 'Você é o número ' || v_position || ' da fila. Se abrir uma vaga, ela é sua.' end,
          '#/agenda/' || e.id, 'inscricao:' || v_id || ':' || v_status, true)
  on conflict do nothing;
  return v_status;
end $$;

-- Cancelar a própria inscrição (até o evento começar). A vaga passa para a fila.
create or replace function public.event_unregister(p_event uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.events e where e.id = p_event and e.starts_at <= now()) then
    raise exception 'O evento já começou.';
  end if;
  delete from public.event_registrations r using public.members m
   where r.event_id = p_event and m.id = r.member_id and m.user_id = auth.uid();
end $$;

-- Lista de inscritos e da fila, para a liderança da igreja.
create or replace function public.event_registrants(p_event uuid)
returns table (id uuid, member_id uuid, name text, phone text, email text, status text, created_at timestamptz, has_account boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not exists (select 1 from public.events e where e.id = p_event and public.is_leader(e.church_id)) then
    return;
  end if;
  return query
  select r.id, m.id, m.name, m.phone, m.email, r.status, r.created_at, m.user_id is not null
  from public.event_registrations r join public.members m on m.id = r.member_id
  where r.event_id = p_event
  order by case r.status when 'confirmada' then 0 else 1 end, r.created_at;
end $$;

-- A liderança tira alguém da lista (a pessoa recebe um aviso; a vaga passa para a fila).
create or replace function public.event_registration_remove(p_registration uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v record;
begin
  select r.id, m.user_id, e.id as event_id, e.church_id, e.title into v
  from public.event_registrations r
  join public.members m on m.id = r.member_id
  join public.events e on e.id = r.event_id
  where r.id = p_registration and public.is_leader(e.church_id);
  if v.id is null then
    raise exception 'Inscrição não encontrada.' using errcode = '42501';
  end if;
  delete from public.event_registrations where id = p_registration;
  if v.user_id is not null and v.user_id <> auth.uid() then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    values (v.user_id, v.church_id, 'inscricao', 'Inscrição cancelada: ' || v.title,
            'A liderança da igreja tirou a sua inscrição. Em caso de dúvida, fale com ela.',
            '#/agenda/' || v.event_id, 'inscricao:' || p_registration || ':removida', true)
    on conflict do nothing;
  end if;
end $$;

revoke execute on function public.event_registration_summary(uuid) from public, anon;
revoke execute on function public.event_register(uuid) from public, anon;
revoke execute on function public.event_unregister(uuid) from public, anon;
revoke execute on function public.event_registrants(uuid) from public, anon;
revoke execute on function public.event_registration_remove(uuid) from public, anon;
grant execute on function public.event_registration_summary(uuid) to authenticated;
grant execute on function public.event_register(uuid) to authenticated;
grant execute on function public.event_unregister(uuid) to authenticated;
grant execute on function public.event_registrants(uuid) to authenticated;
grant execute on function public.event_registration_remove(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. E-mail de confirmação (envio de 10 em 10 minutos, com a senha ENVIO_SECRET)
-- ---------------------------------------------------------------------
-- O limite diário vale para todos os e-mails juntos: aniversários e confirmações de inscrição.
create or replace function public.emails_sent_today()
returns integer language sql stable security definer set search_path = '' as $$
  select (select count(*)::integer from public.message_log
          where channel = 'email' and (created_at at time zone 'America/Sao_Paulo')::date = public.today_br())
       + (select count(*)::integer from public.event_registrations
          where emailed_at is not null and (emailed_at at time zone 'America/Sao_Paulo')::date = public.today_br())
$$;
revoke execute on function public.emails_sent_today() from public, anon, authenticated;

-- Separa os e-mails que cabem no limite de hoje e já marca como enviados. Igrejas de teste e
-- eventos que já começaram não recebem (o aviso no app já chegou).
create or replace function public.claim_registration_emails(p_secret text)
returns table (registration_id uuid, email text, name text, church_slug text, church_name text,
               event_id uuid, title text, starts_at timestamptz, ends_at timestamptz, location text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_room integer;
begin
  perform public.envio_check_secret(p_secret);
  update public.event_registrations r
     set email_pending = false
    from public.events e, public.members m, public.churches c
   where e.id = r.event_id and m.id = r.member_id and c.id = e.church_id and r.email_pending
     and (e.starts_at <= now() or c.is_test or not c.active or m.email is null or r.status <> 'confirmada');
  v_room := greatest(public.email_daily_limit() - public.emails_sent_today(), 0);
  return query
  with escolhidas as (
    select r.id from public.event_registrations r
    where r.email_pending
    order by r.confirmed_at
    limit v_room
    for update skip locked
  ), marcadas as (
    update public.event_registrations r
       set email_pending = false, emailed_at = now()
      from escolhidas x where r.id = x.id
    returning r.id, r.event_id, r.member_id
  )
  select x.id, m.email, m.name, c.slug, c.name, e.id, e.title, e.starts_at, e.ends_at, e.location
  from marcadas x
  join public.events e on e.id = x.event_id
  join public.members m on m.id = x.member_id
  join public.churches c on c.id = e.church_id;
end $$;
revoke execute on function public.claim_registration_emails(text) from public;
grant execute on function public.claim_registration_emails(text) to anon;

-- ---------------------------------------------------------------------
-- 5. Os próprios dados: as inscrições
-- ---------------------------------------------------------------------
-- (export_my_data é recriada abaixo, com 'inscricoes_em_eventos'; sair da igreja apaga as
-- inscrições junto com o cadastro, e a vaga passa para a fila.)
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
    'inscricoes_em_eventos', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'evento', e.title, 'inicio', e.starts_at,
                                          'situacao', r.status, 'inscrito_em', r.created_at, 'confirmada_em', r.confirmed_at,
                                          'email_de_confirmacao_em', r.emailed_at) order by e.starts_at desc)
      from public.event_registrations r
      join public.members m on m.id = r.member_id
      join public.events e on e.id = r.event_id
      join public.churches c on c.id = e.church_id
      where m.user_id = v_user), '[]'::jsonb),
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

-- ---------------------------------------------------------------------
-- 6. Dados de teste: as igrejas de teste ligam as inscrições
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"inscricoes": true}'::jsonb
where slug in ('teste-a', 'teste-b');
