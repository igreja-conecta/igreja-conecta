-- =====================================================================
-- Igreja Conecta — devocional e plano de leitura da Bíblia (Fase 3)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - Devocional do dia: o pastor ou um líder escreve e agenda (um por dia);
--   os membros só veem a partir da data marcada. "Amém" com contador, sem
--   mostrar quem marcou. Aviso opcional na central e no celular às 7h.
-- - Plano de leitura: a liderança escolhe planos prontos e a data de início;
--   cada membro entra, marca o que leu e vê o próprio progresso. Ninguém vê o
--   progresso dos outros (a liderança vê só o total de pessoas e a média).
-- - O texto da Bíblia não fica no app (tem direitos autorais): o app mostra
--   as referências e abre o trecho na YouVersion, na tradução da igreja.
--
-- Os avisos das 7h saem pelo envio de 10 em 10 minutos (scripts/enviar-lembretes.mjs).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Igreja: tradução da Bíblia e funcionalidade ligada
-- ---------------------------------------------------------------------
alter table public.churches add column if not exists bible_version text not null default 'NVI'
  check (bible_version in ('NVI', 'ARA', 'NAA', 'NTLH', 'ARC', 'NVT'));
grant update (bible_version) on public.churches to authenticated;

create or replace function public.devotional_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'devocional')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.devotional_on(uuid) from public, anon;
grant execute on function public.devotional_on(uuid) to authenticated;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'oracao', 'visitante',
                  'devocional', 'leitura'));

-- ---------------------------------------------------------------------
-- 2. Devocionais
-- ---------------------------------------------------------------------
create table if not exists public.devotionals (
  id            uuid primary key default gen_random_uuid(),
  church_id     uuid not null references public.churches on delete cascade,
  publish_date  date not null,
  title         text not null check (char_length(title) between 3 and 120),
  -- Versículo-base: livro (código da YouVersion, ex.: JHN), capítulo e versículos.
  verse_book    text check (verse_book ~ '^[1-3A-Z]{3}$'),
  verse_chapter integer check (verse_chapter between 1 and 150),
  verse_from    integer check (verse_from between 1 and 176),
  verse_to      integer check (verse_to between 1 and 176),
  verse_text    text check (char_length(verse_text) <= 1000),
  body          text not null check (char_length(body) between 1 and 6000),
  image_path    text,
  push          boolean not null default false,   -- avisar os membros às 7h do dia
  pushed_at     timestamptz,
  created_by    uuid default auth.uid() references auth.users on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (church_id, publish_date),
  check ((verse_book is null) = (verse_chapter is null)),
  check (verse_from is null or verse_chapter is not null),
  check (verse_to is null or (verse_from is not null and verse_to >= verse_from)),
  -- Imagem só na pasta de devocionais da própria igreja (arquivos públicos "igrejas").
  check (image_path is null or image_path ~ ('^' || church_id::text || '/devocionais/[A-Za-z0-9._-]{1,80}$'))
);
create index if not exists devotionals_push_idx on public.devotionals (publish_date) where push and pushed_at is null;

-- Quem marcou "Amém" (ninguém lê pelo app; aparece só o total).
create table if not exists public.devotional_amens (
  devotional_id uuid not null references public.devotionals on delete cascade,
  user_id       uuid not null references auth.users on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (devotional_id, user_id)
);
alter table public.devotional_amens enable row level security;
revoke all on public.devotional_amens from anon, authenticated;

create or replace function public.devotionals_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.pushed_at := null;
  else
    if new.church_id <> old.church_id then
      raise exception 'Este campo não pode ser alterado.' using errcode = '42501';
    end if;
    -- Mudou para outro dia: o aviso sai de novo no dia novo (se estiver marcado).
    new.pushed_at := case when new.publish_date = old.publish_date then old.pushed_at end;
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.devotionals_guard() from public, anon, authenticated;
drop trigger if exists devotionals_guard on public.devotionals;
create trigger devotionals_guard before insert or update on public.devotionals
  for each row execute function public.devotionals_guard();

alter table public.devotionals enable row level security;
-- Membros: só a partir da data marcada. O pastor e os líderes veem também os agendados.
drop policy if exists "devocional le" on public.devotionals;
create policy "devocional le" on public.devotionals for select to authenticated
  using (church_id in (select public.my_church_ids('pastoral'))
         or (church_id in (select public.my_church_ids('membro'))
             and publish_date <= public.today_br() and public.devotional_on(church_id)));
drop policy if exists "devocional pastoral cria" on public.devotionals;
create policy "devocional pastoral cria" on public.devotionals for insert to authenticated
  with check (church_id in (select public.my_church_ids('pastoral')) and public.devotional_on(church_id));
drop policy if exists "devocional pastoral edita" on public.devotionals;
create policy "devocional pastoral edita" on public.devotionals for update to authenticated
  using (church_id in (select public.my_church_ids('pastoral')))
  with check (church_id in (select public.my_church_ids('pastoral')) and public.devotional_on(church_id));
drop policy if exists "devocional pastoral apaga" on public.devotionals;
create policy "devocional pastoral apaga" on public.devotionals for delete to authenticated
  using (church_id in (select public.my_church_ids('pastoral')));
revoke all on public.devotionals from anon;
revoke update on public.devotionals from authenticated;
grant update (publish_date, title, verse_book, verse_chapter, verse_from, verse_to, verse_text, body, image_path, push, updated_at)
  on public.devotionals to authenticated;

-- Imagem do devocional: o pastor e os líderes gravam na pasta <igreja>/devocionais/.
drop policy if exists "devocionais pastoral envia" on storage.objects;
create policy "devocionais pastoral envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'igrejas' and (storage.foldername(name))[2] = 'devocionais'
              and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('pastoral') as id));
drop policy if exists "devocionais pastoral le" on storage.objects;
create policy "devocionais pastoral le" on storage.objects for select to authenticated
  using (bucket_id = 'igrejas' and (storage.foldername(name))[2] = 'devocionais'
         and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('pastoral') as id));
drop policy if exists "devocionais pastoral apaga" on storage.objects;
create policy "devocionais pastoral apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'igrejas' and (storage.foldername(name))[2] = 'devocionais'
         and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('pastoral') as id));

-- Lista (ou um só, com p_id) com o total de "Amém" e se eu marquei.
create or replace function public.devotional_list(p_church uuid, p_id uuid default null)
returns table (id uuid, publish_date date, title text, verse_book text, verse_chapter integer, verse_from integer,
               verse_to integer, verse_text text, body text, image_path text, push boolean, amens integer, i_amen boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_pastor boolean := public.is_pastoral(p_church);
begin
  if not public.is_member(p_church) or not public.devotional_on(p_church) then
    return;
  end if;
  return query
  select d.id, d.publish_date, d.title, d.verse_book, d.verse_chapter, d.verse_from, d.verse_to, d.verse_text,
         d.body, d.image_path, d.push,
         (select count(*)::integer from public.devotional_amens a where a.devotional_id = d.id),
         exists (select 1 from public.devotional_amens a where a.devotional_id = d.id and a.user_id = auth.uid())
  from public.devotionals d
  where d.church_id = p_church
    and (v_pastor or d.publish_date <= public.today_br())
    and (p_id is null or d.id = p_id)
  order by d.publish_date desc
  limit 60;
end $$;

-- Liga ou desliga o "Amém" e devolve o total.
create or replace function public.devotional_amen(p_devotional uuid)
returns table (amens integer, i_amen boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_church uuid;
begin
  select d.church_id into v_church from public.devotionals d
  where d.id = p_devotional and d.publish_date <= public.today_br();
  if v_church is null or not public.is_member(v_church) or not public.devotional_on(v_church) then
    raise exception 'Devocional não encontrado.' using errcode = '42501';
  end if;
  delete from public.devotional_amens a where a.devotional_id = p_devotional and a.user_id = auth.uid();
  if not found then
    insert into public.devotional_amens (devotional_id, user_id) values (p_devotional, auth.uid());
  end if;
  return query
  select (select count(*)::integer from public.devotional_amens a where a.devotional_id = p_devotional),
         exists (select 1 from public.devotional_amens a where a.devotional_id = p_devotional and a.user_id = auth.uid());
end $$;

revoke execute on function public.devotional_list(uuid, uuid) from public, anon;
revoke execute on function public.devotional_amen(uuid) from public, anon;
grant execute on function public.devotional_list(uuid, uuid) to authenticated;
grant execute on function public.devotional_amen(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Planos de leitura
-- ---------------------------------------------------------------------
-- Os planos prontos. As leituras de cada dia são montadas pelo app (js/biblia.js);
-- aqui ficam só o nome e o número de dias, iguais aos de lá.
create or replace function public.reading_plan_days(p_key text)
returns integer language sql immutable as $$
  select case p_key
           when 'biblia-1-ano' then 365
           when 'nt-90' then 90
           when 'salmos-proverbios' then 31
           when 'evangelhos-30' then 30
         end
$$;
create or replace function public.reading_plan_title(p_key text)
returns text language sql immutable as $$
  select case p_key
           when 'biblia-1-ano' then 'Bíblia em 1 ano'
           when 'nt-90' then 'Novo Testamento em 90 dias'
           when 'salmos-proverbios' then 'Salmos e Provérbios em 31 dias'
           when 'evangelhos-30' then 'Evangelhos em 30 dias'
         end
$$;

create table if not exists public.reading_plans (
  id         uuid primary key default gen_random_uuid(),
  church_id  uuid not null references public.churches on delete cascade,
  plan_key   text not null check (plan_key in ('biblia-1-ano', 'nt-90', 'salmos-proverbios', 'evangelhos-30')),
  start_date date not null,
  active     boolean not null default true,
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists reading_plans_church_idx on public.reading_plans (church_id, start_date desc);

-- Quem entrou em cada plano e se quer o lembrete das 7h.
create table if not exists public.reading_plan_members (
  plan_id   uuid not null references public.reading_plans on delete cascade,
  user_id   uuid not null default auth.uid() references auth.users on delete cascade,
  remind    boolean not null default true,
  joined_at timestamptz not null default now(),
  primary key (plan_id, user_id)
);
create index if not exists reading_plan_members_user_idx on public.reading_plan_members (user_id);

-- Os dias que cada um marcou como lidos.
create table if not exists public.reading_progress (
  plan_id uuid not null,
  user_id uuid not null default auth.uid(),
  day     integer not null check (day between 1 and 366),
  read_at timestamptz not null default now(),
  primary key (plan_id, user_id, day),
  foreign key (plan_id, user_id) references public.reading_plan_members (plan_id, user_id) on delete cascade
);

-- Plano que a pessoa vê: da igreja dela, com a funcionalidade ligada.
create or replace function public.reading_plan_visible(p_plan uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.reading_plans p
    where p.id = p_plan and public.is_member(p.church_id) and public.devotional_on(p.church_id))
$$;
revoke execute on function public.reading_plan_visible(uuid) from public, anon;
grant execute on function public.reading_plan_visible(uuid) to authenticated;

create or replace function public.reading_progress_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.reading_plans p
    where p.id = new.plan_id and new.day <= public.reading_plan_days(p.plan_key)) then
    raise exception 'Dia fora do plano.' using errcode = '22023';
  end if;
  new.read_at := now();
  return new;
end $$;
revoke execute on function public.reading_progress_guard() from public, anon, authenticated;
drop trigger if exists reading_progress_guard on public.reading_progress;
create trigger reading_progress_guard before insert on public.reading_progress
  for each row execute function public.reading_progress_guard();

alter table public.reading_plans enable row level security;
drop policy if exists "planos membros leem" on public.reading_plans;
create policy "planos membros leem" on public.reading_plans for select to authenticated
  using (church_id in (select public.my_church_ids('membro')) and public.devotional_on(church_id));
drop policy if exists "planos lideranca cria" on public.reading_plans;
create policy "planos lideranca cria" on public.reading_plans for insert to authenticated
  with check (church_id in (select public.my_church_ids('lideranca')) and public.devotional_on(church_id));
drop policy if exists "planos lideranca edita" on public.reading_plans;
create policy "planos lideranca edita" on public.reading_plans for update to authenticated
  using (church_id in (select public.my_church_ids('lideranca')))
  with check (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "planos lideranca apaga" on public.reading_plans;
create policy "planos lideranca apaga" on public.reading_plans for delete to authenticated
  using (church_id in (select public.my_church_ids('lideranca')));
revoke all on public.reading_plans from anon;
revoke update on public.reading_plans from authenticated;
grant update (start_date, active) on public.reading_plans to authenticated;

-- Cada um lê e muda só a própria participação e o próprio progresso.
alter table public.reading_plan_members enable row level security;
drop policy if exists "plano participacao propria le" on public.reading_plan_members;
create policy "plano participacao propria le" on public.reading_plan_members for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "plano participacao propria entra" on public.reading_plan_members;
create policy "plano participacao propria entra" on public.reading_plan_members for insert to authenticated
  with check (user_id = (select auth.uid()) and public.reading_plan_visible(plan_id));
drop policy if exists "plano participacao propria muda" on public.reading_plan_members;
create policy "plano participacao propria muda" on public.reading_plan_members for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "plano participacao propria sai" on public.reading_plan_members;
create policy "plano participacao propria sai" on public.reading_plan_members for delete to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.reading_plan_members from anon;
revoke update on public.reading_plan_members from authenticated;
grant update (remind) on public.reading_plan_members to authenticated;

alter table public.reading_progress enable row level security;
drop policy if exists "progresso proprio le" on public.reading_progress;
create policy "progresso proprio le" on public.reading_progress for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "progresso proprio marca" on public.reading_progress;
create policy "progresso proprio marca" on public.reading_progress for insert to authenticated
  with check (user_id = (select auth.uid()) and public.reading_plan_visible(plan_id));
drop policy if exists "progresso proprio desmarca" on public.reading_progress;
create policy "progresso proprio desmarca" on public.reading_progress for delete to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.reading_progress from anon;
revoke update on public.reading_progress from authenticated;

-- Números de cada plano da igreja: quantas pessoas estão lendo (para todos) e a média de
-- progresso (só para a liderança). Nunca o progresso de uma pessoa.
create or replace function public.reading_plan_stats(p_church uuid)
returns table (plan_id uuid, readers integer, avg_percent integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_leader boolean := public.is_leader(p_church);
begin
  if not public.is_member(p_church) or not public.devotional_on(p_church) then
    return;
  end if;
  return query
  select p.id,
         (select count(*)::integer from public.reading_plan_members pm where pm.plan_id = p.id),
         case when v_leader then (
           select round(avg(least(100, 100.0 * (select count(*) from public.reading_progress r
                                                where r.plan_id = pm.plan_id and r.user_id = pm.user_id)
                                     / public.reading_plan_days(p.plan_key))))::integer
           from public.reading_plan_members pm where pm.plan_id = p.id)
         end
  from public.reading_plans p
  where p.church_id = p_church;
end $$;
revoke execute on function public.reading_plan_stats(uuid) from public, anon;
grant execute on function public.reading_plan_stats(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Avisos das 7h (envio de 10 em 10 minutos, com a senha ENVIO_SECRET)
-- ---------------------------------------------------------------------
-- Grava na central (e na fila do push) o devocional do dia e o lembrete da leitura de quem
-- ainda não leu. Antes das 7h e depois das 21h não faz nada; cada aviso sai uma vez por dia.
create or replace function public.deliver_devotional_notifications(p_secret text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'America/Sao_Paulo';
  v_day date := v_now::date;
  v_count integer;
  v_more integer;
begin
  perform public.envio_check_secret(p_secret);
  if extract(hour from v_now) < 7 or extract(hour from v_now) >= 21 then
    return 0;
  end if;

  with hoje as (
    update public.devotionals d
       set pushed_at = now()
      from public.churches c
     where c.id = d.church_id and d.push and d.pushed_at is null and d.publish_date = v_day
       and c.active and coalesce((c.features->>'devocional')::boolean, false)
    returning d.id, d.church_id, d.title
  )
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select a.user_id, h.church_id, 'devocional', 'Devocional de hoje', h.title, '#/devocional/' || h.id,
         'devocional:' || h.id, true
  from hoje h cross join lateral public.church_audience(h.church_id) a
  on conflict do nothing;
  get diagnostics v_count = row_count;

  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select pm.user_id, p.church_id, 'leitura', 'Leitura de hoje',
         public.reading_plan_title(p.plan_key) || ' · dia ' || (v_day - p.start_date + 1) || ' de ' || public.reading_plan_days(p.plan_key),
         '#/leitura/' || p.id, 'leitura:' || p.id || ':' || v_day, true
  from public.reading_plans p
  join public.churches c on c.id = p.church_id
  join public.reading_plan_members pm on pm.plan_id = p.id
  join public.members m on m.church_id = p.church_id and m.user_id = pm.user_id
                       and m.status = 'ativo' and m.consent_at is not null
  where p.active and pm.remind
    and c.active and coalesce((c.features->>'devocional')::boolean, false)
    and v_day between p.start_date and p.start_date + public.reading_plan_days(p.plan_key) - 1
    and not exists (select 1 from public.reading_progress r
                    where r.plan_id = p.id and r.user_id = pm.user_id and r.day = v_day - p.start_date + 1)
  on conflict do nothing;
  get diagnostics v_more = row_count;
  return v_count + v_more;
end $$;
revoke execute on function public.deliver_devotional_notifications(text) from public;
grant execute on function public.deliver_devotional_notifications(text) to anon;

-- ---------------------------------------------------------------------
-- 5. Os próprios dados: exportar e sair da igreja
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
      'cadastros_feitos', (select count(*) from public.members x where x.created_by = v_user))
  );
end $$;

-- Sair de uma igreja: apaga o cadastro, as notificações, os pedidos de oração, os planos de
-- leitura e os "Amém" dela.
create or replace function public.leave_church(p_church uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta.' using errcode = '42501';
  end if;
  perform public.assert_not_last_admin(auth.uid(), p_church);
  delete from public.prayer_praying x using public.prayer_requests p
   where x.request_id = p.id and x.user_id = auth.uid() and p.church_id = p_church;
  delete from public.prayer_requests where user_id = auth.uid() and church_id = p_church;
  delete from public.devotional_amens a using public.devotionals d
   where a.devotional_id = d.id and a.user_id = auth.uid() and d.church_id = p_church;
  delete from public.reading_plan_members pm using public.reading_plans p
   where pm.plan_id = p.id and pm.user_id = auth.uid() and p.church_id = p_church;
  delete from public.notifications where user_id = auth.uid() and church_id = p_church;
  delete from public.members where user_id = auth.uid() and church_id = p_church;
end $$;

-- ---------------------------------------------------------------------
-- 6. Dados de teste: as igrejas de teste ligam o devocional
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"devocional": true}'::jsonb
where slug in ('teste-a', 'teste-b');
