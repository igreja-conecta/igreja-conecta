-- =====================================================================
-- Igreja Conecta — presença nos cultos (entrega 1: lista e QR da carteirinha)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - A equipe abre a lista de presença do culto (ou de um evento da Agenda) e marca
--   quem veio: tocando no nome ou lendo o QR Code da carteirinha
-- - Equipe: o ministério marcado "Marca a presença nos cultos" (e a liderança)
-- - A equipe vê só os nomes dos membros ativos, nada de telefone, e-mail ou aniversário
-- - Cada presença guarda a forma (lista, QR ou câmera), para o contador da tela
--   e os relatórios. A câmera chega numa próxima entrega
-- - O membro vê as próprias presenças (e elas entram em "Baixar meus dados")
-- - Sair da igreja apaga as presenças (on delete cascade do cadastro)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Funcionalidade e a equipe
-- ---------------------------------------------------------------------
create or replace function public.attendance_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'presenca')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.attendance_on(uuid) from public, anon;
grant execute on function public.attendance_on(uuid) to authenticated;

-- O ministério que marca a presença (um por igreja), como o do check-in infantil.
alter table public.ministries add column if not exists attendance_checkin boolean not null default false;
create unique index if not exists ministries_attendance_idx on public.ministries (church_id) where attendance_checkin;
grant update (attendance_checkin) on public.ministries to authenticated;

-- Igrejas em que a pessoa está na equipe da presença.
create or replace function public.my_attendance_churches()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select mi.church_id
  from public.ministries mi
  join public.ministry_members mm on mm.ministry_id = mi.id
  join public.members m on m.id = mm.member_id
  where mi.attendance_checkin and mi.active and public.ministries_on(mi.church_id)
    and m.church_id = mi.church_id and m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
$$;

-- Marca a presença: a liderança ou a equipe, com a funcionalidade ligada.
create or replace function public.can_attendance(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.attendance_on(p_church)
     and (public.is_leader(p_church) or p_church in (select public.my_attendance_churches()))
$$;

-- Campo calculado do cadastro (members.attendance_team): o app mostra a Presença para a equipe.
create or replace function public.attendance_team(m public.members)
returns boolean language sql stable security definer set search_path = '' as $$
  select m.user_id = auth.uid() and m.church_id in (select public.my_attendance_churches())
$$;

revoke execute on function public.my_attendance_churches() from public, anon;
revoke execute on function public.can_attendance(uuid) from public, anon;
revoke execute on function public.attendance_team(public.members) from public, anon;
grant execute on function public.my_attendance_churches() to authenticated;
grant execute on function public.can_attendance(uuid) to authenticated;
grant execute on function public.attendance_team(public.members) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Tabelas
-- ---------------------------------------------------------------------
-- Uma lista por culto: mesmo nome no mesmo dia é a mesma lista (duas pessoas na porta
-- marcam na mesma lista).
create table if not exists public.attendance_sessions (
  id           uuid primary key default gen_random_uuid(),
  church_id    uuid not null references public.churches on delete cascade,
  title        text not null check (char_length(title) between 2 and 80),
  session_date date not null,
  event_id     uuid references public.events on delete set null,
  created_by   uuid default auth.uid() references auth.users on delete set null,
  created_at   timestamptz not null default now()
);
create unique index if not exists attendance_sessions_day_idx on public.attendance_sessions (church_id, session_date, lower(title));

-- Uma linha por pessoa presente (quem não tem linha, não veio).
create table if not exists public.attendance (
  session_id uuid not null references public.attendance_sessions on delete cascade,
  member_id  uuid not null references public.members on delete cascade,
  church_id  uuid not null references public.churches on delete cascade,
  method     text not null check (method in ('lista', 'qr', 'camera')),
  marked_by  uuid default auth.uid() references auth.users on delete set null,
  marked_at  timestamptz not null default now(),
  primary key (session_id, member_id)
);
create index if not exists attendance_member_idx on public.attendance (member_id);
create index if not exists attendance_church_idx on public.attendance (church_id);

-- ---------------------------------------------------------------------
-- 3. Regras de acesso: ler, a equipe e a liderança (e o membro, as próprias presenças);
--    gravar, só pelas funções da seção 4
-- ---------------------------------------------------------------------
alter table public.attendance_sessions enable row level security;
drop policy if exists "presenca listas le" on public.attendance_sessions;
create policy "presenca listas le" on public.attendance_sessions for select to authenticated
  using (public.can_attendance(church_id)
         or id in (select a.session_id from public.attendance a where a.member_id = public.my_member_id(a.church_id)));
-- Apagar uma lista: a liderança, ou quem a abriu.
drop policy if exists "presenca listas apaga" on public.attendance_sessions;
create policy "presenca listas apaga" on public.attendance_sessions for delete to authenticated
  using (church_id in (select public.my_church_ids('lideranca'))
         or (created_by = auth.uid() and public.can_attendance(church_id)));
revoke all on public.attendance_sessions from anon;
revoke insert, update on public.attendance_sessions from authenticated;

alter table public.attendance enable row level security;
drop policy if exists "presenca le" on public.attendance;
create policy "presenca le" on public.attendance for select to authenticated
  using (public.can_attendance(church_id) or member_id = public.my_member_id(church_id));
revoke all on public.attendance from anon;
revoke insert, update, delete on public.attendance from authenticated;

-- ---------------------------------------------------------------------
-- 4. Funções das telas
-- ---------------------------------------------------------------------
-- Abre (ou reaproveita) a lista do culto. Datas: do último ano até amanhã.
create or replace function public.attendance_open(p_church uuid, p_title text, p_date date, p_event uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_title text := nullif(trim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g')), '');
  v_id uuid;
begin
  if not public.can_attendance(p_church) then
    raise exception 'Só a equipe da presença abre a lista.' using errcode = '42501';
  end if;
  if v_title is null or char_length(v_title) not between 2 and 80 then
    raise exception 'Dê um nome à lista (de 2 a 80 letras).';
  end if;
  if p_date is null or p_date < public.today_br() - 366 or p_date > public.today_br() + 1 then
    raise exception 'Escolha uma data do último ano até amanhã.';
  end if;
  if p_event is not null and not exists (select 1 from public.events e where e.id = p_event and e.church_id = p_church) then
    raise exception 'Evento não encontrado.' using errcode = '42501';
  end if;
  select s.id into v_id from public.attendance_sessions s
   where s.church_id = p_church and s.session_date = p_date and lower(s.title) = lower(v_title);
  if v_id is null then
    insert into public.attendance_sessions (church_id, title, session_date, event_id)
    values (p_church, v_title, p_date, p_event)
    on conflict do nothing
    returning id into v_id;
    -- Outra pessoa abriu a mesma lista no mesmo instante.
    if v_id is null then
      select s.id into v_id from public.attendance_sessions s
       where s.church_id = p_church and s.session_date = p_date and lower(s.title) = lower(v_title);
    end if;
  end if;
  return v_id;
end $$;

-- Listas desde a data pedida, com o contador por forma de marcar.
create or replace function public.attendance_sessions_list(p_church uuid, p_since date)
returns table (id uuid, title text, session_date date, event_id uuid, created_by uuid,
               total integer, by_list integer, by_qr integer, by_camera integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.can_attendance(p_church) then
    return;
  end if;
  return query
  select s.id, s.title, s.session_date, s.event_id, s.created_by,
         count(a.member_id)::integer,
         (count(a.member_id) filter (where a.method = 'lista'))::integer,
         (count(a.member_id) filter (where a.method = 'qr'))::integer,
         (count(a.member_id) filter (where a.method = 'camera'))::integer
  from public.attendance_sessions s
  left join public.attendance a on a.session_id = s.id
  where s.church_id = p_church and s.session_date >= coalesce(p_since, public.today_br() - 60)
  group by s.id
  order by s.session_date desc, s.created_at desc
  limit 200;
end $$;

-- A lista de um culto: os membros ativos (só o nome) e quem já está marcado, e como.
-- Quem foi marcado e depois ficou inativo continua aparecendo.
create or replace function public.attendance_roster(p_session uuid)
returns table (member_id uuid, name text, method text, marked_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_church uuid;
begin
  select s.church_id into v_church from public.attendance_sessions s where s.id = p_session;
  if v_church is null or not public.can_attendance(v_church) then
    return;
  end if;
  return query
  select m.id, m.name, a.method, a.marked_at
  from public.members m
  left join public.attendance a on a.session_id = p_session and a.member_id = m.id
  where m.church_id = v_church and (m.status = 'ativo' or a.member_id is not null)
  order by m.name;
end $$;

-- Confere a lista e a pessoa (da mesma igreja e ativa). Devolve a igreja.
create or replace function public.attendance_check(p_session uuid, p_member uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  v_church uuid;
begin
  select s.church_id into v_church from public.attendance_sessions s where s.id = p_session;
  if v_church is null or not public.can_attendance(v_church) then
    raise exception 'Só a equipe da presença marca a presença.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.members m where m.id = p_member and m.church_id = v_church and m.status = 'ativo') then
    raise exception 'Essa pessoa não está no cadastro de membros ativos.' using errcode = '42501';
  end if;
  return v_church;
end $$;
revoke execute on function public.attendance_check(uuid, uuid) from public, anon, authenticated;

-- Marca pela lista (tocando no nome). Já marcado: fica como estava.
create or replace function public.attendance_mark(p_session uuid, p_member uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid := public.attendance_check(p_session, p_member);
begin
  insert into public.attendance (session_id, member_id, church_id, method)
  values (p_session, p_member, v_church, 'lista')
  on conflict do nothing;
end $$;

-- Desmarca (tocou por engano). Vale para qualquer forma de marcar.
create or replace function public.attendance_unmark(p_session uuid, p_member uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid;
begin
  select s.church_id into v_church from public.attendance_sessions s where s.id = p_session;
  if v_church is null or not public.can_attendance(v_church) then
    raise exception 'Só a equipe da presença desmarca.' using errcode = '42501';
  end if;
  delete from public.attendance where session_id = p_session and member_id = p_member;
end $$;

-- Marca pelo QR Code da carteirinha (o código secreto, nunca o número do cadastro).
-- Devolve o nome e se a pessoa já estava marcada.
create or replace function public.attendance_mark_card(p_session uuid, p_token uuid)
returns table (member_id uuid, name text, already boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_church uuid;
  v_member uuid;
  v_name text;
  v_rows integer;
begin
  select s.church_id into v_church from public.attendance_sessions s where s.id = p_session;
  if v_church is null or not public.can_attendance(v_church) then
    raise exception 'Só a equipe da presença marca a presença.' using errcode = '42501';
  end if;
  select m.id, m.name into v_member, v_name from public.members m
   where m.card_token = p_token and m.church_id = v_church and m.status = 'ativo';
  if v_member is null then
    raise exception 'Carteirinha não reconhecida nesta igreja. Peça para abrir a carteirinha no app (o QR Code pode ter sido trocado).';
  end if;
  insert into public.attendance (session_id, member_id, church_id, method)
  values (p_session, v_member, v_church, 'qr')
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  return query select v_member, v_name, v_rows = 0;
end $$;

revoke execute on function public.attendance_open(uuid, text, date, uuid) from public, anon;
revoke execute on function public.attendance_sessions_list(uuid, date) from public, anon;
revoke execute on function public.attendance_roster(uuid) from public, anon;
revoke execute on function public.attendance_mark(uuid, uuid) from public, anon;
revoke execute on function public.attendance_unmark(uuid, uuid) from public, anon;
revoke execute on function public.attendance_mark_card(uuid, uuid) from public, anon;
grant execute on function public.attendance_open(uuid, text, date, uuid) to authenticated;
grant execute on function public.attendance_sessions_list(uuid, date) to authenticated;
grant execute on function public.attendance_roster(uuid) to authenticated;
grant execute on function public.attendance_mark(uuid, uuid) to authenticated;
grant execute on function public.attendance_unmark(uuid, uuid) to authenticated;
grant execute on function public.attendance_mark_card(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Relatório (só totais), para a tela Relatórios
-- ---------------------------------------------------------------------
create or replace function public.attendance_report(p_church uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_leader(p_church) then
    raise exception 'Só a liderança da igreja vê os relatórios.' using errcode = '42501';
  end if;
  if not public.attendance_on(p_church)
     or not coalesce((select (c.features->>'relatorios')::boolean from public.churches c where c.id = p_church), false) then
    raise exception 'A presença ou os relatórios estão desligados nesta igreja.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Período inválido (até 400 dias).';
  end if;
  return (
    with ss as (select * from public.attendance_sessions s where s.church_id = p_church and s.session_date between p_from and p_to),
    pr as (select a.* from public.attendance a join ss on ss.id = a.session_id),
    por as (select ss.id, ss.title, ss.session_date, count(pr.member_id) n
            from ss left join pr on pr.session_id = ss.id group by ss.id, ss.title, ss.session_date)
    select jsonb_build_object(
      'cultos', (select count(*) from ss),
      'presencas', (select count(*) from pr),
      'pessoas_diferentes', (select count(distinct member_id) from pr),
      'media_por_culto', (select round(avg(n), 1) from por),
      'maior_culto', (select jsonb_build_object('dia', session_date, 'titulo', title, 'total', n) from por order by n desc, session_date desc limit 1),
      'por_forma', jsonb_build_object(
        'lista', (select count(*) from pr where method = 'lista'),
        'qr', (select count(*) from pr where method = 'qr'),
        'camera', (select count(*) from pr where method = 'camera')),
      'por_culto', coalesce((select jsonb_agg(jsonb_build_object('dia', session_date, 'titulo', title, 'total', n) order by session_date, title) from por), '[]'::jsonb))
  );
end $$;
revoke execute on function public.attendance_report(uuid, date, date) from public, anon;
grant execute on function public.attendance_report(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Os próprios dados: as presenças nos cultos
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
          'mostra_telefone_aos_membros', m.show_phone,
          'membro_desde', m.member_since,
          'qr_da_carteirinha_gerado_em', m.card_token_at),
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
        'presencas_nos_cultos', coalesce((
          select jsonb_agg(jsonb_build_object(
            'dia', s.session_date,
            'culto', s.title,
            'marcada_por', case a.method when 'lista' then 'lista' when 'qr' then 'QR Code da carteirinha' else 'câmera' end,
            'marcada_em', a.marked_at) order by s.session_date desc)
          from public.attendance a join public.attendance_sessions s on s.id = a.session_id
          where a.member_id = m.id), '[]'::jsonb),
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
    'filhos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'igreja', ch.name, 'nome', c.name, 'nascimento', c.birth_date, 'alergias_e_cuidados', c.care_notes,
        'autorizado_em', c.consent_at,
        'entradas_no_infantil', coalesce((
          select jsonb_agg(jsonb_build_object('dia', k.checkin_date, 'sala', k.room_name, 'entrada', k.checked_in_at,
                                              'retirada', k.checked_out_at) order by k.checked_in_at desc)
          from public.kids_checkins k where k.child_id = c.id), '[]'::jsonb)) order by c.name)
      from public.children c
      join public.members m on m.id = c.guardian_member_id
      join public.churches ch on ch.id = c.church_id
      where m.user_id = v_user), '[]'::jsonb),
    'pedidos_para_tirar_fotos_da_galeria', coalesce((
      select jsonb_agg(jsonb_build_object('motivo', r.reason, 'pedido_em', r.created_at) order by r.created_at desc)
      from public.gallery_removal_requests r where r.user_id = v_user), '[]'::jsonb),
    'conversas_do_chat', coalesce((
      select jsonb_agg(jsonb_build_object(
        'igreja', ch.name,
        'com', case when c.user_a = v_user then c.name_b else c.name_a end,
        'iniciada_em', c.created_at,
        'bloqueada', c.blocked_by is not null,
        'mensagens', coalesce((
          select jsonb_agg(jsonb_build_object('de', case when m.sender_id = v_user then 'você'
                                                         else case when c.user_a = v_user then c.name_b else c.name_a end end,
                                              'texto', m.body, 'em', m.created_at) order by m.created_at)
          from public.messages m where m.conversation_id = c.id), '[]'::jsonb)) order by c.created_at)
      from public.conversations c join public.churches ch on ch.id = c.church_id
      where v_user in (c.user_a, c.user_b)), '[]'::jsonb),
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
      'albuns_da_galeria', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'album', g.title, 'data', g.album_date, 'criado_em', g.created_at))
        from public.gallery_albums g join public.churches c on c.id = g.church_id where g.created_by = v_user), '[]'::jsonb),
      'fotos_enviadas', (select count(*) from public.gallery_photos p where p.created_by = v_user),
      'escalas_montadas', (select count(*) from public.schedules s where s.created_by = v_user),
      'listas_de_presenca_abertas', (select count(*) from public.attendance_sessions s where s.created_by = v_user),
      'cadastros_feitos', (select count(*) from public.members x where x.created_by = v_user))
  );
end $$;

-- ---------------------------------------------------------------------
-- 7. Dados de teste: as igrejas de teste ligam a presença
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"presenca": true}'::jsonb
where slug in ('teste-a', 'teste-b');
