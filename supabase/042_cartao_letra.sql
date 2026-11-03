-- =====================================================================
-- Igreja Conecta — cartão de aniversário: letra e cor do texto (2026-11-03)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase. Pode rodar de novo sem problema.
--
-- A liderança escolhe a letra do cartão (fonts/cartao/, ver js/cartao.js) e qualquer cor para o
-- texto. Quem já tinha salvo "Texto branco" ou "Texto escuro" (card_color) continua igual.
-- =====================================================================

alter table public.message_templates
  add column if not exists card_font text not null default 'padrao',
  add column if not exists card_text_color text;

update public.message_templates
set card_text_color = case card_color when 'escuro' then '#1b1e27' else '#ffffff' end
where card_text_color is null;
alter table public.message_templates alter column card_text_color set default '#ffffff', alter column card_text_color set not null;

alter table public.message_templates drop constraint if exists message_templates_card_font;
alter table public.message_templates add constraint message_templates_card_font check (
  card_font in ('padrao', 'montserrat', 'lora', 'playfair', 'dancing', 'caveat', 'greatvibes', 'pacifico')
);
alter table public.message_templates drop constraint if exists message_templates_card_text_color;
alter table public.message_templates add constraint message_templates_card_text_color check (card_text_color ~ '^#[0-9a-f]{6}$');
grant update (card_font, card_text_color) on public.message_templates to authenticated;

-- O envio das 7h recebe a letra e a cor (muda o formato da resposta, então é recriada).
drop function if exists public.claim_celebration_cards(text);
create function public.claim_celebration_cards(p_secret text)
returns table (member_id uuid, kind text, target_date date, church_slug text, church_name text, name text, years integer,
               title text, body text, image_url text, card_color text, card_font text, card_text_color text,
               card_x smallint, card_y smallint, card_width smallint, card_size smallint, card_url text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_today date := public.today_br();
begin
  perform public.envio_check_secret(p_secret);
  return query
  select c.member_id, c.kind, d::date, c.church_slug, c.church_name, c.name, c.years, c.title, c.body, c.image_url,
         t.card_color, t.card_font, t.card_text_color, t.card_x, t.card_y, t.card_width, t.card_size, cc.url
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
