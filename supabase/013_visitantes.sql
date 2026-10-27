-- =====================================================================
-- Igreja Conecta — cadastro de visitantes (Fase 2)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - O visitante (sem conta) preenche um cadastro rápido pelo QR Code do culto
-- - Só a liderança da igreja (administrador, secretaria e líderes) lê os cadastros
-- - A liderança recebe aviso na central do app e no celular a cada visitante
-- - Acompanhamento: situação, anotações, WhatsApp e "cadastrar como membro"
-- - Quem não virou membro é apagado sozinho depois de 12 meses (LGPD)
--
-- O formulário é público e o código do app também: a gravação passa só por
-- register_visitor, que confere tudo e limita envios por aparelho e por igreja.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tabela
-- ---------------------------------------------------------------------
create table if not exists public.visitors (
  id            uuid primary key default gen_random_uuid(),
  church_id     uuid not null references public.churches on delete cascade,
  name          text not null check (char_length(name) between 2 and 120),
  phone         text check (phone ~ '^55[0-9]{10,11}$'),
  email         text check (char_length(email) <= 160 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  first_time    boolean,
  source        text check (source in ('amigos', 'redes', 'passando', 'outro')),
  wants_contact boolean not null default true,
  message       text check (char_length(message) <= 1000),
  consent_at    timestamptz not null,
  status        text not null default 'novo' check (status in ('novo', 'contatado', 'acompanhando', 'membro', 'sem_interesse')),
  notes         text check (char_length(notes) <= 4000),
  member_id     uuid references public.members on delete set null,
  ip_hash       text,                       -- só para limitar envios; apagado depois de 30 dias
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists visitors_church_idx on public.visitors (church_id, created_at desc);
create index if not exists visitors_ip_idx on public.visitors (ip_hash, created_at) where ip_hash is not null;

alter table public.visitors enable row level security;
drop policy if exists "visitantes lideranca le" on public.visitors;
create policy "visitantes lideranca le" on public.visitors for select to authenticated
  using (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "visitantes lideranca edita" on public.visitors;
create policy "visitantes lideranca edita" on public.visitors for update to authenticated
  using (church_id in (select public.my_church_ids('lideranca')))
  with check (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "visitantes lideranca apaga" on public.visitors;
create policy "visitantes lideranca apaga" on public.visitors for delete to authenticated
  using (church_id in (select public.my_church_ids('lideranca')));
-- Ninguém grava direto: o cadastro entra só por register_visitor.
revoke all on public.visitors from anon;
revoke insert, update on public.visitors from authenticated;
grant update (status, notes, updated_at) on public.visitors to authenticated;

-- Mensagem pronta do WhatsApp para o visitante (a liderança edita na tela Visitantes).
alter table public.churches add column if not exists visitor_whatsapp_text text
  check (char_length(visitor_whatsapp_text) <= 500);
grant update (visitor_whatsapp_text) on public.churches to authenticated;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'oracao', 'visitante'));

-- ---------------------------------------------------------------------
-- 2. Cadastro público (sem login)
-- ---------------------------------------------------------------------
create or replace function public.register_visitor(
  p_church uuid, p_name text, p_phone text, p_email text, p_first_time boolean, p_source text,
  p_wants_contact boolean, p_message text, p_consent boolean, p_website text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
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
  v_ip := split_part(coalesce((current_setting('request.headers', true)::json)->>'x-forwarded-for', ''), ',', 1);
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

  -- Aviso para a liderança (central do app e celular). O texto do visitante não vai na notificação.
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select m.user_id, p_church, 'visitante',
         'Novo visitante: ' || split_part(v_name, ' ', 1),
         concat_ws(' · ',
           case when p_first_time then 'Primeira vez' end,
           case when coalesce(p_wants_contact, true) then 'Quer que alguém fale com ele' else 'Não pediu contato' end),
         '#/visitantes/' || v_id, 'visitante:' || v_id, true
  from public.members m
  where m.church_id = p_church and m.role in ('admin', 'secretaria', 'lider') and m.status = 'ativo'
    and m.user_id is not null and m.consent_at is not null
  on conflict do nothing;
  return true;
end $$;
revoke execute on function public.register_visitor(uuid, text, text, text, boolean, text, boolean, text, boolean, text) from public;
grant execute on function public.register_visitor(uuid, text, text, text, boolean, text, boolean, text, boolean, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Visitante vira membro (só a liderança da igreja)
-- ---------------------------------------------------------------------
create or replace function public.visitor_to_member(p_visitor uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v public.visitors;
  v_member uuid;
begin
  select * into v from public.visitors where id = p_visitor;
  if v.id is null or not public.is_leader(v.church_id) then
    raise exception 'Visitante não encontrado.' using errcode = '42501';
  end if;
  if v.member_id is not null then
    return v.member_id;
  end if;
  -- Mesmo e-mail já cadastrado: liga a esse cadastro.
  select m.id into v_member from public.members m
  where m.church_id = v.church_id and v.email is not null and lower(m.email) = v.email;
  if v_member is null then
    insert into public.members (church_id, role, name, email, phone, created_by)
    values (v.church_id, 'membro', v.name, v.email, v.phone, auth.uid())
    returning id into v_member;
  end if;
  update public.visitors set member_id = v_member, status = 'membro', updated_at = now() where id = v.id;
  return v_member;
end $$;
revoke execute on function public.visitor_to_member(uuid) from public, anon;
grant execute on function public.visitor_to_member(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Limpeza (envio diário, com a senha ENVIO_SECRET): LGPD
-- ---------------------------------------------------------------------
create or replace function public.clean_visitors(p_secret text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform public.envio_check_secret(p_secret);
  delete from public.visitors where status <> 'membro' and created_at < now() - interval '12 months';
  get diagnostics v_count = row_count;
  update public.visitors set ip_hash = null where ip_hash is not null and created_at < now() - interval '30 days';
  return v_count;
end $$;
revoke execute on function public.clean_visitors(text) from public;
grant execute on function public.clean_visitors(text) to anon;

-- ---------------------------------------------------------------------
-- 5. Dados de teste: as igrejas de teste ligam os visitantes
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"visitantes": true}'::jsonb
where slug in ('teste-a', 'teste-b');
