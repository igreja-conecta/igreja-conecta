-- =====================================================================
-- Igreja Conecta — apagar conversa (só para quem apagou)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- Arrastar a conversa para a esquerda (ou "Apagar conversa" no menu ⋯) a apaga para quem
-- apagou. A outra pessoa continua vendo tudo. Se chegar mensagem nova, a conversa volta só
-- com o que é novo. Nada é apagado do banco: uma denúncia ainda pode ser analisada.
-- =====================================================================

alter table public.conversations
  add column if not exists hidden_a timestamptz,
  add column if not exists hidden_b timestamptz;

-- Apaga (p_hide = true) ou desfaz (false) para quem chamou. Apagar também marca como lida,
-- senão o número no ícone das conversas ficaria preso.
create or replace function public.hide_conversation(p_conv uuid, p_hide boolean default true)
returns void language sql security definer set search_path = '' as $$
  update public.conversations
     set hidden_a = case when user_a = auth.uid() then case when p_hide then now() end else hidden_a end,
         hidden_b = case when user_b = auth.uid() then case when p_hide then now() end else hidden_b end,
         read_a   = case when user_a = auth.uid() and p_hide then now() else read_a end,
         read_b   = case when user_b = auth.uid() and p_hide then now() else read_b end
   where id = p_conv and auth.uid() in (user_a, user_b);
$$;
revoke execute on function public.hide_conversation(uuid, boolean) from public, anon;
grant execute on function public.hide_conversation(uuid, boolean) to authenticated;

-- Mensagens: cada pessoa só lê as que chegaram depois de ela apagar (mesmo nome da regra do
-- 021, para substituir; duas regras somariam e as antigas continuariam aparecendo).
drop policy if exists "mensagens dos participantes" on public.messages;
create policy "mensagens dos participantes" on public.messages for select to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.id = conversation_id
      and auth.uid() in (c.user_a, c.user_b)
      and messages.created_at > coalesce(case when c.user_a = auth.uid() then c.hidden_a else c.hidden_b end, '-infinity')
  ));

-- Lista de conversas (definição do 021): esconde as apagadas até chegar mensagem nova.
-- Aberta pelo id (p_conv), a conversa continua vindo (ex.: "Nova conversa" com a mesma pessoa).
create or replace function public.my_conversations(p_church uuid, p_conv uuid default null)
returns table (id uuid, other_member_id uuid, other_name text, other_photo text, other_role text,
               last_message text, last_mine boolean, last_message_at timestamptz, unread boolean,
               blocked boolean, blocked_by_me boolean, can_send boolean)
language sql stable security definer set search_path = '' as $$
  with base as (
    select c.*, (c.user_a = auth.uid()) as i_am_a,
           case when c.user_a = auth.uid() then c.user_b else c.user_a end as other_user,
           case when c.user_a = auth.uid() then c.member_b else c.member_a end as other_member,
           case when c.user_a = auth.uid() then c.name_b else c.name_a end as other_saved_name,
           case when c.user_a = auth.uid() then c.hidden_a else c.hidden_b end as my_hidden
    from public.conversations c
    where auth.uid() in (c.user_a, c.user_b) and c.church_id = p_church
      and (c.id = p_conv or (
        p_conv is null and c.last_message_at is not null
        and c.last_message_at > coalesce(case when c.user_a = auth.uid() then c.hidden_a else c.hidden_b end, '-infinity')
      ))
  )
  -- Apagada e sem nada novo: não mostra a última mensagem antiga.
  select b.id, b.other_member, coalesce(om.name, b.other_saved_name), om.photo_path, om.role,
         case when b.last_message_at > coalesce(b.my_hidden, '-infinity') then b.last_message end,
         b.last_sender_id = auth.uid(), coalesce(b.last_message_at, b.created_at),
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
revoke execute on function public.my_conversations(uuid, uuid) from public, anon;
grant execute on function public.my_conversations(uuid, uuid) to authenticated;
