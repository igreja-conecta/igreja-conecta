-- =====================================================================
-- Igreja Conecta — financeiro e prestação de contas
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - O app só registra: o dinheiro não passa por ele
-- - Tesouraria: o admin e os membros que ele marca (members.treasury) lançam
--   entradas, saídas e transferências entre contas; ninguém mais vê os lançamentos
-- - Valores em centavos (número inteiro), para não errar arredondamento
-- - Fechar o mês trava os lançamentos dele; reabrir fica registrado
-- - Prestação de contas: publicado o mês, todos os membros veem só os totais por
--   categoria e o saldo (finance_report), nunca os lançamentos
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Funcionalidade, tipo de notificação e a marca "Tesouraria"
-- ---------------------------------------------------------------------
create or replace function public.finance_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'financeiro')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.finance_on(uuid) from public, anon;
grant execute on function public.finance_on(uuid) to authenticated;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'oracao', 'visitante',
                  'devocional', 'leitura', 'escala', 'inscricao', 'infantil', 'galeria', 'chat', 'financeiro'));

-- Fora da lista de colunas que o app altera: só muda por set_treasury (o admin).
alter table public.members add column if not exists treasury boolean not null default false;

-- Cadastro novo (ou planilha) com a marca: só o admin.
create or replace function public.members_treasury_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.treasury is not distinct from old.treasury then
      return new;
    end if;
  elsif not new.treasury then
    return new;
  end if;
  if not public.has_role(new.church_id, 'admin') then
    raise exception 'Só o administrador da igreja define a tesouraria.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists members_treasury_guard on public.members;
create trigger members_treasury_guard before insert or update of treasury on public.members
  for each row execute function public.members_treasury_guard();
revoke execute on function public.members_treasury_guard() from public, anon, authenticated;

create or replace function public.set_treasury(p_member uuid, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid;
begin
  select church_id into v_church from public.members where id = p_member;
  if v_church is null or not public.has_role(v_church, 'admin') then
    raise exception 'Só o administrador da igreja define a tesouraria.' using errcode = '42501';
  end if;
  update public.members set treasury = p_on where id = p_member;
end $$;
revoke execute on function public.set_treasury(uuid, boolean) from public, anon;
grant execute on function public.set_treasury(uuid, boolean) to authenticated;

-- Quem cuida do financeiro: o admin e a tesouraria, com a funcionalidade ligada.
create or replace function public.is_treasury(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.finance_on(p_church) and exists (
    select 1 from public.members m
    where m.church_id = p_church and m.user_id = auth.uid()
      and m.status = 'ativo' and m.consent_at is not null
      and (m.role = 'admin' or m.treasury)
  )
$$;
revoke execute on function public.is_treasury(uuid) from public, anon;
grant execute on function public.is_treasury(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.fin_accounts (
  id            uuid primary key default gen_random_uuid(),
  church_id     uuid not null references public.churches on delete cascade,
  name          text not null check (char_length(name) between 2 and 60),
  opening_cents bigint not null default 0 check (abs(opening_cents) < 100000000000),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists fin_accounts_church_idx on public.fin_accounts (church_id);

create table if not exists public.fin_categories (
  id         uuid primary key default gen_random_uuid(),
  church_id  uuid not null references public.churches on delete cascade,
  kind       text not null check (kind in ('entrada', 'saida')),
  name       text not null check (char_length(name) between 2 and 60),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists fin_categories_name_idx on public.fin_categories (church_id, kind, lower(name));

-- Entrada e saída têm categoria; transferência leva de uma conta (account_id) para outra (to_account_id).
create table if not exists public.fin_entries (
  id            uuid primary key default gen_random_uuid(),
  church_id     uuid not null references public.churches on delete cascade,
  kind          text not null check (kind in ('entrada', 'saida', 'transferencia')),
  entry_date    date not null default public.today_br(),
  amount_cents  bigint not null check (amount_cents > 0 and amount_cents < 100000000000),
  account_id    uuid not null references public.fin_accounts,
  to_account_id uuid references public.fin_accounts,
  category_id   uuid references public.fin_categories,
  description   text check (char_length(description) <= 200),
  deleted_at    timestamptz,
  created_by    uuid default auth.uid() references auth.users on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((kind = 'transferencia') = (to_account_id is not null)),
  check ((kind = 'transferencia') = (category_id is null)),
  check (to_account_id is distinct from account_id)
);
create index if not exists fin_entries_church_idx on public.fin_entries (church_id, entry_date desc);

-- Meses fechados e publicados. Só muda por finance_close_month / finance_reopen_month.
create table if not exists public.fin_months (
  church_id    uuid not null references public.churches on delete cascade,
  month        date not null check (extract(day from month) = 1),
  closed_at    timestamptz,
  closed_by    uuid references auth.users on delete set null,
  note         text check (char_length(note) <= 1000),
  reopened_at  timestamptz,
  reopened_by  uuid references auth.users on delete set null,
  primary key (church_id, month)
);

-- ---------------------------------------------------------------------
-- 3. Regras de acesso: só a tesouraria
-- ---------------------------------------------------------------------
alter table public.fin_accounts enable row level security;
drop policy if exists "contas tesouraria" on public.fin_accounts;
create policy "contas tesouraria" on public.fin_accounts for all to authenticated
  using (public.is_treasury(church_id)) with check (public.is_treasury(church_id));
revoke all on public.fin_accounts from anon;
revoke update on public.fin_accounts from authenticated;
grant update (name, opening_cents, active) on public.fin_accounts to authenticated;
revoke delete on public.fin_accounts from authenticated;

alter table public.fin_categories enable row level security;
drop policy if exists "categorias tesouraria" on public.fin_categories;
create policy "categorias tesouraria" on public.fin_categories for all to authenticated
  using (public.is_treasury(church_id)) with check (public.is_treasury(church_id));
revoke all on public.fin_categories from anon;
revoke update on public.fin_categories from authenticated;
grant update (name, active) on public.fin_categories to authenticated;
revoke delete on public.fin_categories from authenticated;

-- Lançamento apagado fica guardado (deleted_at): o "Desfazer" só limpa a data.
alter table public.fin_entries enable row level security;
drop policy if exists "lancamentos tesouraria" on public.fin_entries;
create policy "lancamentos tesouraria" on public.fin_entries for all to authenticated
  using (public.is_treasury(church_id)) with check (public.is_treasury(church_id));
revoke all on public.fin_entries from anon;
revoke update on public.fin_entries from authenticated;
grant update (kind, entry_date, amount_cents, account_id, to_account_id, category_id, description, deleted_at)
  on public.fin_entries to authenticated;
revoke delete on public.fin_entries from authenticated;

alter table public.fin_months enable row level security;
drop policy if exists "meses tesouraria" on public.fin_months;
create policy "meses tesouraria" on public.fin_months for select to authenticated
  using (public.is_treasury(church_id));
revoke all on public.fin_months from anon;
revoke insert, update, delete on public.fin_months from authenticated;

-- Conta e categoria da mesma igreja e do tipo certo; mês fechado não muda.
create or replace function public.fin_entries_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.church_id <> old.church_id or new.created_by is distinct from old.created_by or new.created_at <> old.created_at then
      raise exception 'Este campo não pode ser alterado.' using errcode = '42501';
    end if;
    if exists (select 1 from public.fin_months f where f.church_id = old.church_id
               and f.month = date_trunc('month', old.entry_date)::date and f.closed_at is not null) then
      raise exception 'Este mês está fechado. Reabra o mês para alterar.' using errcode = '42501';
    end if;
  else
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  if exists (select 1 from public.fin_months f where f.church_id = new.church_id
             and f.month = date_trunc('month', new.entry_date)::date and f.closed_at is not null) then
    raise exception 'Este mês está fechado. Reabra o mês para alterar.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.fin_accounts a where a.id = new.account_id and a.church_id = new.church_id)
     or (new.to_account_id is not null
         and not exists (select 1 from public.fin_accounts a where a.id = new.to_account_id and a.church_id = new.church_id)) then
    raise exception 'Conta inválida.' using errcode = '23514';
  end if;
  if new.category_id is not null
     and not exists (select 1 from public.fin_categories c where c.id = new.category_id and c.church_id = new.church_id and c.kind = new.kind) then
    raise exception 'Categoria inválida.' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists fin_entries_guard on public.fin_entries;
create trigger fin_entries_guard before insert or update on public.fin_entries
  for each row execute function public.fin_entries_guard();
revoke execute on function public.fin_entries_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Funções das telas
-- ---------------------------------------------------------------------
-- Primeira vez: cria as contas e as categorias mais comuns (a tesouraria muda depois).
create or replace function public.finance_setup(p_church uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_treasury(p_church) then
    raise exception 'Só a tesouraria da igreja.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.fin_accounts where church_id = p_church) then
    insert into public.fin_accounts (church_id, name) values (p_church, 'Caixa'), (p_church, 'Banco');
  end if;
  if not exists (select 1 from public.fin_categories where church_id = p_church) then
    insert into public.fin_categories (church_id, kind, name)
    select p_church, k, n from (values
      ('entrada', 'Dízimos'), ('entrada', 'Ofertas'), ('entrada', 'Missões'), ('entrada', 'Eventos'), ('entrada', 'Doações'),
      ('saida', 'Aluguel'), ('saida', 'Água e luz'), ('saida', 'Manutenção'), ('saida', 'Ação social'),
      ('saida', 'Salários e ajudas de custo'), ('saida', 'Outras despesas')
    ) as d(k, n);
  end if;
end $$;
revoke execute on function public.finance_setup(uuid) from public, anon;
grant execute on function public.finance_setup(uuid) to authenticated;

-- Saldo de cada conta no fim do dia p_until (saldo inicial + entradas − saídas ± transferências).
create or replace function public.finance_balances(p_church uuid, p_until date)
returns table (account_id uuid, balance_cents bigint)
language sql stable security definer set search_path = '' as $$
  select a.id, a.opening_cents + coalesce((
    select sum(case
                 when e.kind = 'entrada' then e.amount_cents
                 when e.kind = 'saida' then -e.amount_cents
                 when e.account_id = a.id then -e.amount_cents
                 else e.amount_cents
               end)
    from public.fin_entries e
    where e.church_id = p_church and e.deleted_at is null and e.entry_date <= p_until
      and (e.account_id = a.id or e.to_account_id = a.id)
  ), 0)::bigint
  from public.fin_accounts a
  where a.church_id = p_church and public.is_treasury(p_church)
$$;
revoke execute on function public.finance_balances(uuid, date) from public, anon;
grant execute on function public.finance_balances(uuid, date) to authenticated;

-- Prestação de contas de um mês: totais por categoria e saldo de todas as contas juntas.
-- A tesouraria vê qualquer mês; os membros, só os fechados (publicados).
create or replace function public.finance_report(p_church uuid, p_month date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  f public.fin_months;
  v_opening bigint;
begin
  select * into f from public.fin_months where church_id = p_church and month = v_month;
  if not public.is_treasury(p_church)
     and not (public.is_member(p_church) and public.finance_on(p_church) and f.closed_at is not null) then
    raise exception 'Prestação de contas não encontrada.' using errcode = '42501';
  end if;
  select coalesce(sum(opening_cents), 0) into v_opening from public.fin_accounts where church_id = p_church;
  return jsonb_build_object(
    'month', v_month,
    'published_at', f.closed_at,
    'note', f.note,
    'opening_cents', v_opening + coalesce((
      select sum(case e.kind when 'entrada' then e.amount_cents else -e.amount_cents end)
      from public.fin_entries e
      where e.church_id = p_church and e.deleted_at is null and e.kind <> 'transferencia' and e.entry_date < v_month), 0),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('kind', x.kind, 'name', x.name, 'cents', x.cents) order by x.kind, x.cents desc)
      from (
        select e.kind, c.name, sum(e.amount_cents)::bigint as cents
        from public.fin_entries e join public.fin_categories c on c.id = e.category_id
        where e.church_id = p_church and e.deleted_at is null and e.entry_date between v_month and v_end
        group by e.kind, c.name
      ) x), '[]'::jsonb)
  );
end $$;
revoke execute on function public.finance_report(uuid, date) from public, anon;
grant execute on function public.finance_report(uuid, date) to authenticated;

-- Meses publicados (lista da prestação de contas), do mais novo para o mais antigo.
create or replace function public.finance_published(p_church uuid)
returns table (month date, published_at timestamptz, in_cents bigint, out_cents bigint)
language sql stable security definer set search_path = '' as $$
  select f.month, f.closed_at,
    coalesce((select sum(e.amount_cents) from public.fin_entries e where e.church_id = p_church and e.deleted_at is null
              and e.kind = 'entrada' and date_trunc('month', e.entry_date) = f.month), 0)::bigint,
    coalesce((select sum(e.amount_cents) from public.fin_entries e where e.church_id = p_church and e.deleted_at is null
              and e.kind = 'saida' and date_trunc('month', e.entry_date) = f.month), 0)::bigint
  from public.fin_months f
  where f.church_id = p_church and f.closed_at is not null
    and public.finance_on(p_church) and public.is_member(p_church)
  order by f.month desc
$$;
revoke execute on function public.finance_published(uuid) from public, anon;
grant execute on function public.finance_published(uuid) to authenticated;

-- Fechar e publicar o mês, com um recado opcional; os membros recebem o aviso.
create or replace function public.finance_close_month(p_church uuid, p_month date, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_label text;
begin
  if not public.is_treasury(p_church) then
    raise exception 'Só a tesouraria da igreja.' using errcode = '42501';
  end if;
  if v_month > date_trunc('month', public.today_br())::date then
    raise exception 'Este mês ainda não começou.' using errcode = '23514';
  end if;
  insert into public.fin_months (church_id, month, closed_at, closed_by, note)
  values (p_church, v_month, now(), auth.uid(), nullif(trim(left(p_note, 1000)), ''))
  on conflict (church_id, month) do update
    set closed_at = now(), closed_by = auth.uid(), note = excluded.note
    where public.fin_months.closed_at is null;
  if not found then
    raise exception 'Este mês já está fechado.' using errcode = '23514';
  end if;
  v_label := (array['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro',
                    'outubro', 'novembro', 'dezembro'])[extract(month from v_month)::int] || ' de ' || extract(year from v_month)::int;
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select m.user_id, p_church, 'financeiro', 'Prestação de contas de ' || v_label,
         'A tesouraria publicou as contas do mês.', '#/prestacao/' || to_char(v_month, 'YYYY-MM'),
         'financeiro:' || p_church || ':' || v_month, true
  from public.members m
  where m.church_id = p_church and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
  on conflict do nothing;
end $$;
revoke execute on function public.finance_close_month(uuid, date, text) from public, anon;
grant execute on function public.finance_close_month(uuid, date, text) to authenticated;

-- Reabrir para corrigir: some da prestação de contas até fechar de novo; fica registrado quem reabriu.
create or replace function public.finance_reopen_month(p_church uuid, p_month date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_treasury(p_church) then
    raise exception 'Só a tesouraria da igreja.' using errcode = '42501';
  end if;
  update public.fin_months set closed_at = null, reopened_at = now(), reopened_by = auth.uid()
  where church_id = p_church and month = date_trunc('month', p_month)::date and closed_at is not null;
end $$;
revoke execute on function public.finance_reopen_month(uuid, date) from public, anon;
grant execute on function public.finance_reopen_month(uuid, date) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Dados de teste: as igrejas de teste ligam o financeiro
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"financeiro": true}'::jsonb
where slug in ('teste-a', 'teste-b');
