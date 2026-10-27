-- =====================================================================
-- Igreja Conecta — relatórios para a liderança (Fase 3)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - Uma função calcula os números da igreja no período escolhido (até 400 dias)
-- - Só a liderança da própria igreja (administrador, secretaria e líderes),
--   com a funcionalidade "Relatórios" ligada
-- - Só totais: nenhum nome ou dado pessoal (pedidos de oração, só a contagem)
-- - Cada parte só vem com a funcionalidade dela ligada
-- =====================================================================

create or replace function public.church_report(p_church uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_features jsonb;
  v_from timestamptz;
  v_to timestamptz;
  v_out jsonb;
begin
  if not public.is_leader(p_church) then
    raise exception 'Só a liderança da igreja vê os relatórios.' using errcode = '42501';
  end if;
  select c.features into v_features from public.churches c where c.id = p_church and c.active;
  if not coalesce((v_features->>'relatorios')::boolean, false) then
    raise exception 'Os relatórios estão desligados nesta igreja.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Período inválido (até 400 dias).';
  end if;
  v_from := p_from::timestamp at time zone 'America/Sao_Paulo';
  v_to := (p_to + 1)::timestamp at time zone 'America/Sao_Paulo';

  -- Membros
  v_out := jsonb_build_object(
    'periodo', jsonb_build_object('de', p_from, 'ate', p_to),
    'membros', (
      with ms as (select * from public.members m where m.church_id = p_church),
      meses as (select generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month')::date as mes)
      select jsonb_build_object(
        'ativos', (select count(*) from ms where status = 'ativo'),
        'inativos', (select count(*) from ms where status = 'inativo'),
        'no_app', (select count(*) from ms where status = 'ativo' and user_id is not null and consent_at is not null),
        'por_papel', (select coalesce(jsonb_object_agg(role, n), '{}'::jsonb)
                      from (select role, count(*) n from ms where status = 'ativo' group by role) x),
        'novos_por_mes', (select jsonb_agg(jsonb_build_object('mes', to_char(mes, 'YYYY-MM'), 'total', (
                            select count(*) from ms
                            where coalesce(ms.member_since, (ms.created_at at time zone 'America/Sao_Paulo')::date) >= greatest(mes, p_from)
                              and coalesce(ms.member_since, (ms.created_at at time zone 'America/Sao_Paulo')::date) < least((mes + interval '1 month')::date, p_to + 1)))
                            order by mes) from meses),
        'novos', (select count(*) from ms
                  where coalesce(member_since, (created_at at time zone 'America/Sao_Paulo')::date) between p_from and p_to),
        'faixa_etaria', (select jsonb_build_object(
                           'criancas', count(*) filter (where idade < 12),
                           'adolescentes', count(*) filter (where idade between 12 and 17),
                           'jovens', count(*) filter (where idade between 18 and 29),
                           'adultos', count(*) filter (where idade between 30 and 59),
                           'idosos', count(*) filter (where idade >= 60),
                           'sem_data', count(*) filter (where idade is null))
                         from (select extract(year from age(public.today_br(), birth_date))::integer idade from ms where status = 'ativo') x),
        'aniversarios_por_mes', (select jsonb_agg((select count(*) from ms where status = 'ativo' and extract(month from birth_date) = mes) order by mes)
                                 from generate_series(1, 12) mes))
    ));

  -- Visitantes
  if coalesce((v_features->>'visitantes')::boolean, false) then
    v_out := v_out || jsonb_build_object('visitantes', (
      with vs as (select * from public.visitors v where v.church_id = p_church and v.created_at >= v_from and v.created_at < v_to),
      meses as (select generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month')::date as mes)
      select jsonb_build_object(
        'total', (select count(*) from vs),
        'viraram_membros', (select count(*) from vs where status = 'membro' or member_id is not null),
        'primeira_vez', (select count(*) from vs where first_time),
        'ja_tinham_vindo', (select count(*) from vs where first_time = false),
        'como_conheceram', (select coalesce(jsonb_object_agg(coalesce(source, 'nao_informado'), n), '{}'::jsonb)
                            from (select source, count(*) n from vs group by source) x),
        'por_mes', (select jsonb_agg(jsonb_build_object('mes', to_char(mes, 'YYYY-MM'), 'total',
                      (select count(*) from vs where date_trunc('month', vs.created_at at time zone 'America/Sao_Paulo')::date = mes)) order by mes)
                    from meses))));
  end if;

  -- Células: frequência = presenças / (encontros × participantes de hoje)
  if coalesce((v_features->>'celulas')::boolean, false) then
    v_out := v_out || jsonb_build_object('celulas', jsonb_build_object(
      'por_celula', coalesce((
        select jsonb_agg(jsonb_build_object('celula', x.name, 'participantes', x.size, 'encontros', x.meetings,
                                            'presencas', x.present, 'visitantes', x.visitors,
                                            'frequencia', case when x.meetings > 0 and x.size > 0
                                                               then round(100.0 * x.present / (x.meetings * x.size)) end)
                         order by x.name)
        from (
          select ce.name,
                 (select count(*) from public.cell_members cm join public.members m on m.id = cm.member_id
                  where cm.cell_id = ce.id and m.status = 'ativo') size,
                 (select count(*) from public.cell_meetings e where e.cell_id = ce.id and e.meeting_date between p_from and p_to) meetings,
                 (select count(*) from public.cell_attendance a join public.cell_meetings e on e.id = a.meeting_id
                  where e.cell_id = ce.id and e.meeting_date between p_from and p_to) present,
                 (select coalesce(sum(e.visitors), 0) from public.cell_meetings e where e.cell_id = ce.id and e.meeting_date between p_from and p_to) visitors
          from public.cells ce where ce.church_id = p_church and ce.active
        ) x), '[]'::jsonb),
      'presencas_por_mes', (
        select jsonb_agg(jsonb_build_object('mes', to_char(mes, 'YYYY-MM'), 'total', (
                 select count(*) from public.cell_attendance a
                 join public.cell_meetings e on e.id = a.meeting_id
                 join public.cells ce on ce.id = e.cell_id
                 where ce.church_id = p_church and e.meeting_date between p_from and p_to
                   and date_trunc('month', e.meeting_date)::date = mes)) order by mes)
        from (select generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month')::date as mes) g),
      'membros_sem_celula', (
        select count(*) from public.members m
        where m.church_id = p_church and m.status = 'ativo'
          and not exists (select 1 from public.cell_members cm join public.cells ce on ce.id = cm.cell_id
                          where cm.member_id = m.id and ce.active))));
  end if;

  -- Ministério infantil
  if coalesce((v_features->>'infantil')::boolean, false) then
    v_out := v_out || jsonb_build_object('infantil', (
      with ks as (select * from public.kids_checkins k where k.church_id = p_church and k.checkin_date between p_from and p_to),
      dias as (select checkin_date dia, count(*) n from ks group by checkin_date)
      select jsonb_build_object(
        'entradas', (select count(*) from ks),
        'criancas_diferentes', (select count(distinct child_id) from ks),
        'dias', (select count(*) from dias),
        'media_por_dia', (select round(avg(n), 1) from dias),
        'maior_dia', (select jsonb_build_object('dia', dia, 'total', n) from dias order by n desc, dia desc limit 1),
        'por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia', dia, 'total', n) order by dia) from dias), '[]'::jsonb),
        'por_sala', (select coalesce(jsonb_object_agg(coalesce(room_name, 'Sem sala'), n), '{}'::jsonb)
                     from (select room_name, count(*) n from ks group by room_name) x))));
  end if;

  -- Escalas
  if coalesce((v_features->>'escalas')::boolean, false) then
    v_out := v_out || jsonb_build_object('escalas', coalesce((
      select jsonb_agg(jsonb_build_object('ministerio', x.name, 'escalas', x.schedules, 'pessoas_escaladas', x.slots,
                                          'confirmadas', x.confirmed, 'trocas', x.swaps,
                                          'confirmacao', case when x.slots > 0 then round(100.0 * x.confirmed / x.slots) end)
                       order by x.name)
      from (
        select mi.name,
               count(distinct s.id) schedules,
               count(sl.id) slots,
               count(sl.id) filter (where sl.status = 'confirmado') confirmed,
               count(sl.id) filter (where sl.status = 'troca') swaps
        from public.ministries mi
        left join public.schedules s on s.ministry_id = mi.id and s.service_date between p_from and p_to
        left join public.schedule_slots sl on sl.schedule_id = s.id
        where mi.church_id = p_church and mi.active
        group by mi.id, mi.name
      ) x), '[]'::jsonb));
  end if;

  -- Eventos com inscrição
  if coalesce((v_features->>'inscricoes')::boolean, false) and coalesce((v_features->>'agenda')::boolean, false) then
    v_out := v_out || jsonb_build_object('inscricoes', coalesce((
      select jsonb_agg(jsonb_build_object('evento', e.title, 'inicio', e.starts_at, 'vagas', e.capacity,
                                          'confirmadas', (select count(*) from public.event_registrations r where r.event_id = e.id and r.status = 'confirmada'),
                                          'lista_de_espera', (select count(*) from public.event_registrations r where r.event_id = e.id and r.status = 'espera'))
                       order by e.starts_at)
      from public.events e
      where e.church_id = p_church and e.registration and e.starts_at >= v_from and e.starts_at < v_to), '[]'::jsonb));
  end if;

  -- Participação no app (só totais)
  v_out := v_out || jsonb_build_object('participacao', jsonb_build_object(
    'planos_de_leitura', case when coalesce((v_features->>'devocional')::boolean, false) then (
      select count(distinct pm.user_id) from public.reading_plan_members pm
      join public.reading_plans p on p.id = pm.plan_id where p.church_id = p_church and p.active) end,
    'amens', case when coalesce((v_features->>'devocional')::boolean, false) then (
      select count(*) from public.devotional_amens a join public.devotionals d on d.id = a.devotional_id
      where d.church_id = p_church and a.created_at >= v_from and a.created_at < v_to) end,
    'pedidos_de_oracao', case when coalesce((v_features->>'oracao')::boolean, false) then (
      select count(*) from public.prayer_requests pr
      where pr.church_id = p_church and pr.created_at >= v_from and pr.created_at < v_to) end));
  return v_out;
end $$;
revoke execute on function public.church_report(uuid, date, date) from public, anon;
grant execute on function public.church_report(uuid, date, date) to authenticated;

-- Dados de teste: as igrejas de teste ligam os relatórios
update public.churches set features = features || '{"relatorios": true}'::jsonb
where slug in ('teste-a', 'teste-b');
