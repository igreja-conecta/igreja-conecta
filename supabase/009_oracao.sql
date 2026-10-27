-- =====================================================================
-- Igreja Conecta — pedidos de oração (Fase 2, entrega 3)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - O membro envia o pedido só para os pastores (privado) ou para a igreja
--   toda (passa pela aprovação da liderança antes de ir para o mural)
-- - "Pastores" aqui são o administrador e os líderes; a secretaria não vê
-- - Pedido para a igreja pode ser anônimo: os membros não veem o nome,
--   a liderança vê
-- - Mural: só pedidos aprovados, por 30 dias, com "Estou orando" (contador,
--   sem mostrar quem)
-- - Avisos na central do app (e push, pelo envio de 10 em 10 minutos):
--   para a liderança quando chega pedido; para o autor quando é moderado
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Nível "pastoral" (admin e líder) nas regras de acesso
-- ---------------------------------------------------------------------
create or replace function public.my_church_ids(p_level text default 'membro')
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.church_id
  from public.members m
  join public.churches c on c.id = m.church_id
  where m.user_id = auth.uid()
    and m.status = 'ativo'
    and m.consent_at is not null
    and c.active
    and case p_level
          when 'membro' then true
          when 'lideranca' then m.role in ('admin', 'secretaria', 'lider')
          when 'pastoral' then m.role in ('admin', 'lider')
          when 'admin' then m.role = 'admin'
          else false
        end
$$;

create or replace function public.is_pastoral(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_role(p_church, 'admin', 'lider')
$$;

create or replace function public.prayer_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'oracao')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;

-- ---------------------------------------------------------------------
-- 2. Pedidos
-- ---------------------------------------------------------------------
create table if not exists public.prayer_requests (
  id           uuid primary key default gen_random_uuid(),
  church_id    uuid not null references public.churches on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  body         text not null check (char_length(body) between 3 and 500),
  audience     text not null check (audience in ('pastores', 'igreja')),
  anonymous    boolean not null default false,
  -- privado: só para os pastores; pendente/aprovado/recusado: para a igreja
  status       text not null check (status in ('privado', 'pendente', 'aprovado', 'recusado')),
  moderated_at timestamptz,
  moderated_by uuid references auth.users on delete set null,
  cared_at     timestamptz,                 -- "já orei / já entrei em contato" (pedidos privados)
  answered_at  timestamptz,                 -- "Deus respondeu", marcado pelo autor
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (audience = 'igreja' or (status = 'privado' and not anonymous)),
  check (audience = 'pastores' or status <> 'privado')
);
create index if not exists prayer_requests_church_idx on public.prayer_requests (church_id, status, created_at desc);
create index if not exists prayer_requests_user_idx on public.prayer_requests (user_id);

-- Quem está orando por cada pedido (ninguém lê pelo app; o mural mostra só o total).
create table if not exists public.prayer_praying (
  request_id uuid not null references public.prayer_requests on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);
alter table public.prayer_praying enable row level security;
revoke all on public.prayer_praying from anon, authenticated;

-- O que cada um pode mudar. O autor só marca "Deus respondeu"; a liderança
-- pastoral modera (aprova, recusa, corrige o texto antes) e marca "já orei".
create or replace function public.prayer_requests_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_pastor boolean;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if (select count(*) from public.prayer_requests p
        where p.user_id = auth.uid() and p.created_at > now() - interval '1 day') >= 10 then
      raise exception 'Você já enviou muitos pedidos hoje. Tente de novo amanhã.' using errcode = '54000';
    end if;
    new.user_id := auth.uid();
    new.status := case when new.audience = 'igreja' then 'pendente' else 'privado' end;
    new.anonymous := new.audience = 'igreja' and new.anonymous;
    new.moderated_at := null;
    new.moderated_by := null;
    new.cared_at := null;
    new.answered_at := null;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  v_pastor := public.is_pastoral(old.church_id);
  if (new.church_id, new.user_id, new.audience, new.anonymous, new.created_at)
     is distinct from (old.church_id, old.user_id, old.audience, old.anonymous, old.created_at) then
    raise exception 'Este campo não pode ser alterado.' using errcode = '42501';
  end if;
  if new.answered_at is distinct from old.answered_at and old.user_id <> auth.uid() then
    raise exception 'Só quem fez o pedido marca que Deus respondeu.' using errcode = '42501';
  end if;
  if (new.body, new.status, new.cared_at) is distinct from (old.body, old.status, old.cared_at) and not v_pastor then
    raise exception 'Só o pastor ou um líder modera os pedidos de oração.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if old.status = 'privado' or new.status not in ('aprovado', 'recusado') then
      raise exception 'Mudança de situação inválida.' using errcode = '42501';
    end if;
    new.moderated_at := now();
    new.moderated_by := auth.uid();
  else
    new.moderated_at := old.moderated_at;
    new.moderated_by := old.moderated_by;
  end if;
  if new.body is distinct from old.body and old.status not in ('pendente', 'recusado') then
    raise exception 'Só dá para corrigir o texto antes de aprovar.' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists prayer_requests_guard on public.prayer_requests;
create trigger prayer_requests_guard before insert or update on public.prayer_requests
  for each row execute function public.prayer_requests_guard();

alter table public.prayer_requests enable row level security;
-- Lê a tabela: o autor (os próprios) e a liderança pastoral (todos da igreja).
-- Os outros membros veem os aprovados só pelo mural (prayer_wall), sem o autor dos anônimos.
drop policy if exists "oracao le" on public.prayer_requests;
create policy "oracao le" on public.prayer_requests for select to authenticated
  using ((user_id = (select auth.uid()) and church_id in (select public.my_church_ids('membro')))
         or church_id in (select public.my_church_ids('pastoral')));
drop policy if exists "oracao membro envia" on public.prayer_requests;
create policy "oracao membro envia" on public.prayer_requests for insert to authenticated
  with check (church_id in (select public.my_church_ids('membro')) and public.prayer_on(church_id));
drop policy if exists "oracao edita" on public.prayer_requests;
create policy "oracao edita" on public.prayer_requests for update to authenticated
  using ((user_id = (select auth.uid()) and church_id in (select public.my_church_ids('membro')))
         or church_id in (select public.my_church_ids('pastoral')))
  with check (church_id in (select public.my_church_ids('membro')));
drop policy if exists "oracao apaga" on public.prayer_requests;
create policy "oracao apaga" on public.prayer_requests for delete to authenticated
  using (user_id = (select auth.uid()) or church_id in (select public.my_church_ids('pastoral')));
revoke all on public.prayer_requests from anon;
revoke update on public.prayer_requests from authenticated;
grant update (body, status, cared_at, answered_at) on public.prayer_requests to authenticated;

-- ---------------------------------------------------------------------
-- 3. Mural e "Estou orando"
-- ---------------------------------------------------------------------
create or replace function public.prayer_wall(p_church uuid)
returns table (id uuid, body text, author text, anonymous boolean, approved_at timestamptz,
               answered_at timestamptz, praying integer, i_pray boolean, mine boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_pastor boolean := public.is_pastoral(p_church);
begin
  if not public.is_member(p_church) or not public.prayer_on(p_church) then
    return;
  end if;
  return query
  select p.id, p.body,
         case when p.anonymous and not v_pastor and p.user_id <> auth.uid() then null else m.name end,
         p.anonymous, p.moderated_at, p.answered_at,
         (select count(*)::integer from public.prayer_praying x where x.request_id = p.id),
         exists (select 1 from public.prayer_praying x where x.request_id = p.id and x.user_id = auth.uid()),
         p.user_id = auth.uid()
  from public.prayer_requests p
  left join public.members m on m.church_id = p.church_id and m.user_id = p.user_id
  where p.church_id = p_church and p.status = 'aprovado' and p.moderated_at > now() - interval '30 days'
  order by p.moderated_at desc
  limit 200;
end $$;

-- Liga ou desliga o "Estou orando" e devolve o total.
create or replace function public.prayer_toggle(p_request uuid)
returns table (praying integer, i_pray boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_church uuid;
begin
  select p.church_id into v_church from public.prayer_requests p
  where p.id = p_request and p.status = 'aprovado' and p.moderated_at > now() - interval '30 days';
  if v_church is null or not public.is_member(v_church) or not public.prayer_on(v_church) then
    raise exception 'Pedido não encontrado.' using errcode = '42501';
  end if;
  delete from public.prayer_praying x where x.request_id = p_request and x.user_id = auth.uid();
  if not found then
    insert into public.prayer_praying (request_id, user_id) values (p_request, auth.uid());
  end if;
  return query
  select (select count(*)::integer from public.prayer_praying x where x.request_id = p_request),
         exists (select 1 from public.prayer_praying x where x.request_id = p_request and x.user_id = auth.uid());
end $$;

revoke execute on function public.prayer_wall(uuid) from public, anon;
revoke execute on function public.prayer_toggle(uuid) from public, anon;
grant execute on function public.prayer_wall(uuid) to authenticated;
grant execute on function public.prayer_toggle(uuid) to authenticated;
revoke execute on function public.is_pastoral(uuid) from public, anon;
grant execute on function public.is_pastoral(uuid) to authenticated;
revoke execute on function public.prayer_on(uuid) from public, anon;
grant execute on function public.prayer_on(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Avisos na central (e push, pelo envio dos lembretes)
-- ---------------------------------------------------------------------
alter table public.notifications add column if not exists push_pending boolean not null default false;
create index if not exists notifications_push_idx on public.notifications (created_at) where push_pending;
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'oracao'));

-- O texto do pedido não vai na notificação (aparece na tela de bloqueio do celular).
create or replace function public.prayer_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    select m.user_id, new.church_id, 'oracao',
           case when new.status = 'privado' then 'Novo pedido de oração' else 'Pedido de oração para aprovar' end,
           case when new.status = 'privado' then 'Só para os pastores. Toque para ler.' else 'Para o mural da igreja. Toque para ler e aprovar.' end,
           '#/oracao/moderar', 'oracao:' || new.id, true
    from public.members m
    where m.church_id = new.church_id and m.role in ('admin', 'lider') and m.status = 'ativo'
      and m.user_id is not null and m.consent_at is not null and m.user_id <> new.user_id
    on conflict do nothing;
  elsif new.status is distinct from old.status and new.status in ('aprovado', 'recusado') then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    values (new.user_id, new.church_id, 'oracao',
            case when new.status = 'aprovado' then 'Seu pedido de oração está no mural' else 'Seu pedido de oração não foi para o mural' end,
            case when new.status = 'aprovado' then 'A igreja já pode orar com você.' else 'A liderança recebeu o pedido e vai orar por você.' end,
            '#/oracao/meus', 'oracao-' || new.status || ':' || new.id, true)
    on conflict do nothing;
  end if;
  return null;
end $$;
revoke execute on function public.prayer_notify() from public, anon, authenticated;
drop trigger if exists prayer_notify on public.prayer_requests;
create trigger prayer_notify after insert or update of status on public.prayer_requests
  for each row execute function public.prayer_notify();

-- Notificações da central que também vão por push (até 1 dia depois). Todas saem da fila;
-- as das igrejas de teste e das desativadas ficam só na central.
create or replace function public.claim_notification_push(p_secret text)
returns table (notification_id bigint, church_slug text, church_name text, kind text, title text, body text, url text,
               endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.envio_check_secret(p_secret);
  return query
  with novos as (
    update public.notifications n
       set push_pending = false
      from public.churches c
     where c.id = n.church_id and n.push_pending
    returning n.id, n.user_id, n.kind, n.title, n.body, n.url, n.created_at, c.slug, c.name, c.active, c.is_test
  )
  select n.id, n.slug, n.name, n.kind, n.title, n.body, n.url, ps.endpoint, ps.p256dh, ps.auth
  from novos n
  join public.push_subscriptions ps on ps.user_id = n.user_id
  where n.active and not n.is_test and n.created_at > now() - interval '1 day';
end $$;
revoke execute on function public.claim_notification_push(text) from public;
grant execute on function public.claim_notification_push(text) to anon;

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

-- Sair de uma igreja: apaga o cadastro, as notificações e os pedidos de oração dela.
-- (Excluir a conta apaga os pedidos de todas as igrejas, pela ligação com a conta.)
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
  delete from public.notifications where user_id = auth.uid() and church_id = p_church;
  delete from public.members where user_id = auth.uid() and church_id = p_church;
end $$;

-- ---------------------------------------------------------------------
-- 6. Dados de teste: as igrejas de teste ligam os pedidos de oração
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"oracao": true}'::jsonb
where slug in ('teste-a', 'teste-b');
