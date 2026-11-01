-- =====================================================================
-- Igreja Conecta — cadastro do rosto girando a cabeça: várias assinaturas por pessoa
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase. Pode rodar de novo sem problema.
--
-- - O cadastro novo guarda, além da média (face_templates), uma assinatura de cada ângulo
--   que a câmera viu enquanto a pessoa girava a cabeça (até 10, tabela face_angles, fechada)
-- - O totem compara quem chega com o ângulo mais parecido de cada pessoa: quem vem com o
--   rosto um pouco para baixo ou de lado é comparado com o cadastro desse jeito
-- - A regra de segurança não muda: marca só se a pessoa mais parecida estiver a no máximo
--   0,45 e a segunda pessoa mais parecida estiver pelo menos 0,08 mais longe; na dúvida, ninguém
-- - Cadastros antigos (só a média) continuam valendo; apagar o rosto apaga os ângulos
-- - Continuam sendo só números (nenhuma foto)
-- =====================================================================

create table if not exists public.face_angles (
  member_id  uuid not null references public.face_templates (member_id) on delete cascade,
  church_id  uuid not null references public.churches on delete cascade,
  idx        smallint not null check (idx between 0 and 9),
  embedding  extensions.vector(128) not null,
  primary key (member_id, idx)
);
create index if not exists face_angles_church_idx on public.face_angles (church_id);
alter table public.face_angles enable row level security;
revoke all on public.face_angles from anon, authenticated;

-- ---------------------------------------------------------------------
-- Gravar: a média (como antes) e, se vierem, os ângulos (p_angles: lista de listas de 128 números)
-- ---------------------------------------------------------------------
drop function if exists public.face_save(uuid, real[], integer, text, text, boolean);
create or replace function public.face_save(p_member uuid, p_embedding real[], p_samples integer, p_model text,
                                            p_term_version text, p_adult_confirmed boolean default false,
                                            p_angles jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_via text := public.face_actor(p_member);
  m public.members;
  v_consent uuid;
  v_n integer := 0;
  v_vec real[];
begin
  select * into m from public.members where id = p_member;
  -- Crianças ficam de fora.
  if m.birth_date is not null then
    if extract(year from age(public.today_br(), m.birth_date)) < 18 then
      raise exception 'O reconhecimento facial é só para maiores de 18 anos.' using errcode = '42501';
    end if;
  elsif not coalesce(p_adult_confirmed, false) then
    raise exception 'Confirme que a pessoa tem 18 anos ou mais.' using errcode = '42501';
  end if;
  if p_embedding is null or array_length(p_embedding, 1) is distinct from 128
     or exists (select 1 from unnest(p_embedding) x where x is null or x = 'NaN'::real or abs(x) > 5) then
    raise exception 'Assinatura do rosto inválida. Tente cadastrar de novo.';
  end if;
  if p_samples is null or p_samples not between 3 and 10 then
    raise exception 'Faltam fotos do rosto. Tente cadastrar de novo.';
  end if;
  if p_term_version is null or char_length(p_term_version) not between 1 and 20 then
    raise exception 'Mostre o termo de consentimento antes de cadastrar.';
  end if;
  if p_angles is not null then
    if jsonb_typeof(p_angles) <> 'array' or jsonb_array_length(p_angles) > 10 then
      raise exception 'Ângulos do rosto inválidos. Tente cadastrar de novo.';
    end if;
    v_n := jsonb_array_length(p_angles);
    for i in 0 .. v_n - 1 loop
      if jsonb_typeof(p_angles -> i) <> 'array' or jsonb_array_length(p_angles -> i) <> 128
         or exists (select 1 from jsonb_array_elements(p_angles -> i) x where jsonb_typeof(x) <> 'number' or abs(x::text::real) > 5) then
        raise exception 'Ângulos do rosto inválidos. Tente cadastrar de novo.';
      end if;
    end loop;
  end if;

  -- O consentimento anterior (se houver) é substituído pelo novo.
  update public.face_consents set revoked_at = now() where member_id = p_member and revoked_at is null;
  insert into public.face_consents (member_id, church_id, term_version, via, adult_confirmed)
  values (p_member, m.church_id, p_term_version, v_via, m.birth_date is null and coalesce(p_adult_confirmed, false))
  returning id into v_consent;
  insert into public.face_templates (member_id, church_id, embedding, samples, model, consent_id)
  values (p_member, m.church_id, p_embedding::extensions.vector(128), p_samples, left(coalesce(p_model, '?'), 40), v_consent)
  on conflict (member_id) do update
    set embedding = excluded.embedding, samples = excluded.samples, model = excluded.model,
        consent_id = excluded.consent_id, created_at = now();

  -- Os ângulos do cadastro anterior saem; os novos (se houver) entram.
  delete from public.face_angles where member_id = p_member;
  for i in 0 .. v_n - 1 loop
    select array_agg(x::real order by o) into v_vec
    from jsonb_array_elements_text(p_angles -> i) with ordinality as t(x, o);
    insert into public.face_angles (member_id, church_id, idx, embedding)
    values (p_member, m.church_id, i, v_vec::extensions.vector(128));
  end loop;

  -- Transparência: quem tem o app fica sabendo que a secretaria cadastrou o rosto.
  if v_via = 'secretaria' and m.user_id is not null and m.consent_at is not null then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    values (m.user_id, m.church_id, 'sistema', 'Seu rosto foi cadastrado',
            'A secretaria cadastrou o seu rosto para a presença nos cultos, com a sua autorização. Para ver ou apagar, abra Meu rosto.',
            '#/rosto', 'rosto:' || p_member || ':' || extract(epoch from clock_timestamp())::text, true)
    on conflict do nothing;
  end if;
end $$;
revoke execute on function public.face_save(uuid, real[], integer, text, text, boolean, jsonb) from public, anon;
grant execute on function public.face_save(uuid, real[], integer, text, text, boolean, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Reconhecer: a distância de cada pessoa é a do ângulo dela mais parecido (ou da média)
-- ---------------------------------------------------------------------
create or replace function public.face_match(p_session uuid, p_embedding real[], p_model text)
returns table (member_id uuid, name text, already boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_church uuid;
  v_title text;
  v_vec extensions.vector(128);
  v_best uuid;
  v_best_dist double precision;
  v_second_dist double precision;
  v_name text;
  v_user uuid;
  v_ok boolean;
  v_rows integer;
  r record;
  i integer := 0;
begin
  select s.church_id, s.title into v_church, v_title from public.attendance_sessions s where s.id = p_session;
  if v_church is null or not public.can_attendance(v_church) or not public.face_on(v_church) then
    raise exception 'Só a equipe da presença usa o totem, com o reconhecimento facial ligado.' using errcode = '42501';
  end if;
  if p_embedding is null or array_length(p_embedding, 1) is distinct from 128
     or exists (select 1 from unnest(p_embedding) x where x is null or x = 'NaN'::real or abs(x) > 5) then
    raise exception 'Assinatura do rosto inválida.';
  end if;
  v_vec := p_embedding::extensions.vector(128);

  for r in
    select c.member_id, min(c.dist) as dist
    from (
      select t.member_id, t.embedding operator(extensions.<->) v_vec as dist
      from public.face_templates t
      where t.church_id = v_church and t.model = p_model
      union all
      select a.member_id, a.embedding operator(extensions.<->) v_vec
      from public.face_angles a
      join public.face_templates t on t.member_id = a.member_id
      where a.church_id = v_church and t.model = p_model
    ) c
    join public.members m on m.id = c.member_id and m.status = 'ativo'
    group by c.member_id
    order by 2
    limit 2
  loop
    i := i + 1;
    if i = 1 then
      v_best := r.member_id;
      v_best_dist := r.dist;
    else
      v_second_dist := r.dist;
    end if;
  end loop;

  if v_best is null or v_best_dist > 0.45 or (v_second_dist is not null and v_second_dist - v_best_dist < 0.08) then
    return; -- na dúvida, ninguém
  end if;

  insert into public.attendance (session_id, member_id, church_id, method)
  values (p_session, v_best, v_church, 'camera')
  on conflict do nothing;
  get diagnostics v_rows = row_count;

  select m.name, m.user_id, m.consent_at is not null into v_name, v_user, v_ok from public.members m where m.id = v_best;
  if v_rows > 0 and v_user is not null and v_ok then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    values (v_user, v_church, 'presenca', 'Presença marcada: ' || v_title,
            'A câmera da entrada marcou a sua presença às '
              || to_char(now() at time zone 'America/Sao_Paulo', 'HH24"h"MI') || '. Não foi você? Toque aqui.',
            '#/minha-presenca/' || p_session, 'presenca:' || p_session || ':' || v_best, true)
    on conflict do nothing;
  end if;
  return query select v_best, v_name, v_rows = 0;
end $$;
revoke execute on function public.face_match(uuid, real[], text) from public, anon;
grant execute on function public.face_match(uuid, real[], text) to authenticated;
