-- =====================================================================
-- Igreja Conecta — galeria de fotos (Fase 3)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - Álbuns de fotos, vistos só pelos membros da igreja (pasta privada)
-- - Publicam: a liderança e o ministério marcado "Publica fotos na galeria"
-- - Limite de 300 fotos por igreja, conferido no banco; cada arquivo até
--   400 KB (o app reduz as fotos no aparelho, com uma miniatura para a grade)
-- - Só dá para enviar o arquivo de uma foto que o banco registrou antes
--   (gallery_add_photo): o limite não é contornado pelo app
-- - "Pedir para tirar esta foto": avisa quem publica
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Funcionalidade, tipo de notificação, limite e a equipe que publica
-- ---------------------------------------------------------------------
create or replace function public.gallery_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'galeria')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.gallery_on(uuid) from public, anon;
grant execute on function public.gallery_on(uuid) to authenticated;

create or replace function public.gallery_limit()
returns integer language sql immutable as $$ select 300 $$;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'oracao', 'visitante',
                  'devocional', 'leitura', 'escala', 'inscricao', 'infantil', 'galeria'));

alter table public.ministries add column if not exists gallery_publish boolean not null default false;
create unique index if not exists ministries_gallery_idx on public.ministries (church_id) where gallery_publish;
grant update (gallery_publish) on public.ministries to authenticated;

create or replace function public.my_gallery_churches()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select mi.church_id
  from public.ministries mi
  join public.ministry_members mm on mm.ministry_id = mi.id
  join public.members m on m.id = mm.member_id
  where mi.gallery_publish and mi.active and public.ministries_on(mi.church_id)
    and m.church_id = mi.church_id and m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
$$;

-- Publica na galeria: a liderança ou a equipe marcada, com a funcionalidade ligada.
create or replace function public.can_gallery(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.gallery_on(p_church)
     and (public.is_leader(p_church) or p_church in (select public.my_gallery_churches()))
$$;

-- Campo calculado do cadastro (members.gallery_team): o app mostra os botões de publicar.
create or replace function public.gallery_team(m public.members)
returns boolean language sql stable security definer set search_path = '' as $$
  select m.user_id = auth.uid() and m.church_id in (select public.my_gallery_churches())
$$;

revoke execute on function public.my_gallery_churches() from public, anon;
revoke execute on function public.can_gallery(uuid) from public, anon;
revoke execute on function public.gallery_team(public.members) from public, anon;
grant execute on function public.my_gallery_churches() to authenticated;
grant execute on function public.can_gallery(uuid) to authenticated;
grant execute on function public.gallery_team(public.members) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.gallery_albums (
  id             uuid primary key default gen_random_uuid(),
  church_id      uuid not null references public.churches on delete cascade,
  title          text not null check (char_length(title) between 2 and 80),
  album_date     date not null default public.today_br(),
  description    text check (char_length(description) <= 500),
  cover_photo_id uuid,
  created_by     uuid default auth.uid() references auth.users on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists gallery_albums_church_idx on public.gallery_albums (church_id, album_date desc);

create table if not exists public.gallery_photos (
  id         uuid primary key default gen_random_uuid(),
  church_id  uuid not null references public.churches on delete cascade,
  album_id   uuid not null references public.gallery_albums on delete cascade,
  path       text not null unique,
  mini_path  text not null unique,
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists gallery_photos_album_idx on public.gallery_photos (album_id, created_at);
create index if not exists gallery_photos_church_idx on public.gallery_photos (church_id);

alter table public.gallery_albums drop constraint if exists gallery_albums_cover_fk;
alter table public.gallery_albums add constraint gallery_albums_cover_fk
  foreign key (cover_photo_id) references public.gallery_photos on delete set null;

create table if not exists public.gallery_removal_requests (
  photo_id   uuid not null references public.gallery_photos on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  reason     text check (char_length(reason) <= 300),
  created_at timestamptz not null default now(),
  primary key (photo_id, user_id)
);

-- ---------------------------------------------------------------------
-- 3. Regras de acesso
-- ---------------------------------------------------------------------
alter table public.gallery_albums enable row level security;
drop policy if exists "albuns le" on public.gallery_albums;
create policy "albuns le" on public.gallery_albums for select to authenticated
  using (church_id in (select public.my_church_ids()) and public.gallery_on(church_id));
drop policy if exists "albuns cria" on public.gallery_albums;
create policy "albuns cria" on public.gallery_albums for insert to authenticated
  with check (public.can_gallery(church_id));
drop policy if exists "albuns edita" on public.gallery_albums;
create policy "albuns edita" on public.gallery_albums for update to authenticated
  using (public.can_gallery(church_id)) with check (public.can_gallery(church_id));
drop policy if exists "albuns apaga" on public.gallery_albums;
create policy "albuns apaga" on public.gallery_albums for delete to authenticated
  using (public.can_gallery(church_id));
revoke all on public.gallery_albums from anon;
revoke update on public.gallery_albums from authenticated;
grant update (title, album_date, description, cover_photo_id) on public.gallery_albums to authenticated;

-- A capa precisa ser uma foto do próprio álbum.
create or replace function public.gallery_albums_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.cover_photo_id is not null
     and not exists (select 1 from public.gallery_photos p where p.id = new.cover_photo_id and p.album_id = new.id) then
    raise exception 'A capa precisa ser uma foto deste álbum.';
  end if;
  return new;
end $$;
drop trigger if exists gallery_albums_guard on public.gallery_albums;
create trigger gallery_albums_guard before update of cover_photo_id on public.gallery_albums
  for each row execute function public.gallery_albums_guard();
revoke execute on function public.gallery_albums_guard() from public, anon, authenticated;

-- Fotos: os membros veem; quem publica apaga. Registrar, só por gallery_add_photo.
alter table public.gallery_photos enable row level security;
drop policy if exists "fotos le" on public.gallery_photos;
create policy "fotos le" on public.gallery_photos for select to authenticated
  using (church_id in (select public.my_church_ids()) and public.gallery_on(church_id));
drop policy if exists "fotos apaga" on public.gallery_photos;
create policy "fotos apaga" on public.gallery_photos for delete to authenticated
  using (public.can_gallery(church_id));
revoke all on public.gallery_photos from anon;
revoke insert, update on public.gallery_photos from authenticated;

-- Pedidos de retirada: cada um lê os próprios; gravar, só pela função.
alter table public.gallery_removal_requests enable row level security;
drop policy if exists "pedidos de retirada le" on public.gallery_removal_requests;
create policy "pedidos de retirada le" on public.gallery_removal_requests for select to authenticated
  using (user_id = auth.uid());
revoke all on public.gallery_removal_requests from anon;
revoke insert, update, delete on public.gallery_removal_requests from authenticated;

-- ---------------------------------------------------------------------
-- 4. Arquivos: pasta privada "galeria", em <igreja>/<álbum>/<foto>.webp
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('galeria', 'galeria', false, 409600, array['image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 409600, allowed_mime_types = array['image/jpeg', 'image/webp'];

drop policy if exists "galeria membros veem" on storage.objects;
create policy "galeria membros veem" on storage.objects for select to authenticated
  using (bucket_id = 'galeria' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids() as id)
         and exists (select 1 from public.gallery_photos p where (p.path = name or p.mini_path = name) and public.gallery_on(p.church_id)));
-- Só o arquivo de uma foto já registrada (e por quem publica).
drop policy if exists "galeria equipe envia" on storage.objects;
create policy "galeria equipe envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'galeria'
              and exists (select 1 from public.gallery_photos p
                          where (p.path = name or p.mini_path = name) and public.can_gallery(p.church_id)));
drop policy if exists "galeria equipe apaga" on storage.objects;
create policy "galeria equipe apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'galeria'
         and (storage.foldername(name))[1] in (select c.id::text from public.churches c where public.can_gallery(c.id)));

-- ---------------------------------------------------------------------
-- 5. Funções das telas
-- ---------------------------------------------------------------------
-- Álbuns com a quantidade de fotos e a miniatura da capa (a escolhida ou a primeira).
create or replace function public.gallery_album_list(p_church uuid)
returns table (id uuid, title text, album_date date, description text, photos integer, cover_mini text, cover_photo_id uuid)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.is_member(p_church) or not public.gallery_on(p_church) then
    return;
  end if;
  return query
  select a.id, a.title, a.album_date, a.description,
         (select count(*)::integer from public.gallery_photos p where p.album_id = a.id),
         coalesce((select p.mini_path from public.gallery_photos p where p.id = a.cover_photo_id),
                  (select p.mini_path from public.gallery_photos p where p.album_id = a.id order by p.created_at limit 1)),
         a.cover_photo_id
  from public.gallery_albums a
  where a.church_id = p_church
  order by a.album_date desc, a.created_at desc;
end $$;

-- Registra uma foto nova (antes de enviar o arquivo) e devolve os caminhos. Confere o limite.
create or replace function public.gallery_add_photo(p_album uuid, p_ext text)
returns table (photo_id uuid, path text, mini_path text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  a public.gallery_albums;
  v_id uuid := gen_random_uuid();
  v_ext text := case when p_ext = 'jpg' then 'jpg' else 'webp' end;
  v_dir text;
begin
  select * into a from public.gallery_albums where id = p_album;
  if a.id is null or not public.can_gallery(a.church_id) then
    raise exception 'Só quem publica na galeria envia fotos.' using errcode = '42501';
  end if;
  -- Uma foto por vez em cada igreja, para o limite valer mesmo com envios ao mesmo tempo.
  perform pg_advisory_xact_lock(hashtext('galeria:' || a.church_id::text));
  if (select count(*) from public.gallery_photos p where p.church_id = a.church_id) >= public.gallery_limit() then
    raise exception 'A galeria chegou ao limite de % fotos. Apague álbuns antigos para enviar novas.', public.gallery_limit();
  end if;
  v_dir := a.church_id || '/' || a.id || '/';
  insert into public.gallery_photos (id, church_id, album_id, path, mini_path)
  values (v_id, a.church_id, a.id, v_dir || v_id || '.' || v_ext, v_dir || v_id || '-mini.' || v_ext);
  return query select v_id, v_dir || v_id || '.' || v_ext, v_dir || v_id || '-mini.' || v_ext;
end $$;

-- "Pedir para tirar esta foto": avisa quem publica (uma vez por pessoa e foto).
create or replace function public.gallery_request_removal(p_photo uuid, p_reason text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  p public.gallery_photos;
  v_title text;
begin
  select * into p from public.gallery_photos where id = p_photo;
  if p.id is null or not public.is_member(p.church_id) or not public.gallery_on(p.church_id) then
    raise exception 'Foto não encontrada.' using errcode = '42501';
  end if;
  insert into public.gallery_removal_requests (photo_id, user_id, reason)
  values (p_photo, auth.uid(), nullif(trim(left(p_reason, 300)), ''))
  on conflict do nothing;
  if not found then
    return false;
  end if;
  select a.title into v_title from public.gallery_albums a where a.id = p.album_id;
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select d.user_id, p.church_id, 'galeria', 'Pedido para tirar uma foto',
         'Álbum "' || v_title || '"' || coalesce(' · ' || nullif(trim(left(p_reason, 120)), ''), ''),
         '#/galeria/' || p.album_id || '/foto/' || p.id, 'galeria-retirada:' || p.id || ':' || auth.uid(), true
  from (
    select m.user_id from public.members m
    where m.church_id = p.church_id and m.role in ('admin', 'secretaria', 'lider')
      and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
    union
    select m.user_id from public.ministries mi
    join public.ministry_members mm on mm.ministry_id = mi.id
    join public.members m on m.id = mm.member_id
    where mi.church_id = p.church_id and mi.gallery_publish and mi.active and public.ministries_on(p.church_id)
      and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
  ) d
  where d.user_id <> auth.uid()
  on conflict do nothing;
  return true;
end $$;

revoke execute on function public.gallery_album_list(uuid) from public, anon;
revoke execute on function public.gallery_add_photo(uuid, text) from public, anon;
revoke execute on function public.gallery_request_removal(uuid, text) from public, anon;
grant execute on function public.gallery_album_list(uuid) to authenticated;
grant execute on function public.gallery_add_photo(uuid, text) to authenticated;
grant execute on function public.gallery_request_removal(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Os próprios dados: álbuns publicados e pedidos de retirada
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
    'pedidos_para_tirar_fotos_da_galeria', coalesce((
      select jsonb_agg(jsonb_build_object('motivo', r.reason, 'pedido_em', r.created_at) order by r.created_at desc)
      from public.gallery_removal_requests r where r.user_id = v_user), '[]'::jsonb),
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
      'cadastros_feitos', (select count(*) from public.members x where x.created_by = v_user))
  );
end $$;

-- ---------------------------------------------------------------------
-- 7. Dados de teste: as igrejas de teste ligam a galeria
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"galeria": true}'::jsonb
where slug in ('teste-a', 'teste-b');
