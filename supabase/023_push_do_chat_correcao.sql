-- =====================================================================
-- Igreja Conecta — correção do aviso do chat no celular
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- A versão do 022 dava erro no banco quando havia um celular para avisar (nos testes,
-- as igrejas de teste não chegam nessa parte). Aqui a mesma regra, em passos simples:
-- 1. marca a mensagem como avisada (só uma vez, só com menos de 5 minutos);
-- 2. descobre quem recebe (a outra pessoa, se a conversa não está bloqueada);
-- 3. devolve os celulares dela, se ainda for da igreja e aceitar mensagens.
-- O aviso continua sem o texto da mensagem.
-- =====================================================================

create or replace function public.message_push_targets(p_secret text, p_message uuid)
returns table (endpoint text, p256dh text, auth text, conversation_id uuid, church_slug text, church_name text, sender_name text)
language plpgsql security definer set search_path = '' as $$
declare
  v_conv uuid;
  v_sender uuid;
  v_church uuid;
  v_to uuid;
  v_saved text;
  v_name text;
begin
  perform public.envio_check_secret(p_secret);

  update public.messages as msg
     set pushed_at = now()
   where msg.id = p_message and msg.pushed_at is null and msg.created_at > now() - interval '5 minutes'
  returning msg.conversation_id, msg.sender_id, msg.church_id into v_conv, v_sender, v_church;
  if v_conv is null then
    return;
  end if;

  select case when c.user_a = v_sender then c.user_b else c.user_a end,
         case when c.user_a = v_sender then c.name_a else c.name_b end
    into v_to, v_saved
  from public.conversations as c
  where c.id = v_conv and c.blocked_by is null;
  if v_to is null then
    return;
  end if;

  -- Quem recebe precisa continuar na igreja (ativo, com o convite aceito) e aceitar mensagens.
  if not exists (
    select 1 from public.members as rm
    where rm.user_id = v_to and rm.church_id = v_church
      and rm.status = 'ativo' and rm.consent_at is not null and rm.chat_enabled
  ) then
    return;
  end if;

  select sm.name into v_name from public.members as sm where sm.church_id = v_church and sm.user_id = v_sender limit 1;
  v_name := split_part(coalesce(v_name, v_saved, 'Alguém'), ' ', 1);

  return query
  select ps.endpoint::text, ps.p256dh::text, ps.auth::text, v_conv, ch.slug::text, ch.name::text, v_name
  from public.push_subscriptions as ps
  join public.churches as ch on ch.id = v_church and ch.active and not ch.is_test  -- igrejas de teste não mandam push
  where ps.user_id = v_to;
end $$;
revoke execute on function public.message_push_targets(text, uuid) from public;
grant execute on function public.message_push_targets(text, uuid) to anon;
