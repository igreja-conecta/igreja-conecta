-- =====================================================================
-- Igreja Conecta — cartão de aniversário (2026-11-03)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase. Pode rodar de novo sem problema.
--
-- Na Mensagem de aniversário (e de casamento e batismo), a liderança pode escrever o título e a
-- mensagem por cima da imagem, como um cartão, escolhendo a posição (em cima, no meio, embaixo)
-- e a cor do texto. Às 7h o envio (scripts/enviar-aniversarios.mjs) gera um cartão para cada
-- pessoa, com o nome e a idade dela, guarda no Storage (função guardar-cartao) e usa o mesmo
-- cartão no e-mail, na notificação do celular e no sininho do app.
-- =====================================================================

-- 1. Opções do cartão na mensagem.
alter table public.message_templates
  add column if not exists card boolean not null default false,
  add column if not exists card_position text not null default 'meio',
  add column if not exists card_color text not null default 'claro';
alter table public.message_templates drop constraint if exists message_templates_card_position;
alter table public.message_templates add constraint message_templates_card_position check (card_position in ('topo', 'meio', 'base'));
alter table public.message_templates drop constraint if exists message_templates_card_color;
alter table public.message_templates add constraint message_templates_card_color check (card_color in ('claro', 'escuro'));
grant update (card, card_position, card_color) on public.message_templates to authenticated;

-- 2. O sininho mostra o cartão.
alter table public.notifications add column if not exists image_url text;
alter table public.notifications drop constraint if exists notifications_image_https;
alter table public.notifications add constraint notifications_image_https
  check (image_url is null or (char_length(image_url) <= 500 and image_url ~* '^https://'));

-- 3. Cartões já gerados (um por pessoa, tipo e dia): quem roda o envio de novo no mesmo dia, ou o
--    e-mail que ficou para o dia seguinte por causa do limite, usa o mesmo cartão.
--    Só as funções do envio mexem aqui (sem regra de leitura: ninguém do app lê esta tabela).
create table if not exists public.celebration_cards (
  member_id   uuid not null references public.members on delete cascade,
  kind        text not null check (kind in ('aniversario', 'casamento', 'batismo')),
  target_date date not null,
  url         text not null check (char_length(url) <= 500 and url ~* '^https://'),
  created_at  timestamptz not null default now(),
  primary key (member_id, kind, target_date)
);
alter table public.celebration_cards enable row level security;
revoke all on public.celebration_cards from public, anon, authenticated;

-- 4. Cartões do dia para o envio: os de hoje (com o cartão já gerado, se houver) e os dos 2 dias
--    anteriores que já foram gerados (para os e-mails atrasados pelo limite diário).
create or replace function public.claim_celebration_cards(p_secret text)
returns table (member_id uuid, kind text, target_date date, church_slug text, church_name text, name text, years integer,
               title text, body text, image_url text, card_position text, card_color text, card_url text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_today date := public.today_br();
begin
  perform public.envio_check_secret(p_secret);
  return query
  select c.member_id, c.kind, d::date, c.church_slug, c.church_name, c.name, c.years, c.title, c.body, c.image_url,
         t.card_position, t.card_color, cc.url
  from generate_series(v_today - 2, v_today, interval '1 day') as d
  cross join lateral public.celebration_candidates(d::date) c
  join public.message_templates t on t.church_id = c.church_id and t.kind = c.kind
  left join public.celebration_cards cc on cc.member_id = c.member_id and cc.kind = c.kind and cc.target_date = d::date
  where t.card and c.image_url is not null
    and (c.send_push or c.send_email or (c.user_id is not null and c.consent))
    and (d::date = v_today or cc.url is not null);
end $$;
revoke execute on function public.claim_celebration_cards(text) from public, anon, authenticated;
grant execute on function public.claim_celebration_cards(text) to anon;

-- 5. Guarda o cartão gerado e o coloca na notificação do sininho da pessoa.
--    Só aceita endereço da pasta de cartões do Storage deste projeto.
create or replace function public.save_celebration_card(p_secret text, p_member uuid, p_kind text, p_date date, p_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_member public.members;
begin
  perform public.envio_check_secret(p_secret);
  if p_url !~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/igrejas/cartoes/[a-z0-9-]+/[0-9a-f-]+\.jpg$' then
    raise exception 'Endereço de cartão inválido.';
  end if;
  select * into v_member from public.members where id = p_member;
  if not found then return; end if;

  insert into public.celebration_cards (member_id, kind, target_date, url)
  values (p_member, p_kind, p_date, p_url)
  on conflict (member_id, kind, target_date) do update set url = excluded.url;

  if v_member.user_id is not null then
    update public.notifications
    set image_url = p_url
    where user_id = v_member.user_id
      and dedupe_key = p_kind || ':' || v_member.church_id || ':' || p_date;
  end if;

  -- Limpeza: cartões com mais de 40 dias saem da lista (os arquivos, a função guardar-cartao apaga).
  delete from public.celebration_cards where target_date < public.today_br() - 40;
end $$;
revoke execute on function public.save_celebration_card(text, uuid, text, date, text) from public, anon, authenticated;
grant execute on function public.save_celebration_card(text, uuid, text, date, text) to anon;
