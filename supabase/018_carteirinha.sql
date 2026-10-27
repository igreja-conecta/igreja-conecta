-- =====================================================================
-- Igreja Conecta — carteirinha digital de membro (Fase 3)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - Cada membro vê a própria carteirinha (nome, foto, papel, membro desde,
--   batismo) com um QR Code de conferência
-- - O QR leva a uma página pública que confirma se o cadastro está ativo,
--   pelo código secreto da carteirinha (nunca pelo número do cadastro).
--   Ela mostra só o que está na carteirinha: sem foto, telefone, e-mail ou aniversário
-- - A pessoa gera um QR novo quando quiser (o antigo deixa de valer)
-- - "Membro desde": só a liderança preenche
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Cadastro: código da carteirinha e "membro desde"
-- ---------------------------------------------------------------------
alter table public.members add column if not exists member_since date check (member_since > '1900-01-01');
alter table public.members add column if not exists card_token uuid not null default gen_random_uuid();
alter table public.members add column if not exists card_token_at timestamptz not null default now();
create unique index if not exists members_card_token_idx on public.members (card_token);
grant update (member_since) on public.members to authenticated;

-- A pessoa edita o próprio cadastro, mas "membro desde" é da liderança.
create or replace function public.members_since_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.member_since is distinct from old.member_since and auth.uid() is not null
     and not public.is_leader(new.church_id) then
    raise exception 'Só a liderança da igreja muda "membro desde".' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists members_since_guard on public.members;
create trigger members_since_guard before update of member_since on public.members
  for each row execute function public.members_since_guard();
revoke execute on function public.members_since_guard() from public, anon, authenticated;

create or replace function public.cards_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'carteirinha')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.cards_on(uuid) from public, anon;
grant execute on function public.cards_on(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Gerar um QR Code novo (o antigo deixa de valer)
-- ---------------------------------------------------------------------
create or replace function public.rotate_card_token(p_church uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_token uuid;
begin
  update public.members
     set card_token = gen_random_uuid(), card_token_at = now()
   where church_id = p_church and user_id = auth.uid() and status = 'ativo' and consent_at is not null
     and public.cards_on(p_church)
  returning card_token into v_token;
  if v_token is null then
    raise exception 'Carteirinha não encontrada.' using errcode = '42501';
  end if;
  return v_token;
end $$;
revoke execute on function public.rotate_card_token(uuid) from public, anon;
grant execute on function public.rotate_card_token(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Conferência pública (sem login), só pelo código exato
-- ---------------------------------------------------------------------
create or replace function public.verify_member_card(p_token uuid)
returns table (church_name text, church_slug text, logo_url text, primary_color text,
               name text, role text, member_since date, active boolean)
language sql stable security definer set search_path = '' as $$
  select c.name, c.slug, c.logo_url, c.primary_color, m.name, m.role, m.member_since,
         m.status = 'ativo' and m.consent_at is not null
  from public.members m
  join public.churches c on c.id = m.church_id
  where m.card_token = p_token and c.active and public.cards_on(c.id)
$$;
revoke execute on function public.verify_member_card(uuid) from public;
grant execute on function public.verify_member_card(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Os próprios dados: "membro desde" e quando o QR foi gerado
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
-- 5. Dados de teste: as igrejas de teste ligam a carteirinha
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"carteirinha": true}'::jsonb
where slug in ('teste-a', 'teste-b');
