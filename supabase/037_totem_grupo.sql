-- =====================================================================
-- Igreja Conecta — totem, modo grupo: vários rostos de uma vez
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - O totem manda os rostos que viu na imagem (até 10) numa chamada só
-- - Cada rosto passa pela mesma regra conservadora do face_match (035): só marca se estiver
--   bem perto de UM cadastro e longe do segundo mais parecido; na dúvida, ninguém
-- - A mesma pessoa aparece uma vez só na resposta
-- =====================================================================

create or replace function public.face_match_many(p_session uuid, p_embeddings jsonb, p_model text)
returns table (idx integer, member_id uuid, name text, already boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_n integer;
  v_seen uuid[] := '{}';
  v_vec real[];
  r record;
begin
  if p_embeddings is null or jsonb_typeof(p_embeddings) <> 'array' then
    raise exception 'Assinaturas dos rostos inválidas.';
  end if;
  v_n := jsonb_array_length(p_embeddings);
  if v_n > 10 then
    raise exception 'No máximo 10 rostos por vez.';
  end if;
  for i in 0 .. v_n - 1 loop
    if jsonb_typeof(p_embeddings -> i) <> 'array' then
      raise exception 'Assinatura do rosto inválida.';
    end if;
    select array_agg(x::real order by o) into v_vec
    from jsonb_array_elements_text(p_embeddings -> i) with ordinality as t(x, o);
    -- face_match confere a equipe, a funcionalidade e a assinatura, marca e avisa o membro.
    for r in select * from public.face_match(p_session, v_vec, p_model) loop
      if not (r.member_id = any (v_seen)) then
        v_seen := v_seen || r.member_id;
        return query select i, r.member_id, r.name, r.already;
      end if;
    end loop;
  end loop;
end $$;
revoke execute on function public.face_match_many(uuid, jsonb, text) from public, anon;
grant execute on function public.face_match_many(uuid, jsonb, text) to authenticated;
