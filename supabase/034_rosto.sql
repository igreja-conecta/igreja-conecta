-- =====================================================================
-- Igreja Conecta — presença nos cultos, entrega 2: cadastro do rosto (biometria)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- Dado biométrico é dado pessoal sensível (LGPD, art. 11):
-- - Só com o consentimento da própria pessoa, guardado com a versão do termo
-- - Quem cadastra: o próprio membro (no celular dele) ou a secretaria/administrador,
--   com a pessoa presente tocando em "Eu autorizo"; o membro com o app recebe um aviso
-- - Só maiores de 18 anos (crianças ficam de fora)
-- - Nenhuma foto é guardada: só a "assinatura numérica" do rosto (128 números),
--   calculada no aparelho. Ninguém lê essa tabela, nem a liderança: só as funções do banco
-- - Apagar: o próprio membro ou a secretaria/administrador, a qualquer momento.
--   Sair da igreja, excluir a conta ou desligar o reconhecimento facial apagam tudo
-- =====================================================================

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Funcionalidade: "presenca_facial", que precisa da presença ligada
-- ---------------------------------------------------------------------
create or replace function public.face_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'presenca')::boolean and (c.features->>'presenca_facial')::boolean
                   from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.face_on(uuid) from public, anon;
grant execute on function public.face_on(uuid) to authenticated;

-- Quem cadastra o rosto dos outros: a secretaria e o administrador.
create or replace function public.can_enroll_faces(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.face_on(p_church) and public.has_role(p_church, 'admin', 'secretaria')
$$;
revoke execute on function public.can_enroll_faces(uuid) from public, anon;
grant execute on function public.can_enroll_faces(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Tabelas (fechadas: só as funções da seção 3 leem e gravam)
-- ---------------------------------------------------------------------
create table if not exists public.face_consents (
  id               uuid primary key default gen_random_uuid(),
  member_id        uuid not null references public.members on delete cascade,
  church_id        uuid not null references public.churches on delete cascade,
  term_version     text not null check (char_length(term_version) between 1 and 20),
  via              text not null check (via in ('proprio', 'secretaria')),
  adult_confirmed  boolean not null default false,  -- sem data de nascimento: quem cadastrou confirmou 18+
  recorded_by      uuid default auth.uid() references auth.users on delete set null,
  accepted_at      timestamptz not null default now(),
  revoked_at       timestamptz
);
create index if not exists face_consents_member_idx on public.face_consents (member_id);

create table if not exists public.face_templates (
  member_id   uuid primary key references public.members on delete cascade,
  church_id   uuid not null references public.churches on delete cascade,
  embedding   extensions.vector(128) not null,
  samples     smallint not null check (samples between 3 and 10),
  model       text not null check (char_length(model) between 1 and 40),
  consent_id  uuid not null references public.face_consents on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists face_templates_church_idx on public.face_templates (church_id);

alter table public.face_consents enable row level security;
alter table public.face_templates enable row level security;
revoke all on public.face_consents from anon, authenticated;
revoke all on public.face_templates from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Funções das telas
-- ---------------------------------------------------------------------
-- Quem pode mexer no rosto desta pessoa: ela mesma ou a secretaria/administrador.
-- Devolve 'proprio' ou 'secretaria'; se ninguém, erro.
create or replace function public.face_actor(p_member uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_church uuid;
begin
  select m.church_id into v_church from public.members m where m.id = p_member and m.status = 'ativo';
  if v_church is null or not public.face_on(v_church) then
    raise exception 'O reconhecimento facial não está ligado para este cadastro.' using errcode = '42501';
  end if;
  if p_member = public.my_member_id(v_church) then
    return 'proprio';
  end if;
  if public.can_enroll_faces(v_church) then
    return 'secretaria';
  end if;
  raise exception 'Só a própria pessoa ou a secretaria cadastra o rosto.' using errcode = '42501';
end $$;
revoke execute on function public.face_actor(uuid) from public, anon, authenticated;

-- Situação do cadastro facial (sem a assinatura do rosto).
create or replace function public.face_status(p_member uuid)
returns table (registered boolean, registered_at timestamptz, via text, term_version text, needs_adult boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.face_actor(p_member);
  return query
  select t.member_id is not null, t.created_at, c.via, c.term_version, m.birth_date is null
  from public.members m
  left join public.face_templates t on t.member_id = m.id
  left join public.face_consents c on c.id = t.consent_id
  where m.id = p_member;
end $$;

-- Grava (ou troca) o rosto com o consentimento. p_embedding: a média das capturas, 128 números.
create or replace function public.face_save(p_member uuid, p_embedding real[], p_samples integer, p_model text,
                                            p_term_version text, p_adult_confirmed boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_via text := public.face_actor(p_member);
  m public.members;
  v_consent uuid;
begin
  select * into m from public.members where id = p_member;
  -- Crianças ficam de fora.
  if m.birth_date is not null then
    if extract(year from age(public.today_br(), m.birth_date)) < 18 then
      raise exception 'O reconhecimento facial é só para maiores de 18 anos.' using errcode = '42501';
    end if;
  elsif not coalesce(p_adult_confirmed, false) then
    raise exception 'Confirme que a pessoa tem 18 anos ou mais.' using errcode = '42501';
  end if;
  if p_embedding is null or array_length(p_embedding, 1) is distinct from 128
     or exists (select 1 from unnest(p_embedding) x where x is null or x = 'NaN'::real or abs(x) > 5) then
    raise exception 'Assinatura do rosto inválida. Tente cadastrar de novo.';
  end if;
  if p_samples is null or p_samples not between 3 and 10 then
    raise exception 'Faltam fotos do rosto. Tente cadastrar de novo.';
  end if;
  if p_term_version is null or char_length(p_term_version) not between 1 and 20 then
    raise exception 'Mostre o termo de consentimento antes de cadastrar.';
  end if;

  -- O consentimento anterior (se houver) é substituído pelo novo.
  update public.face_consents set revoked_at = now() where member_id = p_member and revoked_at is null;
  insert into public.face_consents (member_id, church_id, term_version, via, adult_confirmed)
  values (p_member, m.church_id, p_term_version, v_via, m.birth_date is null and coalesce(p_adult_confirmed, false))
  returning id into v_consent;
  insert into public.face_templates (member_id, church_id, embedding, samples, model, consent_id)
  values (p_member, m.church_id, p_embedding::extensions.vector(128), p_samples, left(coalesce(p_model, '?'), 40), v_consent)
  on conflict (member_id) do update
    set embedding = excluded.embedding, samples = excluded.samples, model = excluded.model,
        consent_id = excluded.consent_id, created_at = now();

  -- Transparência: quem tem o app fica sabendo que a secretaria cadastrou o rosto.
  if v_via = 'secretaria' and m.user_id is not null and m.consent_at is not null then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    values (m.user_id, m.church_id, 'sistema', 'Seu rosto foi cadastrado',
            'A secretaria cadastrou o seu rosto para a presença nos cultos, com a sua autorização. Para ver ou apagar, abra Meu rosto.',
            '#/rosto', 'rosto:' || p_member || ':' || extract(epoch from clock_timestamp())::text, true)
    on conflict do nothing;
  end if;
end $$;

-- Apaga o rosto e encerra o consentimento.
create or replace function public.face_delete(p_member uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_via text := public.face_actor(p_member);
  m public.members;
begin
  select * into m from public.members where id = p_member;
  delete from public.face_templates where member_id = p_member;
  update public.face_consents set revoked_at = now() where member_id = p_member and revoked_at is null;
  if v_via = 'secretaria' and m.user_id is not null and m.consent_at is not null then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    values (m.user_id, m.church_id, 'sistema', 'Seu cadastro facial foi apagado',
            'A secretaria apagou o seu cadastro facial. A presença nos cultos continua pela lista ou pela carteirinha.',
            '#/rosto', 'rosto:' || p_member || ':' || extract(epoch from clock_timestamp())::text, true)
    on conflict do nothing;
  end if;
end $$;

revoke execute on function public.face_status(uuid) from public, anon;
revoke execute on function public.face_save(uuid, real[], integer, text, text, boolean) from public, anon;
revoke execute on function public.face_delete(uuid) from public, anon;
grant execute on function public.face_status(uuid) to authenticated;
grant execute on function public.face_save(uuid, real[], integer, text, text, boolean) to authenticated;
grant execute on function public.face_delete(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Desligar o reconhecimento facial (ou a presença) apaga todos os rostos da igreja
-- ---------------------------------------------------------------------
create or replace function public.churches_face_off()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((old.features->>'presenca')::boolean and (old.features->>'presenca_facial')::boolean, false)
     and not coalesce((new.features->>'presenca')::boolean and (new.features->>'presenca_facial')::boolean, false) then
    delete from public.face_templates where church_id = new.id;
    update public.face_consents set revoked_at = now() where church_id = new.id and revoked_at is null;
  end if;
  return new;
end $$;
drop trigger if exists churches_face_off on public.churches;
create trigger churches_face_off after update of features on public.churches
  for each row execute function public.churches_face_off();
revoke execute on function public.churches_face_off() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Os próprios dados: se há cadastro facial e as autorizações (a assinatura do rosto
--    não sai: são só números para a comparação no culto)
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
        'cadastro_facial', jsonb_build_object(
          'cadastrado', exists (select 1 from public.face_templates t where t.member_id = m.id),
          'cadastrado_em', (select t.created_at from public.face_templates t where t.member_id = m.id),
          'autorizacoes', coalesce((
            select jsonb_agg(jsonb_build_object(
              'versao_do_termo', f.term_version,
              'autorizado_em', f.accepted_at,
              'cadastrado_por', case f.via when 'proprio' then 'você' else 'secretaria' end,
              'encerrada_em', f.revoked_at) order by f.accepted_at desc)
            from public.face_consents f where f.member_id = m.id), '[]'::jsonb),
          'observacao', 'Nenhuma foto é guardada. A assinatura numérica do rosto (128 números) só serve para a comparação no culto e não sai do banco.'),
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
-- 6. Dados de teste: as igrejas de teste ligam o reconhecimento facial
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"presenca_facial": true}'::jsonb
where slug in ('teste-a', 'teste-b');
