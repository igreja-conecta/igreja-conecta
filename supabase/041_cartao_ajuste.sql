-- =====================================================================
-- Igreja Conecta — cartão de aniversário com o texto em qualquer lugar (2026-11-03)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase. Pode rodar de novo sem problema.
--
-- Em vez de só "em cima / no meio / embaixo", a liderança arrasta o texto na prévia e ajusta o
-- tamanho das letras e a largura da área do texto, para encaixar no espaço livre da arte.
-- Tudo em % da imagem: card_x e card_y são o centro da área do texto; card_width é a largura
-- dela; card_size é o tamanho das letras (100 = normal). O card_position (040) fica só para
-- os cartões já salvos, que viram a posição livre equivalente.
-- =====================================================================

alter table public.message_templates
  add column if not exists card_x smallint,
  add column if not exists card_y smallint,
  add column if not exists card_width smallint not null default 84,
  add column if not exists card_size smallint not null default 100;

-- Quem já tinha salvo "em cima" ou "embaixo" continua igual.
update public.message_templates
set card_x = 50, card_y = case card_position when 'topo' then 25 when 'base' then 75 else 50 end
where card_x is null or card_y is null;
alter table public.message_templates alter column card_x set default 50, alter column card_x set not null;
alter table public.message_templates alter column card_y set default 50, alter column card_y set not null;

alter table public.message_templates drop constraint if exists message_templates_card_place;
alter table public.message_templates add constraint message_templates_card_place check (
  card_x between 0 and 100 and card_y between 0 and 100
  and card_width between 30 and 100 and card_size between 40 and 250
);
grant update (card_x, card_y, card_width, card_size) on public.message_templates to authenticated;

-- O envio das 7h recebe a posição livre (muda o formato da resposta, então é recriada).
drop function if exists public.claim_celebration_cards(text);
create function public.claim_celebration_cards(p_secret text)
returns table (member_id uuid, kind text, target_date date, church_slug text, church_name text, name text, years integer,
               title text, body text, image_url text, card_color text,
               card_x smallint, card_y smallint, card_width smallint, card_size smallint, card_url text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_today date := public.today_br();
begin
  perform public.envio_check_secret(p_secret);
  return query
  select c.member_id, c.kind, d::date, c.church_slug, c.church_name, c.name, c.years, c.title, c.body, c.image_url,
         t.card_color, t.card_x, t.card_y, t.card_width, t.card_size, cc.url
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
