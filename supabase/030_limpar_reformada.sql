-- =====================================================================
-- Igreja Conecta — tira da Igreja Reformada de Brasília o que os testes
-- automáticos deixaram lá quando ela ainda era a Teste A
-- Rode depois do 029, no SQL Editor do Supabase. Pode rodar mais de uma vez.
--
-- Apaga, só nessa igreja, o que foi criado pelas contas de teste
-- (@teste.igrejaconecta.invalid): conversas, notificações, pedidos de oração,
-- eventos, avisos, devocionais, planos de leitura, crianças, álbuns,
-- lançamentos e meses fechados do financeiro e ATAs.
-- O que você e os membros de verdade criaram não muda.
-- =====================================================================

do $$
declare
  v_church uuid := (select id from public.churches where slug = 'reformada-brasilia' and not is_test);
  v_test uuid[] := array(select id from auth.users where email like '%@teste.igrejaconecta.invalid');
begin
  if v_church is null then
    raise notice 'Igreja reformada-brasilia não encontrada: rode o 029 antes.';
    return;
  end if;
  delete from public.conversations where church_id = v_church and (user_a = any (v_test) or user_b = any (v_test));
  delete from public.notifications where church_id = v_church and user_id = any (v_test);
  delete from public.prayer_requests where church_id = v_church and user_id = any (v_test);
  delete from public.events where church_id = v_church and created_by = any (v_test);
  delete from public.announcements where church_id = v_church and created_by = any (v_test);
  delete from public.devotionals where church_id = v_church and created_by = any (v_test);
  delete from public.reading_plans where church_id = v_church and created_by = any (v_test);
  delete from public.children where church_id = v_church and created_by = any (v_test);
  delete from public.gallery_albums where church_id = v_church and created_by = any (v_test);
  delete from public.fin_entries where church_id = v_church and created_by = any (v_test);
  delete from public.fin_months where church_id = v_church and closed_by = any (v_test);
  delete from public.meeting_minutes where church_id = v_church and created_by = any (v_test);
end $$;

-- Confira: tudo zero.
with t as (select id from auth.users where email like '%@teste.igrejaconecta.invalid'),
     c as (select id from public.churches where slug = 'reformada-brasilia')
select 'conversas' as o_que, count(*) from public.conversations, c where church_id = c.id and (user_a in (select id from t) or user_b in (select id from t))
union all select 'eventos', count(*) from public.events, c where church_id = c.id and created_by in (select id from t)
union all select 'avisos', count(*) from public.announcements, c where church_id = c.id and created_by in (select id from t)
union all select 'lançamentos', count(*) from public.fin_entries, c where church_id = c.id and created_by in (select id from t)
union all select 'álbuns', count(*) from public.gallery_albums, c where church_id = c.id and created_by in (select id from t);
