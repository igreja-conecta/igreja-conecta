-- =====================================================================
-- Igreja Conecta — fundo do app no tema escuro: preto ou a cor principal
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- O administrador escolhe, em Configurar a igreja > Aparência, se no tema
-- escuro o fundo do app fica preto (padrão, como já era) ou na cor principal
-- da igreja. Troca a opção do 031 (cor dos links e ícones), que sai.
--
-- Atenção: depois de rodar, até o app novo entrar no ar, salvar em
-- Configurar a igreja dá erro (o app antigo ainda manda a opção do 031).
-- =====================================================================

alter table public.churches add column if not exists dark_theme text not null default 'preto'
  check (dark_theme in ('preto', 'principal'));
grant update (dark_theme) on public.churches to authenticated;

alter table public.churches drop column if exists dark_brand;
