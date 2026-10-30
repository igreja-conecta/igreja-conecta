-- =====================================================================
-- Igreja Conecta — ATAs das reuniões
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - O administrador e a secretaria enviam o PDF de cada ATA (título e data
--   da reunião); trocam o arquivo, corrigem os dados ou apagam
-- - Os membros da igreja veem a lista e abrem os PDFs (pasta privada: o link
--   é temporário e só sai para quem é da igreja)
-- - Só PDF, até 5 MB por arquivo, conferido pela própria pasta
-- - A ATA só aparece aos membros depois que o arquivo chegou (minutes_publish),
--   e é aí que eles recebem o aviso
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Funcionalidade, tipo de notificação e quem envia
-- ---------------------------------------------------------------------
create or replace function public.minutes_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'atas')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;

-- Envia, troca e apaga: o administrador e a secretaria, com a funcionalidade ligada.
create or replace function public.can_minutes(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.minutes_on(p_church) and public.has_role(p_church, 'admin', 'secretaria')
$$;

revoke execute on function public.minutes_on(uuid) from public, anon;
revoke execute on function public.can_minutes(uuid) from public, anon;
grant execute on function public.minutes_on(uuid) to authenticated;
grant execute on function public.can_minutes(uuid) to authenticated;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'oracao', 'visitante',
                  'devocional', 'leitura', 'escala', 'inscricao', 'infantil', 'galeria', 'chat', 'financeiro', 'ata'));

-- ---------------------------------------------------------------------
-- 2. Tabela
-- ---------------------------------------------------------------------
create table if not exists public.meeting_minutes (
  id           uuid primary key default gen_random_uuid(),
  church_id    uuid not null references public.churches on delete cascade,
  title        text not null check (char_length(title) between 2 and 120),
  meeting_date date not null,
  path         text not null unique,
  file_size    integer,
  published_at timestamptz,
  created_by   uuid default auth.uid() references auth.users on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists meeting_minutes_church_idx on public.meeting_minutes (church_id, meeting_date desc);

-- O caminho do arquivo é decidido pelo banco: <igreja>/<ata>.pdf. Quem envia não escolhe.
create or replace function public.meeting_minutes_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.path := new.church_id || '/' || new.id || '.pdf';
    new.file_size := null;
    new.published_at := null;
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.church_id := old.church_id;
    new.path := old.path;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists meeting_minutes_guard on public.meeting_minutes;
create trigger meeting_minutes_guard before insert or update on public.meeting_minutes
  for each row execute function public.meeting_minutes_guard();
revoke execute on function public.meeting_minutes_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Regras de acesso
-- ---------------------------------------------------------------------
-- Membros veem as publicadas; quem envia vê também as que ainda esperam o arquivo.
alter table public.meeting_minutes enable row level security;
drop policy if exists "atas le" on public.meeting_minutes;
create policy "atas le" on public.meeting_minutes for select to authenticated
  using (church_id in (select public.my_church_ids()) and public.minutes_on(church_id)
         and (published_at is not null or public.can_minutes(church_id)));
drop policy if exists "atas cria" on public.meeting_minutes;
create policy "atas cria" on public.meeting_minutes for insert to authenticated
  with check (public.can_minutes(church_id));
drop policy if exists "atas edita" on public.meeting_minutes;
create policy "atas edita" on public.meeting_minutes for update to authenticated
  using (public.can_minutes(church_id)) with check (public.can_minutes(church_id));
drop policy if exists "atas apaga" on public.meeting_minutes;
create policy "atas apaga" on public.meeting_minutes for delete to authenticated
  using (public.can_minutes(church_id));
revoke all on public.meeting_minutes from anon;
revoke insert, update on public.meeting_minutes from authenticated;
grant insert (church_id, title, meeting_date) on public.meeting_minutes to authenticated;
grant update (title, meeting_date) on public.meeting_minutes to authenticated;

-- ---------------------------------------------------------------------
-- 4. Arquivos: pasta privada "atas", só PDF, até 5 MB
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('atas', 'atas', false, 5242880, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['application/pdf'];

drop policy if exists "atas membros veem" on storage.objects;
create policy "atas membros veem" on storage.objects for select to authenticated
  using (bucket_id = 'atas'
         and exists (select 1 from public.meeting_minutes a
                     where a.path = name and public.is_member(a.church_id) and public.minutes_on(a.church_id)
                       and (a.published_at is not null or public.can_minutes(a.church_id))));
-- Só o arquivo de uma ATA já registrada, e por quem envia (trocar o PDF grava por cima).
drop policy if exists "atas envia" on storage.objects;
create policy "atas envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'atas'
              and exists (select 1 from public.meeting_minutes a where a.path = name and public.can_minutes(a.church_id)));
drop policy if exists "atas troca" on storage.objects;
create policy "atas troca" on storage.objects for update to authenticated
  using (bucket_id = 'atas'
         and exists (select 1 from public.meeting_minutes a where a.path = name and public.can_minutes(a.church_id)))
  with check (bucket_id = 'atas'
              and exists (select 1 from public.meeting_minutes a where a.path = name and public.can_minutes(a.church_id)));
drop policy if exists "atas apaga arquivo" on storage.objects;
create policy "atas apaga arquivo" on storage.objects for delete to authenticated
  using (bucket_id = 'atas'
         and (storage.foldername(name))[1] in (select c.id::text from public.churches c where public.can_minutes(c.id)));

-- ---------------------------------------------------------------------
-- 5. Publicar: depois que o arquivo chegou, a ATA aparece e os membros são avisados
-- ---------------------------------------------------------------------
-- Chamada depois de cada envio do PDF. Na primeira vez publica e avisa; nas trocas
-- só atualiza o tamanho (sem aviso de novo).
create or replace function public.minutes_publish(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  a public.meeting_minutes;
  v_size integer;
begin
  select * into a from public.meeting_minutes where id = p_id;
  if a.id is null or not public.can_minutes(a.church_id) then
    raise exception 'Só o administrador e a secretaria enviam ATAs.' using errcode = '42501';
  end if;
  select (o.metadata->>'size')::integer into v_size
  from storage.objects o where o.bucket_id = 'atas' and o.name = a.path;
  if v_size is null then
    raise exception 'O PDF da ATA ainda não chegou. Envie de novo.' using errcode = '23514';
  end if;
  update public.meeting_minutes
  set file_size = v_size, published_at = coalesce(published_at, now())
  where id = a.id;
  if a.published_at is not null then
    return;
  end if;
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select m.user_id, a.church_id, 'ata', 'Nova ATA: ' || a.title,
         'Reunião de ' || to_char(a.meeting_date, 'DD/MM/YYYY') || '. Toque para abrir.', '#/atas',
         'ata:' || a.id, true
  from public.members m
  where m.church_id = a.church_id and m.user_id is not null and m.user_id <> auth.uid()
    and m.status = 'ativo' and m.consent_at is not null
  on conflict do nothing;
end $$;
revoke execute on function public.minutes_publish(uuid) from public, anon;
grant execute on function public.minutes_publish(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Dados de teste: as igrejas de teste ligam as ATAs
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"atas": true}'::jsonb
where slug in ('teste-a', 'teste-b');
