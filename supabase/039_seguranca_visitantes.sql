-- =====================================================================
-- Igreja Conecta — reforços do teste de vulnerabilidade (2026-11-02)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase. Pode rodar de novo sem problema.
--
-- 1. Cadastro de visitante: o limite por aparelho (5 por hora) usava o primeiro endereço do
--    x-forwarded-for, que pode vir do próprio pedido (dava para burlar o limite trocando o valor).
--    Agora usa o endereço que o Cloudflare informa (cf-connecting-ip). O limite por igreja (60 por
--    hora) continua igual.
-- 2. O visitante sem login deixa de poder chamar funções que ele não usa: as de gatilho (só rodam
--    quando um dado é gravado) e as de cálculo (datas, textos, limites). Não abriam brecha nenhuma;
--    é só arrumação. As usadas nas regras de leitura (is_member, is_leader, has_role,
--    my_church_ids, my_member_folders, is_platform_admin) continuam: para quem não está logado,
--    elas já respondem "não".
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Cadastro de visitante
-- ---------------------------------------------------------------------
create or replace function public.register_visitor(
  p_church uuid, p_name text, p_phone text, p_email text, p_first_time boolean, p_source text,
  p_wants_contact boolean, p_message text, p_consent boolean, p_website text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_headers json;
  v_ip text;
  v_hash text;
  v_id uuid;
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  -- Campo escondido que só robôs preenchem: finge que deu certo e não grava nada.
  if coalesce(p_website, '') <> '' then
    return true;
  end if;
  if not exists (
    select 1 from public.churches c
    where c.id = p_church and c.active and coalesce((c.features->>'visitantes')::boolean, false)
  ) then
    raise exception 'O cadastro de visitantes não está ligado nesta igreja.' using errcode = '42501';
  end if;
  if not coalesce(p_consent, false) then
    raise exception 'Para enviar, marque a autorização.' using errcode = '22023';
  end if;

  -- Limite de envios: por aparelho (endereço de internet, guardado só como impressão digital) e por igreja.
  -- O endereço vem do Cloudflare (cf-connecting-ip), que quem envia não consegue trocar. O primeiro
  -- valor do x-forwarded-for pode vir do próprio pedido: fica só como reserva.
  v_headers := coalesce(current_setting('request.headers', true), '{}')::json;
  v_ip := coalesce(nullif(trim(v_headers->>'cf-connecting-ip'), ''),
                   nullif(trim(v_headers->>'x-real-ip'), ''),
                   trim(split_part(coalesce(v_headers->>'x-forwarded-for', ''), ',', 1)));
  v_hash := case when v_ip <> '' then encode(extensions.digest(v_ip || ':' || p_church::text, 'sha256'), 'hex') end;
  if v_hash is not null and (select count(*) from public.visitors v
                             where v.ip_hash = v_hash and v.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Muitos cadastros enviados daqui. Tente de novo mais tarde.' using errcode = '54000';
  end if;
  if (select count(*) from public.visitors v
      where v.church_id = p_church and v.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Muitos cadastros nesta hora. Tente de novo mais tarde.' using errcode = '54000';
  end if;

  insert into public.visitors (church_id, name, phone, email, first_time, source, wants_contact, message, consent_at, ip_hash)
  values (p_church, v_name, nullif(trim(p_phone), ''), nullif(lower(trim(p_email)), ''), p_first_time,
          nullif(p_source, ''), coalesce(p_wants_contact, true), nullif(trim(p_message), ''), now(), v_hash)
  returning id into v_id;

  -- Aviso para a equipe dos visitantes ou, sem ela, para a liderança (central do app e celular).
  -- O texto do visitante não vai na notificação.
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select d.user_id, p_church, 'visitante',
         'Novo visitante: ' || split_part(v_name, ' ', 1),
         concat_ws(' · ',
           case when p_first_time then 'Primeira vez' end,
           case when coalesce(p_wants_contact, true) then 'Quer que alguém fale com ele' else 'Não pediu contato' end),
         '#/visitantes/' || v_id, 'visitante:' || v_id, true
  from (
    select t.user_id from public.visitor_team_users(p_church) t(user_id)
    union
    select m.user_id from public.members m
    where m.church_id = p_church and m.role in ('admin', 'secretaria', 'lider') and m.status = 'ativo'
      and m.user_id is not null and m.consent_at is not null
      and not exists (select 1 from public.visitor_team_users(p_church))
  ) d
  on conflict do nothing;
  return true;
end $$;
revoke execute on function public.register_visitor(uuid, text, text, text, boolean, text, boolean, text, boolean, text) from public;
grant execute on function public.register_visitor(uuid, text, text, text, boolean, text, boolean, text, boolean, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Funções que o visitante sem login não usa
-- ---------------------------------------------------------------------
-- De gatilho: o banco confere a permissão quando o gatilho é criado, não quando ele roda.
revoke execute on function public.announcements_guard() from public, anon;
revoke execute on function public.churches_touch() from public, anon;
revoke execute on function public.members_guard() from public, anon;
revoke execute on function public.prayer_requests_guard() from public, anon;

-- De cálculo: continuam para quem está logado (as regras e as checagens das tabelas usam).
revoke execute on function public.email_daily_limit() from public, anon;
revoke execute on function public.gallery_limit() from public, anon;
revoke execute on function public.is_birthday(date, date) from public, anon;
revoke execute on function public.years_text(integer) from public, anon;
revoke execute on function public.render_template(text, text, text, integer) from public, anon;
revoke execute on function public.unaccent_lower(text) from public, anon;
revoke execute on function public.today_br() from public, anon;
revoke execute on function public.reading_plan_days(text) from public, anon;
revoke execute on function public.reading_plan_title(text) from public, anon;
revoke execute on function public.social_links_ok(jsonb) from public, anon;
revoke execute on function public.push_endpoint_ok(text) from public, anon;
grant execute on function public.email_daily_limit() to authenticated;
grant execute on function public.gallery_limit() to authenticated;
grant execute on function public.is_birthday(date, date) to authenticated;
grant execute on function public.years_text(integer) to authenticated;
grant execute on function public.render_template(text, text, text, integer) to authenticated;
grant execute on function public.unaccent_lower(text) to authenticated;
grant execute on function public.today_br() to authenticated;
grant execute on function public.reading_plan_days(text) to authenticated;
grant execute on function public.reading_plan_title(text) to authenticated;
grant execute on function public.social_links_ok(jsonb) to authenticated;
grant execute on function public.push_endpoint_ok(text) to authenticated;
