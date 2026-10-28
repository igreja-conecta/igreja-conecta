-- =====================================================================
-- Igreja Conecta — chat: lista completa de com quem a pessoa pode conversar
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- A tela "Nova conversa" passa a mostrar a lista toda (e a busca filtra no aparelho).
-- As regras não mudam: só gente da mesma igreja, ativa, com o app e recebendo mensagens;
-- a liderança chama qualquer membro; o membro chama a liderança e, se a igreja ligou o
-- chat entre membros, os outros membros.
-- =====================================================================

-- Troca a função (agora com p_all); a versão antiga sai para não ficarem duas com o mesmo nome.
drop function if exists public.chat_contacts(uuid, text);
create or replace function public.chat_contacts(p_church uuid, p_search text default null, p_all boolean default false)
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
    -- Quem a pessoa pode chamar.
    and (v_leader or m.role in ('admin', 'secretaria', 'lider') or public.chat_members_on(p_church))
    and (
      p_all
      or (char_length(v_term) < 2 and m.role in ('admin', 'secretaria', 'lider'))
      or (char_length(v_term) >= 2 and public.unaccent_lower(m.name) like '%' || v_term || '%')
    )
  order by case m.role when 'admin' then 0 when 'lider' then 1 when 'secretaria' then 2 else 3 end, m.name
  limit case when p_all then 1000 else 30 end;
end $$;
revoke execute on function public.chat_contacts(uuid, text, boolean) from public, anon;
grant execute on function public.chat_contacts(uuid, text, boolean) to authenticated;
