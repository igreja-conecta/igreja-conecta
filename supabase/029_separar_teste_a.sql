-- =====================================================================
-- Igreja Conecta — a "Teste A" que virou igreja de verdade ganha endereço
-- próprio, e os testes ganham uma Teste A nova
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
-- Pode rodar mais de uma vez.
--
-- - A Igreja Reformada de Brasília (que estava na Teste A) passa a ser uma
--   igreja de verdade em /i/reformada-brasilia/: tudo dela continua (membros,
--   agenda, avisos, fotos, financeiro…); agora manda e-mails e avisos e ganha
--   a página publicada (o site é publicado de novo sozinho)
-- - Saem dela só as pessoas de teste (contas @teste.igrejaconecta.invalid e
--   os cadastros "Fulano", "Bissexto", "Casada" e "Batizado da A")
-- - Nasce uma Teste A nova, vazia, só para os testes, com as contas de teste
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. A igreja de verdade sai das igrejas de teste
-- ---------------------------------------------------------------------
update public.churches
set slug = 'reformada-brasilia', is_test = false
where slug = 'teste-a' and name <> 'Igreja Teste A'
  and not exists (select 1 from public.churches x where x.slug = 'reformada-brasilia');

delete from public.members m
using public.churches c
where m.church_id = c.id and c.slug = 'reformada-brasilia'
  and (coalesce(m.email, '') like '%@teste.igrejaconecta.invalid'
       or (m.user_id is null and m.name in ('Fulano da A', 'Bissexto da A', 'Casada da A', 'Batizado da A')));

-- ---------------------------------------------------------------------
-- 2. A Teste A nova, com as mesmas funcionalidades da Teste B
-- ---------------------------------------------------------------------
insert into public.churches (slug, name, short_name, primary_color, is_test, welcome_text, features)
select 'teste-a', 'Igreja Teste A', 'Teste A', '#2b8a3e', true, 'Igreja usada pelos testes automáticos.',
       (select b.features || '{"chat_membros": false}'::jsonb from public.churches b where b.slug = 'teste-b')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- 3. Os cadastros que os testes usam (como no 002, 004, 008 e na limpeza)
-- ---------------------------------------------------------------------
insert into public.members (church_id, role, name, email)
select c.id, v.role, v.name, v.email
from (values
  ('admin',  'Admin da A',  'adm-a@teste.igrejaconecta.invalid'),
  ('lider',  'Líder da A',  'lider-a@teste.igrejaconecta.invalid'),
  ('membro', 'Membro da A', 'membro-a@teste.igrejaconecta.invalid')
) as v(role, name, email)
join public.churches c on c.slug = 'teste-a' and c.is_test
where not exists (select 1 from public.members m where m.church_id = c.id and lower(m.email) = v.email);

insert into public.members (church_id, role, name, phone, birth_date, show_birthday, wedding_date, show_wedding, baptism_date, show_baptism)
select c.id, 'membro', v.name, v.phone, v.birth_date::date, v.show_birthday, v.wedding_date::date, v.show_wedding, v.baptism_date::date, v.show_baptism
from (values
  ('Fulano da A',   '5561999990001', '1980-03-15', false, null,         false, null,         false),
  ('Bissexto da A', null,            '2000-02-29', true,  null,         false, null,         false),
  ('Casada da A',   null,            null,         false, '2010-06-12', true,  null,         false),
  ('Batizado da A', null,            null,         false, null,         false, '2020-06-20', false)
) as v(name, phone, birth_date, show_birthday, wedding_date, show_wedding, baptism_date, show_baptism)
join public.churches c on c.slug = 'teste-a' and c.is_test
where not exists (select 1 from public.members m where m.church_id = c.id and m.name = v.name);

-- Liga as contas de teste aos cadastros, já com o convite aceito.
update public.members m
set user_id = u.id, consent_at = coalesce(m.consent_at, now())
from auth.users u
where lower(m.email) = u.email
  and u.email like '%@teste.igrejaconecta.invalid'
  and m.church_id in (select id from public.churches where is_test)
  and m.user_id is distinct from u.id;

-- Confira: a Reformada de Brasília fora dos testes, e a Teste A nova com
-- Admin, Líder e Membro da A (com conta) e os quatro cadastros sem conta.
select c.slug, c.name, c.is_test, count(m.id) as pessoas, count(m.user_id) as com_conta
from public.churches c left join public.members m on m.church_id = c.id
where c.slug in ('reformada-brasilia', 'teste-a', 'teste-b')
group by c.slug, c.name, c.is_test
order by c.slug;
