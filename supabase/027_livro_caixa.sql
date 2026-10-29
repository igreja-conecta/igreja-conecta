-- =====================================================================
-- Igreja Conecta — "Prestação de contas" passa a se chamar "Livro caixa"
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- Só muda o título do aviso que os membros recebem quando a tesouraria
-- fecha e publica o mês. O resto da função é igual ao 026.
-- =====================================================================

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
  select m.user_id, p_church, 'financeiro', 'Livro caixa de ' || v_label,
         'A tesouraria publicou as contas do mês.', '#/prestacao/' || to_char(v_month, 'YYYY-MM'),
         'financeiro:' || p_church || ':' || v_month, true
  from public.members m
  where m.church_id = p_church and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
  on conflict do nothing;
end $$;
revoke execute on function public.finance_close_month(uuid, date, text) from public, anon;
grant execute on function public.finance_close_month(uuid, date, text) to authenticated;
