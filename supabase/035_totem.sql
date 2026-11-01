-- =====================================================================
-- Igreja Conecta — presença nos cultos, entrega 3: totem com reconhecimento facial
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - O tablet (ou a webcam) da entrada calcula a assinatura do rosto no aparelho e pergunta
--   ao banco quem é. A comparação acontece aqui: as assinaturas nunca saem do banco
-- - Conservador: só marca se o rosto estiver bem perto de UM cadastro e longe do segundo
--   mais parecido. Na dúvida, não marca ninguém (e não diz quem "quase" foi)
-- - O totem confirma sozinho; "Não sou eu" (no totem) e "Não fui eu" (na notificação do
--   membro) desfazem e ficam anotados para a equipe ver
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Aviso "Presença marcada" para o membro
-- ---------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'oracao', 'visitante',
                  'devocional', 'leitura', 'escala', 'inscricao', 'infantil', 'galeria', 'chat', 'financeiro', 'ata', 'presenca'));

-- ---------------------------------------------------------------------
-- 2. "Não sou eu" / "Não fui eu": anotados para a equipe
-- ---------------------------------------------------------------------
create table if not exists public.attendance_flags (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.attendance_sessions on delete cascade,
  member_id  uuid not null references public.members on delete cascade,
  church_id  uuid not null references public.churches on delete cascade,
  source     text not null check (source in ('totem', 'membro')),
  created_at timestamptz not null default now()
);
create index if not exists attendance_flags_session_idx on public.attendance_flags (session_id);
create index if not exists attendance_flags_member_idx on public.attendance_flags (member_id);

alter table public.attendance_flags enable row level security;
drop policy if exists "presenca contestacoes le" on public.attendance_flags;
create policy "presenca contestacoes le" on public.attendance_flags for select to authenticated
  using (public.can_attendance(church_id));
revoke all on public.attendance_flags from anon;
revoke insert, update, delete on public.attendance_flags from authenticated;

-- ---------------------------------------------------------------------
-- 3. Reconhecer e marcar
-- ---------------------------------------------------------------------
-- Limites (distância entre assinaturas; o mesmo rosto fica até ~0,16, pessoas diferentes a partir de ~0,5):
-- marca só se a mais perto for <= 0,45 e a segunda mais perto estiver pelo menos 0,08 mais longe.
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
    select t.member_id, t.embedding operator(extensions.<->) v_vec as dist
    from public.face_templates t
    join public.members m on m.id = t.member_id
    where t.church_id = v_church and t.model = p_model and m.status = 'ativo'
    order by t.embedding operator(extensions.<->) v_vec
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

-- Desfaz uma marcação da câmera: a equipe ("Não sou eu" no totem, p_source = totem) ou o próprio
-- membro ("Não fui eu" na notificação, p_source = membro). Só a da câmera: a da lista ou do
-- QR Code, a equipe desmarca na lista. (A versão sem p_source, da primeira rodada, sai.)
drop function if exists public.attendance_reject(uuid, uuid);
create or replace function public.attendance_reject(p_session uuid, p_member uuid, p_source text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid;
begin
  select s.church_id into v_church from public.attendance_sessions s where s.id = p_session;
  if v_church is null then
    raise exception 'Lista não encontrada.' using errcode = '42501';
  end if;
  -- coalesce: quem não é da igreja não tem cadastro nela (my_member_id nulo); nulo não pode passar.
  if not coalesce((p_source = 'membro' and p_member = public.my_member_id(v_church))
                  or (p_source = 'totem' and public.can_attendance(v_church)), false) then
    raise exception 'Só a própria pessoa ou a equipe da presença desfaz.' using errcode = '42501';
  end if;
  delete from public.attendance where session_id = p_session and member_id = p_member and method = 'camera';
  if found then
    insert into public.attendance_flags (session_id, member_id, church_id, source) values (p_session, p_member, v_church, p_source);
  end if;
end $$;

revoke execute on function public.face_match(uuid, real[], text) from public, anon;
revoke execute on function public.attendance_reject(uuid, uuid, text) from public, anon;
grant execute on function public.face_match(uuid, real[], text) to authenticated;
grant execute on function public.attendance_reject(uuid, uuid, text) to authenticated;
