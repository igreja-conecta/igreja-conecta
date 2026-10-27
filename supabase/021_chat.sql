-- =====================================================================
-- Igreja Conecta — chat (entrega 1: conversas e tempo real)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- Reaproveita o chat do Desapega (007, 010 e 013 de lá), dentro de cada igreja:
-- - Conversa 1 a 1, sempre numa igreja; as duas pessoas são membros ativos,
--   com conta e convite aceito
-- - O membro fala com a liderança; a liderança fala com qualquer membro;
--   membro com membro, só se a igreja ligar ("chat_membros")
-- - Quem desliga "receber mensagens" não recebe conversa nova nem mensagem,
--   mas continua respondendo as conversas que já tem
-- - Só as duas pessoas leem. Bloquear e denunciar (a denúncia avisa o
--   administrador da igreja com os nomes e o motivo, sem as mensagens)
-- - Limites: 30 conversas novas e 120 mensagens por hora por conta
-- - Tempo real: cada mensagem vai para o canal particular "user:<id>" de cada
--   participante (sem publicar a tabela), com o church_id junto
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Funcionalidade, "receber mensagens" e tipo de notificação
-- ---------------------------------------------------------------------
create or replace function public.chat_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'chat')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
create or replace function public.chat_members_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'chat_membros')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.chat_on(uuid) from public, anon;
revoke execute on function public.chat_members_on(uuid) from public, anon;
grant execute on function public.chat_on(uuid) to authenticated;
grant execute on function public.chat_members_on(uuid) to authenticated;

alter table public.members add column if not exists chat_enabled boolean not null default true;
grant update (chat_enabled) on public.members to authenticated;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'oracao', 'visitante',
                  'devocional', 'leitura', 'escala', 'inscricao', 'infantil', 'galeria', 'chat'));

-- ---------------------------------------------------------------------
-- 2. Conversas e mensagens
-- ---------------------------------------------------------------------
-- user_a < user_b: uma conversa só por par de pessoas em cada igreja.
-- Nome e foto guardados: continuam aparecendo se o cadastro mudar ou sair.
create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  church_id       uuid not null references public.churches on delete cascade,
  user_a          uuid not null references auth.users on delete cascade,
  user_b          uuid not null references auth.users on delete cascade,
  member_a        uuid references public.members on delete set null,
  member_b        uuid references public.members on delete set null,
  name_a          text not null,
  name_b          text not null,
  created_by      uuid not null default auth.uid() references auth.users on delete cascade,
  created_at      timestamptz not null default now(),
  last_message    text,
  last_sender_id  uuid,
  last_message_at timestamptz,
  read_a          timestamptz,
  read_b          timestamptz,
  blocked_by      uuid references auth.users on delete set null,
  blocked_at      timestamptz,
  unique (church_id, user_a, user_b),
  check (user_a < user_b)
);
create index if not exists conversations_a_idx on public.conversations (user_a, church_id, last_message_at desc);
create index if not exists conversations_b_idx on public.conversations (user_b, church_id, last_message_at desc);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  church_id       uuid not null references public.churches on delete cascade,
  conversation_id uuid not null references public.conversations on delete cascade,
  sender_id       uuid not null default auth.uid() references auth.users on delete cascade,
  body            text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at      timestamptz not null default now(),
  pushed_at       timestamptz
);
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at);
create index if not exists messages_sender_idx on public.messages (sender_id, created_at);

-- Denúncias: só o registro (quem, quando, motivo). As mensagens nunca vão junto.
create table if not exists public.chat_reports (
  id              uuid primary key default gen_random_uuid(),
  church_id       uuid not null references public.churches on delete cascade,
  conversation_id uuid references public.conversations on delete set null,
  reporter_id     uuid not null references auth.users on delete cascade,
  reported_name   text not null,
  reason          text check (char_length(reason) <= 500),
  created_at      timestamptz not null default now()
);

-- Só as duas pessoas leem. Ninguém cria conversa, muda ou apaga pelo app.
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.chat_reports enable row level security;
revoke all on public.conversations, public.messages, public.chat_reports from anon;
revoke insert, update, delete on public.conversations from authenticated;
revoke update, delete on public.messages from authenticated;
revoke insert, update, delete on public.chat_reports from authenticated;

drop policy if exists "conversas dos participantes" on public.conversations;
create policy "conversas dos participantes" on public.conversations for select to authenticated
  using (auth.uid() in (user_a, user_b));
drop policy if exists "mensagens dos participantes" on public.messages;
create policy "mensagens dos participantes" on public.messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id and auth.uid() in (c.user_a, c.user_b)));
drop policy if exists "envia nas proprias conversas" on public.messages;
create policy "envia nas proprias conversas" on public.messages for insert to authenticated
  with check (sender_id = auth.uid()
              and exists (select 1 from public.conversations c where c.id = conversation_id and auth.uid() in (c.user_a, c.user_b)));
drop policy if exists "denuncias proprias" on public.chat_reports;
create policy "denuncias proprias" on public.chat_reports for select to authenticated
  using (reporter_id = auth.uid());

-- Cadastro ativo (com conta e convite aceito) de uma conta na igreja.
create or replace function public.chat_member(p_church uuid, p_user uuid)
returns public.members language sql stable security definer set search_path = '' as $$
  select m.* from public.members m
  where m.church_id = p_church and m.user_id = p_user and m.status = 'ativo' and m.consent_at is not null
$$;
revoke execute on function public.chat_member(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Abrir (ou reaproveitar) uma conversa
-- ---------------------------------------------------------------------
create or replace function public.start_conversation(p_church uuid, p_member uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  mine public.members;
  other public.members;
  conv uuid;
  v_a uuid;
  v_b uuid;
begin
  if me is null then
    raise exception 'Entre na sua conta para conversar.' using errcode = '42501';
  end if;
  if not public.chat_on(p_church) then
    raise exception 'O chat está desligado nesta igreja.' using errcode = '42501';
  end if;
  mine := public.chat_member(p_church, me);
  select * into other from public.members m
  where m.id = p_member and m.church_id = p_church and m.status = 'ativo' and m.consent_at is not null and m.user_id is not null;
  if mine.id is null or other.id is null then
    raise exception 'Pessoa não encontrada.' using errcode = '42501';
  end if;
  if other.user_id = me then
    raise exception 'Esta é você.';
  end if;
  v_a := least(me, other.user_id);
  v_b := greatest(me, other.user_id);
  select c.id into conv from public.conversations c where c.church_id = p_church and c.user_a = v_a and c.user_b = v_b;
  if conv is not null then
    return conv;
  end if;
  if not other.chat_enabled then
    raise exception 'Esta pessoa não recebe mensagens pelo chat.' using errcode = '42501';
  end if;
  if mine.role not in ('admin', 'secretaria', 'lider') and other.role not in ('admin', 'secretaria', 'lider')
     and not public.chat_members_on(p_church) then
    raise exception 'Nesta igreja, o chat é só com a liderança.' using errcode = '42501';
  end if;
  if (select count(*) from public.conversations c where c.created_by = me and c.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Limite de conversas novas atingido. Tente de novo em uma hora.';
  end if;
  insert into public.conversations (church_id, user_a, user_b, member_a, member_b, name_a, name_b)
  values (p_church, v_a, v_b,
          case when v_a = me then mine.id else other.id end,
          case when v_b = me then mine.id else other.id end,
          case when v_a = me then mine.name else other.name end,
          case when v_b = me then mine.name else other.name end)
  returning id into conv;
  return conv;
end $$;
revoke execute on function public.start_conversation(uuid, uuid) from public, anon;
grant execute on function public.start_conversation(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Mensagem nova: confere as regras, atualiza o resumo e manda pelo tempo real
-- ---------------------------------------------------------------------
create or replace function public.chat_message_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  c public.conversations;
  other uuid;
  me_m public.members;
  other_m public.members;
begin
  select * into c from public.conversations where id = new.conversation_id;
  new.church_id := c.church_id;  -- a igreja vem sempre da conversa
  new.created_at := now();
  new.pushed_at := null;
  if not public.chat_on(c.church_id) then
    raise exception 'O chat está desligado nesta igreja.' using errcode = '42501';
  end if;
  other := case when new.sender_id = c.user_a then c.user_b else c.user_a end;
  me_m := public.chat_member(c.church_id, new.sender_id);
  other_m := public.chat_member(c.church_id, other);
  if me_m.id is null then
    raise exception 'Você não participa mais desta igreja.' using errcode = '42501';
  end if;
  if other_m.id is null then
    raise exception 'Esta pessoa não está mais na igreja.' using errcode = '42501';
  end if;
  if c.blocked_by is not null then
    raise exception 'Esta conversa está bloqueada.' using errcode = '42501';
  end if;
  if not other_m.chat_enabled then
    raise exception 'Esta pessoa desligou o chat e não recebe mais mensagens.' using errcode = '42501';
  end if;
  if me_m.role not in ('admin', 'secretaria', 'lider') and other_m.role not in ('admin', 'secretaria', 'lider')
     and not public.chat_members_on(c.church_id) then
    raise exception 'Nesta igreja, o chat é só com a liderança.' using errcode = '42501';
  end if;
  if (select count(*) from public.messages m where m.sender_id = new.sender_id and m.created_at > now() - interval '1 hour') >= 120 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um pouco.';
  end if;
  return new;
end $$;
drop trigger if exists messages_guard on public.messages;
create trigger messages_guard before insert on public.messages
  for each row execute function public.chat_message_guard();
revoke execute on function public.chat_message_guard() from public, anon, authenticated;

create or replace function public.chat_message_after()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_conv public.conversations;
  payload jsonb;
begin
  update public.conversations c
     set last_message = left(new.body, 140),
         last_sender_id = new.sender_id,
         last_message_at = new.created_at,
         read_a = case when new.sender_id = c.user_a then new.created_at else c.read_a end,
         read_b = case when new.sender_id = c.user_b then new.created_at else c.read_b end
   where c.id = new.conversation_id
  returning * into v_conv;
  payload := jsonb_build_object(
    'id', new.id, 'church_id', new.church_id, 'conversation_id', new.conversation_id,
    'sender_id', new.sender_id, 'body', new.body, 'created_at', new.created_at);
  begin
    perform realtime.send(payload, 'message', 'user:' || v_conv.user_a, true);
    perform realtime.send(payload, 'message', 'user:' || v_conv.user_b, true);
  exception when others then
    null; -- falha no tempo real nunca impede a mensagem (o app ressincroniza)
  end;
  return null;
end $$;
drop trigger if exists messages_after on public.messages;
create trigger messages_after after insert on public.messages
  for each row execute function public.chat_message_after();
revoke execute on function public.chat_message_after() from public, anon, authenticated;

-- Só a própria pessoa entra no seu canal; ninguém publica por ele pelo app (só o banco).
drop policy if exists "chat: so o proprio canal" on realtime.messages;
create policy "chat: so o proprio canal" on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and realtime.topic() = 'user:' || auth.uid()::text);

-- ---------------------------------------------------------------------
-- 5. Funções das telas
-- ---------------------------------------------------------------------
-- Conversas da pessoa na igreja (com p_conv, só aquela, mesmo sem mensagens: cabeçalho).
-- can_send: se dá para escrever agora (sem dizer o motivo de quem desligou).
create or replace function public.my_conversations(p_church uuid, p_conv uuid default null)
returns table (id uuid, other_member_id uuid, other_name text, other_photo text, other_role text,
               last_message text, last_mine boolean, last_message_at timestamptz, unread boolean,
               blocked boolean, blocked_by_me boolean, can_send boolean)
language sql stable security definer set search_path = '' as $$
  with base as (
    select c.*, (c.user_a = auth.uid()) as i_am_a,
           case when c.user_a = auth.uid() then c.user_b else c.user_a end as other_user,
           case when c.user_a = auth.uid() then c.member_b else c.member_a end as other_member,
           case when c.user_a = auth.uid() then c.name_b else c.name_a end as other_saved_name
    from public.conversations c
    where auth.uid() in (c.user_a, c.user_b) and c.church_id = p_church
      and (c.id = p_conv or (p_conv is null and c.last_message_at is not null))
  )
  select b.id, b.other_member, coalesce(om.name, b.other_saved_name), om.photo_path, om.role,
         b.last_message, b.last_sender_id = auth.uid(), coalesce(b.last_message_at, b.created_at),
         b.last_message_at is not null and b.last_sender_id <> auth.uid()
           and b.last_message_at > coalesce(case when b.i_am_a then b.read_a else b.read_b end, '-infinity'),
         b.blocked_by is not null, b.blocked_by = auth.uid(),
         public.chat_on(p_church) and b.blocked_by is null and me.id is not null and om.id is not null and om.chat_enabled
           and (me.role in ('admin', 'secretaria', 'lider') or om.role in ('admin', 'secretaria', 'lider') or public.chat_members_on(p_church))
  from base b
  left join public.members om on om.user_id = b.other_user and om.church_id = b.church_id and om.status = 'ativo' and om.consent_at is not null
  left join public.members me on me.user_id = auth.uid() and me.church_id = b.church_id and me.status = 'ativo' and me.consent_at is not null
  order by coalesce(b.last_message_at, b.created_at) desc
$$;

create or replace function public.chat_unread_count(p_church uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.conversations c
  where auth.uid() in (c.user_a, c.user_b) and c.church_id = p_church
    and c.last_message_at is not null and c.last_sender_id <> auth.uid()
    and c.last_message_at > coalesce(case when c.user_a = auth.uid() then c.read_a else c.read_b end, '-infinity')
$$;

create or replace function public.mark_conversation_read(p_conv uuid)
returns void language sql security definer set search_path = '' as $$
  update public.conversations
     set read_a = case when user_a = auth.uid() then now() else read_a end,
         read_b = case when user_b = auth.uid() then now() else read_b end
   where id = p_conv and auth.uid() in (user_a, user_b);
$$;

-- Com quem dá para abrir conversa. Sem busca: a liderança que recebe mensagens.
-- Com busca (2+ letras): a liderança busca qualquer membro; o membro busca outros membros
-- só se a igreja ligou o chat entre membros.
create or replace function public.chat_contacts(p_church uuid, p_search text default null)
returns table (member_id uuid, name text, photo_path text, role text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  mine public.members := public.chat_member(p_church, auth.uid());
  v_term text := public.unaccent_lower(trim(coalesce(p_search, '')));
  v_leader boolean;
begin
  if mine.id is null or not public.chat_on(p_church) then
    return;
  end if;
  v_leader := mine.role in ('admin', 'secretaria', 'lider');
  return query
  select m.id, m.name, m.photo_path, m.role
  from public.members m
  where m.church_id = p_church and m.status = 'ativo' and m.consent_at is not null and m.user_id is not null
    and m.user_id <> auth.uid() and m.chat_enabled
    and (
      (char_length(v_term) < 2 and m.role in ('admin', 'secretaria', 'lider'))
      or (char_length(v_term) >= 2 and public.unaccent_lower(m.name) like '%' || v_term || '%'
          and (v_leader or m.role in ('admin', 'secretaria', 'lider') or public.chat_members_on(p_church)))
    )
  order by case m.role when 'admin' then 0 when 'lider' then 1 when 'secretaria' then 2 else 3 end, m.name
  limit 30;
end $$;

-- Bloquear ou desbloquear (só quem bloqueou desbloqueia).
create or replace function public.chat_block(p_conv uuid, p_block boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations
     set blocked_by = case when p_block then auth.uid() else null end,
         blocked_at = case when p_block then now() else null end
   where id = p_conv and auth.uid() in (user_a, user_b)
     and (case when p_block then blocked_by is null else blocked_by = auth.uid() end);
  if not found then
    raise exception 'Não foi possível mudar o bloqueio desta conversa.';
  end if;
end $$;

-- Denunciar: bloqueia e avisa o administrador da igreja (nomes e motivo; as mensagens não).
create or replace function public.chat_report(p_conv uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.conversations;
  v_me text;
  v_other text;
  v_reason text := nullif(trim(left(p_reason, 500)), '');
begin
  select * into c from public.conversations where id = p_conv and auth.uid() in (user_a, user_b);
  if c.id is null then
    raise exception 'Conversa não encontrada.' using errcode = '42501';
  end if;
  if (select count(*) from public.chat_reports r where r.reporter_id = auth.uid() and r.created_at > now() - interval '1 day') >= 10 then
    raise exception 'Muitas denúncias em pouco tempo. Fale direto com a liderança da igreja.';
  end if;
  v_me := case when c.user_a = auth.uid() then c.name_a else c.name_b end;
  v_other := case when c.user_a = auth.uid() then c.name_b else c.name_a end;
  update public.conversations set blocked_by = auth.uid(), blocked_at = now()
   where id = p_conv and blocked_by is null;
  insert into public.chat_reports (church_id, conversation_id, reporter_id, reported_name, reason)
  values (c.church_id, c.id, auth.uid(), v_other, v_reason);
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select m.user_id, c.church_id, 'chat', 'Denúncia no chat',
         v_me || ' denunciou a conversa com ' || v_other || coalesce(': ' || v_reason, '.') ||
         ' As mensagens não são mostradas a ninguém além das duas pessoas.',
         '#/membros', 'chat-denuncia:' || c.id || ':' || (extract(epoch from clock_timestamp()) * 1000)::bigint, true
  from public.members m
  where m.church_id = c.church_id and m.role = 'admin' and m.status = 'ativo'
    and m.user_id is not null and m.consent_at is not null and m.user_id not in (c.user_a, c.user_b)
  on conflict do nothing;
end $$;

revoke execute on function public.my_conversations(uuid, uuid) from public, anon;
revoke execute on function public.chat_unread_count(uuid) from public, anon;
revoke execute on function public.mark_conversation_read(uuid) from public, anon;
revoke execute on function public.chat_contacts(uuid, text) from public, anon;
revoke execute on function public.chat_block(uuid, boolean) from public, anon;
revoke execute on function public.chat_report(uuid, text) from public, anon;
grant execute on function public.my_conversations(uuid, uuid) to authenticated;
grant execute on function public.chat_unread_count(uuid) to authenticated;
grant execute on function public.mark_conversation_read(uuid) to authenticated;
grant execute on function public.chat_contacts(uuid, text) to authenticated;
grant execute on function public.chat_block(uuid, boolean) to authenticated;
grant execute on function public.chat_report(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Sair da igreja: apaga também as conversas dela (para as duas pessoas)
-- ---------------------------------------------------------------------
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
  delete from public.conversations where church_id = p_church and auth.uid() in (user_a, user_b);
  delete from public.notifications where user_id = auth.uid() and church_id = p_church;
  delete from public.members where user_id = auth.uid() and church_id = p_church;
end $$;

-- ---------------------------------------------------------------------
-- 7. Os próprios dados: as conversas, com as mensagens das duas pessoas
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
      'cadastros_feitos', (select count(*) from public.members x where x.created_by = v_user))
  );
end $$;

-- ---------------------------------------------------------------------
-- 8. Dados de teste: as igrejas de teste ligam o chat (entre membros, desligado)
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"chat": true}'::jsonb
where slug in ('teste-a', 'teste-b');
