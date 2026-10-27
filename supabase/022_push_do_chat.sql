-- =====================================================================
-- Igreja Conecta — chat, entrega 2: notificação no celular na hora
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- Como no Desapega (010 de lá): quando uma mensagem é gravada, o próprio
-- banco chama (pg_net) a função "enviar-push" (supabase/functions/enviar-push),
-- que avisa os aparelhos da outra pessoa da conversa.
-- - Cada mensagem gera no máximo um aviso (pushed_at) e só se tiver menos de
--   5 minutos: chamar a função de novo não gera aviso extra
-- - O aviso mostra só quem escreveu, nunca o texto da mensagem (a tela do
--   celular bloqueado pode ser vista por outras pessoas)
-- - Falha no aviso nunca impede a mensagem
-- A função lê os aparelhos com a mesma senha dos lembretes (ENVIO_SECRET), gravada
-- nela pelo workflow funcoes.yml; aqui fica só o hash (envio_check_secret).
-- =====================================================================

-- Aparelhos de quem deve ser avisado sobre a mensagem (a outra pessoa da conversa, se ainda
-- for da igreja e receber mensagens). Já marca a mensagem como avisada.
create or replace function public.message_push_targets(p_secret text, p_message uuid)
returns table (endpoint text, p256dh text, auth text, conversation_id uuid, church_slug text, church_name text, sender_name text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.envio_check_secret(p_secret);
  return query
  with m as (
    update public.messages
       set pushed_at = now()
     where id = p_message and pushed_at is null and created_at > now() - interval '5 minutes'
    returning messages.conversation_id, messages.sender_id, messages.church_id
  ), dest as (
    select m.conversation_id, m.church_id, m.sender_id,
           case when c.user_a = m.sender_id then c.user_b else c.user_a end as user_id,
           case when c.user_a = m.sender_id then c.name_a else c.name_b end as sender_saved
    from m join public.conversations c on c.id = m.conversation_id
    where c.blocked_by is null
  )
  select ps.endpoint, ps.p256dh, ps.auth, d.conversation_id, ch.slug, ch.name,
         split_part(coalesce(sm.name, d.sender_saved), ' ', 1)
  from dest d
  join public.churches ch on ch.id = d.church_id and ch.active and not ch.is_test  -- igrejas de teste não mandam push
  join public.members rm on rm.user_id = d.user_id and rm.church_id = d.church_id
                        and rm.status = 'ativo' and rm.consent_at is not null and rm.chat_enabled
  join public.push_subscriptions ps on ps.user_id = d.user_id
  left join public.members sm on sm.church_id = d.church_id and sm.user_id = d.sender_id;
end $$;
revoke execute on function public.message_push_targets(text, uuid) from public;
grant execute on function public.message_push_targets(text, uuid) to anon;

-- Mensagem gravada: o banco chama a função na hora (sem login; ela só age com mensagens recentes
-- e ainda não avisadas).
create or replace function public.chat_push_new_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://lmukzyonnggwwwjrfywy.supabase.co/functions/v1/enviar-push',
    body := jsonb_build_object('hook_message_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 5000
  );
  return null;
exception when others then
  return null; -- falha no aviso nunca impede a mensagem
end $$;
revoke execute on function public.chat_push_new_message() from public, anon, authenticated;

drop trigger if exists messages_push on public.messages;
create trigger messages_push after insert on public.messages
  for each row execute function public.chat_push_new_message();
