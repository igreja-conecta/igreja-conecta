-- =====================================================================
-- Igreja Conecta — células e pequenos grupos (Fase 3)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - A liderança (administrador, secretaria e líderes) cria as células,
--   escolhe quem lidera (qualquer pessoa do cadastro) e os participantes
-- - O líder e o auxiliar da célula registram os encontros e a presença,
--   e colocam ou tiram participantes (a partir do cadastro)
-- - O participante vê a célula, o líder e os outros participantes (nome e
--   foto; telefone só de quem autorizou), mas não a presença dos outros
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.cells (
  id          uuid primary key default gen_random_uuid(),
  church_id   uuid not null references public.churches on delete cascade,
  name        text not null check (char_length(name) between 2 and 80),
  weekday     smallint check (weekday between 0 and 6),          -- 0 = domingo
  meets_at    time,
  location    text check (char_length(location) <= 200),
  description text check (char_length(description) <= 1000),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists cells_church_idx on public.cells (church_id, name);

create table if not exists public.cell_members (
  cell_id   uuid not null references public.cells on delete cascade,
  member_id uuid not null references public.members on delete cascade,
  role      text not null default 'participante' check (role in ('lider', 'auxiliar', 'participante')),
  added_at  timestamptz not null default now(),
  primary key (cell_id, member_id)
);
create index if not exists cell_members_member_idx on public.cell_members (member_id);

create table if not exists public.cell_meetings (
  id           uuid primary key default gen_random_uuid(),
  cell_id      uuid not null references public.cells on delete cascade,
  meeting_date date not null,
  topic        text check (char_length(topic) <= 120),
  notes        text check (char_length(notes) <= 1000),
  visitors     integer not null default 0 check (visitors between 0 and 200),
  created_by   uuid default auth.uid() references auth.users on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (cell_id, meeting_date)
);

-- Uma linha por pessoa presente (quem é da célula e não tem linha, faltou).
create table if not exists public.cell_attendance (
  meeting_id uuid not null references public.cell_meetings on delete cascade,
  member_id  uuid not null references public.members on delete cascade,
  primary key (meeting_id, member_id)
);
create index if not exists cell_attendance_member_idx on public.cell_attendance (member_id);

-- ---------------------------------------------------------------------
-- 2. Funções das regras de acesso
-- ---------------------------------------------------------------------
create or replace function public.cells_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'celulas')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;

-- Células de que a pessoa participa (p_lead: só as que ela lidera, como líder ou auxiliar).
create or replace function public.my_cell_ids(p_lead boolean default false)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select cm.cell_id
  from public.cell_members cm
  join public.members m on m.id = cm.member_id
  join public.cells c on c.id = cm.cell_id
  where m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
    and m.church_id = c.church_id and c.active
    and public.cells_on(c.church_id)
    and (not p_lead or cm.role in ('lider', 'auxiliar'))
$$;

-- Pode cuidar da célula: a liderança da igreja ou quem lidera a própria célula.
create or replace function public.can_manage_cell(p_cell uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.cells c where c.id = p_cell and public.is_leader(c.church_id) and public.cells_on(c.church_id))
      or p_cell in (select public.my_cell_ids(true))
$$;

revoke execute on function public.cells_on(uuid) from public, anon;
revoke execute on function public.my_cell_ids(boolean) from public, anon;
revoke execute on function public.can_manage_cell(uuid) from public, anon;
grant execute on function public.cells_on(uuid) to authenticated;
grant execute on function public.my_cell_ids(boolean) to authenticated;
grant execute on function public.can_manage_cell(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Regras de acesso
-- ---------------------------------------------------------------------
alter table public.cells enable row level security;
drop policy if exists "celulas le" on public.cells;
create policy "celulas le" on public.cells for select to authenticated
  using ((church_id in (select public.my_church_ids('lideranca')) and public.cells_on(church_id))
         or id in (select public.my_cell_ids()));
drop policy if exists "celulas lideranca cria" on public.cells;
create policy "celulas lideranca cria" on public.cells for insert to authenticated
  with check (church_id in (select public.my_church_ids('lideranca')) and public.cells_on(church_id));
drop policy if exists "celulas lideranca edita" on public.cells;
create policy "celulas lideranca edita" on public.cells for update to authenticated
  using (church_id in (select public.my_church_ids('lideranca')))
  with check (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "celulas lideranca apaga" on public.cells;
create policy "celulas lideranca apaga" on public.cells for delete to authenticated
  using (church_id in (select public.my_church_ids('lideranca')));
revoke all on public.cells from anon;
revoke update on public.cells from authenticated;
grant update (name, weekday, meets_at, location, description, active, updated_at) on public.cells to authenticated;

-- Participantes: a liderança cuida de tudo; o líder da célula coloca e tira participantes
-- (os papéis de líder e auxiliar são escolhidos pela liderança).
alter table public.cell_members enable row level security;
drop policy if exists "celula membros le" on public.cell_members;
create policy "celula membros le" on public.cell_members for select to authenticated
  using (cell_id in (select c.id from public.cells c where c.church_id in (select public.my_church_ids('lideranca')))
         or cell_id in (select public.my_cell_ids()));
drop policy if exists "celula membros coloca" on public.cell_members;
create policy "celula membros coloca" on public.cell_members for insert to authenticated
  with check (public.can_manage_cell(cell_id));
drop policy if exists "celula membros muda" on public.cell_members;
create policy "celula membros muda" on public.cell_members for update to authenticated
  using (cell_id in (select c.id from public.cells c where c.church_id in (select public.my_church_ids('lideranca'))))
  with check (cell_id in (select c.id from public.cells c where c.church_id in (select public.my_church_ids('lideranca'))));
drop policy if exists "celula membros tira" on public.cell_members;
create policy "celula membros tira" on public.cell_members for delete to authenticated
  using (public.can_manage_cell(cell_id)
         and (role = 'participante' or cell_id in (select c.id from public.cells c where c.church_id in (select public.my_church_ids('lideranca')))));
revoke all on public.cell_members from anon;
revoke update on public.cell_members from authenticated;
grant update (role) on public.cell_members to authenticated;

create or replace function public.cell_members_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from public.cells c join public.members m on m.church_id = c.church_id
    where c.id = new.cell_id and m.id = new.member_id
  ) then
    raise exception 'A pessoa precisa ser do cadastro da mesma igreja.' using errcode = '42501';
  end if;
  if current_user in ('authenticated', 'anon') and new.role <> 'participante'
     and not exists (select 1 from public.cells c where c.id = new.cell_id and public.is_leader(c.church_id)) then
    raise exception 'Só a liderança da igreja escolhe o líder e o auxiliar da célula.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists cell_members_guard on public.cell_members;
create trigger cell_members_guard before insert or update on public.cell_members
  for each row execute function public.cell_members_guard();

-- Encontros e presença: só o líder da célula e a liderança (gravados por save_cell_meeting).
alter table public.cell_meetings enable row level security;
drop policy if exists "encontros le" on public.cell_meetings;
create policy "encontros le" on public.cell_meetings for select to authenticated
  using (public.can_manage_cell(cell_id));
drop policy if exists "encontros apaga" on public.cell_meetings;
create policy "encontros apaga" on public.cell_meetings for delete to authenticated
  using (public.can_manage_cell(cell_id));
revoke all on public.cell_meetings from anon;
revoke insert, update on public.cell_meetings from authenticated;

alter table public.cell_attendance enable row level security;
drop policy if exists "presenca le" on public.cell_attendance;
create policy "presenca le" on public.cell_attendance for select to authenticated
  using (meeting_id in (select e.id from public.cell_meetings e where public.can_manage_cell(e.cell_id)));
revoke all on public.cell_attendance from anon;
revoke insert, update, delete on public.cell_attendance from authenticated;

-- ---------------------------------------------------------------------
-- 4. Funções das telas
-- ---------------------------------------------------------------------
-- Participantes da célula. Telefone: para quem cuida da célula, ou de quem autorizou.
-- Faltas seguidas e última presença: só para quem cuida da célula.
create or replace function public.cell_roster(p_cell uuid)
returns table (member_id uuid, name text, photo_path text, phone text, role text, is_me boolean,
               misses integer, last_present date)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_manage boolean := public.can_manage_cell(p_cell);
begin
  if not v_manage and p_cell not in (select public.my_cell_ids()) then
    return;
  end if;
  return query
  select m.id, m.name, m.photo_path,
         case when v_manage or m.show_phone or m.user_id = auth.uid() then m.phone end,
         cm.role, coalesce(m.user_id = auth.uid(), false),
         case when v_manage then (
           select count(*)::integer from public.cell_meetings e
           where e.cell_id = p_cell and e.meeting_date >= (cm.added_at at time zone 'America/Sao_Paulo')::date
             and e.meeting_date > coalesce((select max(e2.meeting_date) from public.cell_meetings e2
                                             join public.cell_attendance a2 on a2.meeting_id = e2.id
                                             where e2.cell_id = p_cell and a2.member_id = m.id), '-infinity'::date)
         ) end,
         case when v_manage then (
           select max(e.meeting_date) from public.cell_meetings e
           join public.cell_attendance a on a.meeting_id = e.id
           where e.cell_id = p_cell and a.member_id = m.id
         ) end
  from public.cell_members cm
  join public.members m on m.id = cm.member_id
  where cm.cell_id = p_cell and m.status = 'ativo'
  order by case cm.role when 'lider' then 0 when 'auxiliar' then 1 else 2 end, m.name;
end $$;

-- Pessoas do cadastro que podem entrar na célula (só o nome), para quem cuida dela.
create or replace function public.cell_candidates(p_cell uuid, p_search text)
returns table (member_id uuid, name text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.can_manage_cell(p_cell) or char_length(trim(coalesce(p_search, ''))) < 2 then
    return;
  end if;
  return query
  select m.id, m.name
  from public.members m
  join public.cells c on c.id = p_cell and c.church_id = m.church_id
  where m.status = 'ativo'
    and public.unaccent_lower(m.name) like '%' || public.unaccent_lower(trim(p_search)) || '%'
    and not exists (select 1 from public.cell_members cm where cm.cell_id = p_cell and cm.member_id = m.id)
  order by m.name
  limit 20;
end $$;

-- Sem acento e em minúsculas, para a busca por nome.
create or replace function public.unaccent_lower(p text)
returns text language sql immutable set search_path = '' as $$
  select lower(translate(p, 'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
                            'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'))
$$;

-- Grava o encontro (novo ou corrigido) e a lista de presença de uma vez.
-- Só vale presença de quem é da célula.
create or replace function public.save_cell_meeting(p_cell uuid, p_date date, p_topic text, p_notes text,
                                                    p_visitors integer, p_present uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not public.can_manage_cell(p_cell) then
    raise exception 'Só o líder da célula e a liderança registram os encontros.' using errcode = '42501';
  end if;
  if p_date is null or p_date > public.today_br() + 1 or p_date < public.today_br() - 366 then
    raise exception 'Data do encontro inválida.';
  end if;
  insert into public.cell_meetings (cell_id, meeting_date, topic, notes, visitors)
  values (p_cell, p_date, nullif(trim(p_topic), ''), nullif(trim(p_notes), ''), coalesce(p_visitors, 0))
  on conflict (cell_id, meeting_date) do update
    set topic = excluded.topic, notes = excluded.notes, visitors = excluded.visitors, updated_at = now()
  returning id into v_id;
  delete from public.cell_attendance where meeting_id = v_id;
  insert into public.cell_attendance (meeting_id, member_id)
  select v_id, cm.member_id from public.cell_members cm
  where cm.cell_id = p_cell and cm.member_id = any (coalesce(p_present, '{}'));
  return v_id;
end $$;

revoke execute on function public.cell_roster(uuid) from public, anon;
revoke execute on function public.cell_candidates(uuid, text) from public, anon;
revoke execute on function public.save_cell_meeting(uuid, date, text, text, integer, uuid[]) from public, anon;
grant execute on function public.cell_roster(uuid) to authenticated;
grant execute on function public.cell_candidates(uuid, text) to authenticated;
grant execute on function public.save_cell_meeting(uuid, date, text, text, integer, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Os próprios dados: as células e as próprias presenças
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
      'cadastros_feitos', (select count(*) from public.members x where x.created_by = v_user))
  );
end $$;

-- ---------------------------------------------------------------------
-- 6. Dados de teste: as igrejas de teste ligam as células
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"celulas": true}'::jsonb
where slug in ('teste-a', 'teste-b');
