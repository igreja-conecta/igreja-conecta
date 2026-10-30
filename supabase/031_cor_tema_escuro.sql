-- =====================================================================
-- Igreja Conecta — cor dos links e ícones no tema escuro
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- O administrador escolhe, em Configurar a igreja > Aparência, se no tema
-- escuro os links e ícones usam a cor principal clareada (padrão, como já
-- era) ou a cor principal pura. Botões e o "+" usam a cor principal nos dois.
-- =====================================================================

alter table public.churches add column if not exists dark_brand text not null default 'clara'
  check (dark_brand in ('clara', 'principal'));
grant update (dark_brand) on public.churches to authenticated;
