-- =====================================================================
-- Igreja Conecta — volta as igrejas Teste A e Teste B ao que os testes esperam
-- Rode no SQL Editor do Supabase quando os testes avisarem que as igrejas
-- de teste "não estão como os testes esperam". Pode rodar quantas vezes quiser.
--
-- - Tira das igrejas de TESTE os cadastros que não são das contas de teste
--   (o seu cadastro na Igreja Exemplo e nas igrejas de verdade não muda)
-- - Devolve os papéis das contas de teste
-- Para experimentar o app, use a Igreja Exemplo, não as igrejas de teste.
-- =====================================================================

delete from public.members m
using public.churches c
where m.church_id = c.id
  and c.is_test
  and coalesce(m.email, '') not like '%@teste.igrejaconecta.invalid'
  and m.name not in ('Fulano da A', 'Fulano da B', 'Bissexto da A', 'Casada da A', 'Batizado da A');

update public.members m
set role = v.role, status = 'ativo'
from (values
  ('adm-a@teste.igrejaconecta.invalid', 'admin'),
  ('lider-a@teste.igrejaconecta.invalid', 'lider'),
  ('membro-a@teste.igrejaconecta.invalid', 'membro'),
  ('adm-b@teste.igrejaconecta.invalid', 'admin')
) as v(email, role)
where m.email = v.email;

-- Confira: só devem aparecer as contas de teste e os três cadastros sem conta.
select c.slug, m.name, m.role, m.email
from public.members m join public.churches c on c.id = m.church_id
where c.is_test
order by c.slug, m.name;
