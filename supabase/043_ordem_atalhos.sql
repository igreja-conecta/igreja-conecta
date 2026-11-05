-- 043: ordem dos atalhos do Início, escolhida pelo administrador arrastando e valendo para todos.
-- Rode no SQL Editor ANTES de publicar o app. Pode rodar de novo.

-- A ordem: lista das chaves dos atalhos (devocional, agenda, avisos...). Nula = ordem de sempre.
-- Atalho que não está na lista (função ligada depois) vai para o fim, na ordem de sempre.
alter table public.churches add column if not exists home_order text[];

alter table public.churches drop constraint if exists churches_home_order_ok;
alter table public.churches add constraint churches_home_order_ok check (
  home_order is null
  or cardinality(home_order) = 0
  or (cardinality(home_order) <= 60
      and array_to_string(home_order, ',') ~ '^([a-z_]{1,30}(,|$))+$')
);

-- Só a coluna é liberada. Quem grava continua decidido pela regra "churches admin edita" (001):
-- só o administrador da própria igreja. Mudar a ordem não republica o site (o gatilho
-- churches_publish do 007 só olha nome, cor, logo, boas-vindas, endereço e situação).
grant update (home_order) on public.churches to authenticated;

-- Confira: deve aparecer a coluna home_order (tipo ARRAY).
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'churches' and column_name = 'home_order';
