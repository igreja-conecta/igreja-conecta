-- =====================================================================
-- Igreja Conecta — check-in do ministério infantil (Fase 3)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - O responsável cadastra os filhos no app (com autorização, LGPD); a equipe
--   do infantil também cadastra na recepção, com o nome e o WhatsApp do responsável
-- - Equipe do infantil: o ministério marcado "Faz o check-in das crianças" (e a liderança)
-- - Entrada: o banco sorteia um código de retirada (4 letras e números, único
--   no dia); a equipe imprime a etiqueta; o responsável recebe o código no app
-- - Retirada: só com o código certo; o responsável recebe o aviso
-- - Os dados das crianças: só o responsável, a equipe do infantil e a liderança
-- - O histórico de entradas e retiradas é apagado depois de 12 meses
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Funcionalidade, tipo de notificação e a equipe
-- ---------------------------------------------------------------------
create or replace function public.kids_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'infantil')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.kids_on(uuid) from public, anon;
grant execute on function public.kids_on(uuid) to authenticated;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'oracao', 'visitante',
                  'devocional', 'leitura', 'escala', 'inscricao', 'infantil'));

-- O ministério que faz o check-in (um por igreja), como o que recebe os visitantes.
alter table public.ministries add column if not exists kids_checkin boolean not null default false;
create unique index if not exists ministries_kids_idx on public.ministries (church_id) where kids_checkin;
grant update (kids_checkin) on public.ministries to authenticated;

-- Igrejas em que a pessoa está na equipe do infantil.
create or replace function public.my_kids_churches()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select mi.church_id
  from public.ministries mi
  join public.ministry_members mm on mm.ministry_id = mi.id
  join public.members m on m.id = mm.member_id
  where mi.kids_checkin and mi.active and public.ministries_on(mi.church_id)
    and m.church_id = mi.church_id and m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
$$;

-- Faz o check-in: a liderança ou a equipe do infantil, com a funcionalidade ligada.
create or replace function public.can_kids(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.kids_on(p_church)
     and (public.is_leader(p_church) or p_church in (select public.my_kids_churches()))
$$;

-- Campo calculado do cadastro (members.kids_team): o app mostra o Check-in infantil para a equipe.
create or replace function public.kids_team(m public.members)
returns boolean language sql stable security definer set search_path = '' as $$
  select m.user_id = auth.uid() and m.church_id in (select public.my_kids_churches())
$$;

revoke execute on function public.my_kids_churches() from public, anon;
revoke execute on function public.can_kids(uuid) from public, anon;
revoke execute on function public.kids_team(public.members) from public, anon;
grant execute on function public.my_kids_churches() to authenticated;
grant execute on function public.can_kids(uuid) to authenticated;
grant execute on function public.kids_team(public.members) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.kids_rooms (
  id         uuid primary key default gen_random_uuid(),
  church_id  uuid not null references public.churches on delete cascade,
  name       text not null check (char_length(name) between 2 and 40),
  min_age    smallint check (min_age between 0 and 17),
  max_age    smallint check (max_age between 0 and 17),
  created_at timestamptz not null default now(),
  check (min_age is null or max_age is null or min_age <= max_age)
);
create index if not exists kids_rooms_church_idx on public.kids_rooms (church_id, min_age);

-- Criança: ligada ao cadastro do responsável (que usa o app) ou, se cadastrada na recepção,
-- com o nome e o WhatsApp do responsável. Sair da igreja ou excluir a conta apaga os filhos.
create table if not exists public.children (
  id                 uuid primary key default gen_random_uuid(),
  church_id          uuid not null references public.churches on delete cascade,
  name               text not null check (char_length(name) between 2 and 120),
  birth_date         date check (birth_date > '1990-01-01'),
  care_notes         text check (char_length(care_notes) <= 300),   -- alergias e cuidados
  guardian_member_id uuid references public.members on delete cascade,
  guardian_name      text check (char_length(guardian_name) between 2 and 120),
  guardian_phone     text check (guardian_phone ~ '^55[0-9]{10,11}$'),
  consent_at         timestamptz not null default now(),             -- autorização do responsável
  created_by         uuid default auth.uid() references auth.users on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (guardian_member_id is not null or guardian_name is not null)
);
create index if not exists children_church_idx on public.children (church_id, name);
create index if not exists children_guardian_idx on public.children (guardian_member_id);

create table if not exists public.kids_checkins (
  id             uuid primary key default gen_random_uuid(),
  church_id      uuid not null references public.churches on delete cascade,
  child_id       uuid not null references public.children on delete cascade,
  room_name      text check (char_length(room_name) <= 40),
  checkin_date   date not null default public.today_br(),
  code           text not null check (code ~ '^[A-Z0-9]{4}$'),
  checked_in_at  timestamptz not null default now(),
  checked_in_by  uuid default auth.uid() references auth.users on delete set null,
  checked_out_at timestamptz,
  checked_out_by uuid references auth.users on delete set null,
  unique (church_id, checkin_date, code)
);
create unique index if not exists kids_checkins_open_idx on public.kids_checkins (child_id) where checked_out_at is null;
create index if not exists kids_checkins_church_day_idx on public.kids_checkins (church_id, checkin_date);

-- ---------------------------------------------------------------------
-- 3. Regras de acesso
-- ---------------------------------------------------------------------
-- O próprio cadastro da pessoa na igreja (para ser o responsável).
create or replace function public.my_member_id(p_church uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select m.id from public.members m
  where m.church_id = p_church and m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
$$;
revoke execute on function public.my_member_id(uuid) from public, anon;
grant execute on function public.my_member_id(uuid) to authenticated;

-- Salas: os membros veem (para a sala do filho); a liderança cria, muda e apaga.
alter table public.kids_rooms enable row level security;
drop policy if exists "salas le" on public.kids_rooms;
create policy "salas le" on public.kids_rooms for select to authenticated
  using (church_id in (select public.my_church_ids()) and public.kids_on(church_id));
drop policy if exists "salas lideranca cria" on public.kids_rooms;
create policy "salas lideranca cria" on public.kids_rooms for insert to authenticated
  with check (church_id in (select public.my_church_ids('lideranca')) and public.kids_on(church_id));
drop policy if exists "salas lideranca edita" on public.kids_rooms;
create policy "salas lideranca edita" on public.kids_rooms for update to authenticated
  using (church_id in (select public.my_church_ids('lideranca')))
  with check (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "salas lideranca apaga" on public.kids_rooms;
create policy "salas lideranca apaga" on public.kids_rooms for delete to authenticated
  using (church_id in (select public.my_church_ids('lideranca')));
revoke all on public.kids_rooms from anon;
revoke update on public.kids_rooms from authenticated;
grant update (name, min_age, max_age) on public.kids_rooms to authenticated;

-- Crianças: o responsável cuida dos próprios filhos; a equipe do infantil e a liderança, de todas.
alter table public.children enable row level security;
drop policy if exists "criancas le" on public.children;
create policy "criancas le" on public.children for select to authenticated
  using ((guardian_member_id is not null and guardian_member_id = public.my_member_id(church_id) and public.kids_on(church_id))
         or public.can_kids(church_id));
drop policy if exists "criancas cadastra" on public.children;
create policy "criancas cadastra" on public.children for insert to authenticated
  with check ((guardian_member_id is not null and guardian_member_id = public.my_member_id(church_id) and public.kids_on(church_id))
              or public.can_kids(church_id));
drop policy if exists "criancas edita" on public.children;
create policy "criancas edita" on public.children for update to authenticated
  using ((guardian_member_id is not null and guardian_member_id = public.my_member_id(church_id))
         or public.can_kids(church_id))
  with check ((guardian_member_id is not null and guardian_member_id = public.my_member_id(church_id))
              or public.can_kids(church_id));
drop policy if exists "criancas apaga" on public.children;
create policy "criancas apaga" on public.children for delete to authenticated
  using ((guardian_member_id is not null and guardian_member_id = public.my_member_id(church_id))
         or church_id in (select public.my_church_ids('lideranca')));
revoke all on public.children from anon;
revoke update on public.children from authenticated;
grant update (name, birth_date, care_notes, guardian_name, guardian_phone, updated_at) on public.children to authenticated;

-- security definer: a equipe (membro comum) não lê o cadastro dos outros, mas a conferência precisa.
create or replace function public.children_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.guardian_member_id is not null
     and not exists (select 1 from public.members m where m.id = new.guardian_member_id and m.church_id = new.church_id) then
    raise exception 'O responsável precisa ser do cadastro da mesma igreja.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.church_id <> old.church_id or new.guardian_member_id is distinct from old.guardian_member_id) then
    raise exception 'Não dá para trocar a igreja nem o responsável.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists children_guard on public.children;
create trigger children_guard before insert or update on public.children
  for each row execute function public.children_guard();
revoke execute on function public.children_guard() from public, anon, authenticated;

-- Entradas e retiradas: a equipe e a liderança veem as da igreja; o responsável, as dos filhos.
-- Gravar, só por kids_checkin e kids_checkout.
alter table public.kids_checkins enable row level security;
drop policy if exists "checkins le" on public.kids_checkins;
create policy "checkins le" on public.kids_checkins for select to authenticated
  using (public.can_kids(church_id)
         or child_id in (select c.id from public.children c where c.guardian_member_id = public.my_member_id(c.church_id)));
revoke all on public.kids_checkins from anon;
revoke insert, update, delete on public.kids_checkins from authenticated;

-- ---------------------------------------------------------------------
-- 4. Funções das telas
-- ---------------------------------------------------------------------
-- Crianças da igreja para a recepção: responsável, telefone e a entrada de hoje (se houver).
create or replace function public.kids_roster(p_church uuid)
returns table (id uuid, name text, birth_date date, care_notes text, guardian text, phone text, has_app boolean,
               checkin_id uuid, room_name text, code text, checked_in_at timestamptz, checked_out_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.can_kids(p_church) then
    return;
  end if;
  return query
  select c.id, c.name, c.birth_date, c.care_notes,
         coalesce(m.name, c.guardian_name), coalesce(m.phone, c.guardian_phone),
         m.user_id is not null and m.consent_at is not null,
         k.id, k.room_name, k.code, k.checked_in_at, k.checked_out_at
  from public.children c
  left join public.members m on m.id = c.guardian_member_id
  left join lateral (
    select * from public.kids_checkins k
    where k.child_id = c.id and k.checkin_date = public.today_br()
    order by k.checked_in_at desc limit 1
  ) k on true
  where c.church_id = p_church
  order by c.name;
end $$;

-- Sorteia um código de 4 letras e números (sem 0/O, 1/I/L), único na igreja no dia.
create or replace function public.kids_new_code(p_church uuid, p_day date)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code text;
begin
  for i in 1..50 loop
    v_bytes := extensions.gen_random_bytes(4);
    v_code := '';
    for j in 0..3 loop
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, j) % length(v_alphabet)) + 1, 1);
    end loop;
    if not exists (select 1 from public.kids_checkins k where k.church_id = p_church and k.checkin_date = p_day and k.code = v_code) then
      return v_code;
    end if;
  end loop;
  raise exception 'Não deu para gerar o código. Tente de novo.';
end $$;
revoke execute on function public.kids_new_code(uuid, date) from public, anon, authenticated;

-- Entrada: devolve o código de retirada. O responsável com o app recebe o aviso com o código.
create or replace function public.kids_checkin(p_child uuid, p_room text)
returns table (checkin_id uuid, code text, room_name text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  c public.children;
  v_day date := public.today_br();
  v_code text;
  v_id uuid;
  v_room text := nullif(trim(left(p_room, 40)), '');
  v_user uuid;
begin
  select * into c from public.children where id = p_child;
  if c.id is null or not public.can_kids(c.church_id) then
    raise exception 'Só a equipe do infantil faz o check-in.' using errcode = '42501';
  end if;
  -- Entrada de outro dia que ficou aberta: fecha sem retirada.
  update public.kids_checkins set checked_out_at = checked_in_at
   where child_id = p_child and checked_out_at is null and checkin_date < v_day;
  if exists (select 1 from public.kids_checkins k where k.child_id = p_child and k.checked_out_at is null) then
    raise exception '% já está no infantil.', split_part(c.name, ' ', 1);
  end if;
  v_code := public.kids_new_code(c.church_id, v_day);
  insert into public.kids_checkins (church_id, child_id, room_name, checkin_date, code)
  values (c.church_id, p_child, v_room, v_day, v_code)
  returning id into v_id;

  select m.user_id into v_user from public.members m
  where m.id = c.guardian_member_id and m.status = 'ativo' and m.consent_at is not null;
  if v_user is not null then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    values (v_user, c.church_id, 'infantil',
            split_part(c.name, ' ', 1) || ' entrou' || coalesce(' no ' || v_room, ' no infantil'),
            'Código de retirada: ' || v_code || '. Mostre este código para buscar.',
            '#/filhos', 'infantil:' || v_id || ':entrada', true)
    on conflict do nothing;
  end if;
  return query select v_id, v_code, v_room;
end $$;

-- Retirada pelo código: primeiro confere (mostra a criança), depois confirma.
create or replace function public.kids_lookup_code(p_church uuid, p_code text)
returns table (checkin_id uuid, child_name text, room_name text, guardian text, checked_in_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.can_kids(p_church) then
    return;
  end if;
  return query
  select k.id, c.name, k.room_name, coalesce(m.name, c.guardian_name), k.checked_in_at
  from public.kids_checkins k
  join public.children c on c.id = k.child_id
  left join public.members m on m.id = c.guardian_member_id
  where k.church_id = p_church and k.checkin_date = public.today_br() and k.checked_out_at is null
    and k.code = upper(trim(coalesce(p_code, '')));
end $$;

create or replace function public.kids_checkout(p_checkin uuid, p_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v record;
begin
  select k.id, k.code, k.church_id, k.checked_out_at, k.room_name, c.name, m.user_id, m.status, m.consent_at into v
  from public.kids_checkins k
  join public.children c on c.id = k.child_id
  left join public.members m on m.id = c.guardian_member_id
  where k.id = p_checkin;
  if v.id is null or not public.can_kids(v.church_id) then
    raise exception 'Só a equipe do infantil faz a retirada.' using errcode = '42501';
  end if;
  if v.checked_out_at is not null then
    raise exception '% já foi retirado.', split_part(v.name, ' ', 1);
  end if;
  if v.code <> upper(trim(coalesce(p_code, ''))) then
    raise exception 'O código não confere. Peça ao responsável o código da etiqueta ou do app.' using errcode = '42501';
  end if;
  update public.kids_checkins set checked_out_at = now(), checked_out_by = auth.uid() where id = p_checkin;
  if v.user_id is not null and v.status = 'ativo' and v.consent_at is not null then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    values (v.user_id, v.church_id, 'infantil', split_part(v.name, ' ', 1) || ' foi retirado',
            'Retirada às ' || to_char(now() at time zone 'America/Sao_Paulo', 'HH24"h"MI') || coalesce(' · ' || v.room_name, ''),
            '#/filhos', 'infantil:' || p_checkin || ':saida', true)
    on conflict do nothing;
  end if;
  return v.name;
end $$;

revoke execute on function public.kids_roster(uuid) from public, anon;
revoke execute on function public.kids_checkin(uuid, text) from public, anon;
revoke execute on function public.kids_lookup_code(uuid, text) from public, anon;
revoke execute on function public.kids_checkout(uuid, text) from public, anon;
grant execute on function public.kids_roster(uuid) to authenticated;
grant execute on function public.kids_checkin(uuid, text) to authenticated;
grant execute on function public.kids_lookup_code(uuid, text) to authenticated;
grant execute on function public.kids_checkout(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Limpeza (envio diário, com a senha ENVIO_SECRET): LGPD
-- ---------------------------------------------------------------------
-- Histórico com mais de 12 meses; crianças cadastradas na recepção (sem responsável no app)
-- que não vieram nos últimos 12 meses.
create or replace function public.clean_kids(p_secret text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform public.envio_check_secret(p_secret);
  delete from public.kids_checkins where checkin_date < public.today_br() - 366;
  get diagnostics v_count = row_count;
  delete from public.children c
   where c.guardian_member_id is null and c.created_at < now() - interval '12 months'
     and not exists (select 1 from public.kids_checkins k where k.child_id = c.id);
  return v_count;
end $$;
revoke execute on function public.clean_kids(text) from public;
grant execute on function public.clean_kids(text) to anon;

-- ---------------------------------------------------------------------
-- 6. Os próprios dados: os filhos e as entradas deles
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
-- Sair da igreja e excluir a conta apagam o cadastro, e com ele os filhos (on delete cascade).

-- ---------------------------------------------------------------------
-- 7. Dados de teste: as igrejas de teste ligam o infantil
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"infantil": true}'::jsonb
where slug in ('teste-a', 'teste-b');
