// Regras de segurança do banco, testadas como um visitante sem login.
// Se alguém afrouxar uma regra do Supabase por engano, a publicação para aqui.
// (Os testes com duas igrejas e usuários logados chegam na próxima entrega.)
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, ANON_KEY, headers, rest, configured } from './helpers.mjs';

const UUID = '00000000-0000-0000-0000-000000000000';
const rpc = (request, fn, data = {}) => request.post(rest(`rpc/${fn}`), { headers, data });
const storageHeaders = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` };
const exemploId = async (request) => (await (await request.get(rest('churches?select=id&slug=eq.exemplo'), { headers })).json())[0].id;

test.beforeEach(() => test.skip(!configured, 'Falta a chave pública em js/config.js'));

test.describe('Banco: visitante sem login', () => {
  test('não lê membros nem administradores da plataforma', async ({ request }) => {
    for (const table of ['members', 'platform_admins']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      expect(res.ok(), table).toBe(false);
    }
  });

  test('vê só as igrejas ativas', async ({ request }) => {
    const res = await request.get(rest('churches?select=slug,active'), { headers });
    expect(res.ok()).toBe(true);
    const rows = await res.json();
    expect(rows.some((r) => r.slug === 'exemplo')).toBe(true);
    expect(rows.every((r) => r.active)).toBe(true);
  });

  test('não cria, não altera e não apaga igrejas', async ({ request }) => {
    // O administrador pode renomear a Igreja Exemplo; o que importa é o visitante não conseguir.
    const nameNow = async () => (await (await request.get(rest('churches?select=name&slug=eq.exemplo'), { headers })).json())[0]?.name;
    const before = await nameNow();
    expect(before).toBeTruthy();
    const created = await request.post(rest('churches'), { headers, data: { slug: 'invasora', name: 'Invasora' } });
    expect(created.ok()).toBe(false);
    const write = { headers: { ...headers, Prefer: 'return=representation' } };
    const changed = await request.patch(rest('churches?slug=eq.exemplo'), { ...write, data: { name: 'Hackeada' } });
    if (changed.ok()) expect(await changed.json()).toEqual([]);
    const removed = await request.delete(rest('churches?slug=eq.exemplo'), write);
    if (removed.ok()) expect(await removed.json()).toEqual([]);
    expect(await nameNow()).toBe(before);
  });

  test('não cadastra membros', async ({ request }) => {
    const res = await request.post(rest('members'), { headers, data: { church_id: await exemploId(request), name: 'Intruso' } });
    expect(res.ok()).toBe(false);
  });

  test('não chama as funções de administração nem de convite', async ({ request }) => {
    expect((await rpc(request, 'create_church', { p_slug: 'invasora', p_name: 'Invasora', p_admin_email: 'a@b.com' })).ok()).toBe(false);
    expect((await rpc(request, 'set_church_admin', { p_church: UUID, p_email: 'a@b.com' })).ok()).toBe(false);
    expect((await rpc(request, 'set_church_active', { p_church: UUID, p_active: false })).ok()).toBe(false);
    expect((await rpc(request, 'link_my_account')).ok()).toBe(false);
    expect((await rpc(request, 'respond_to_church', { p_church: UUID, p_accept: true })).ok()).toBe(false);
  });

  test('não é administrador da plataforma e não pertence a nenhuma igreja', async ({ request }) => {
    expect(await (await rpc(request, 'is_platform_admin')).json()).toBe(false);
    expect(await (await rpc(request, 'my_church_ids')).json()).toEqual([]);
  });

  test('não envia arquivos para as pastas das igrejas', async ({ request }) => {
    const church = await exemploId(request);
    // Formato aceito por cada pasta: a recusa precisa ser por falta de permissão.
    for (const [bucket, type] of [['igrejas', 'image/png'], ['membros', 'image/webp']]) {
      const res = await request.post(`${SUPABASE_URL}/storage/v1/object/${bucket}/${church}/teste`, {
        headers: { ...storageHeaders, 'Content-Type': type },
        data: Buffer.from('89504e470d0a1a0a', 'hex'),
      });
      expect(res.ok(), bucket).toBe(false);
      expect(await res.text(), bucket).not.toMatch(/mime/i);
    }
  });

  test('não lista as fotos dos membros', async ({ request }) => {
    const res = await request.post(`${SUPABASE_URL}/storage/v1/object/list/membros`, {
      headers: { ...storageHeaders, 'Content-Type': 'application/json' },
      data: { prefix: `${await exemploId(request)}/`, limit: 10 },
    });
    if (res.ok()) expect(await res.json()).toEqual([]);
  });
});

test.describe('Banco: visitante sem login (aniversários)', () => {
  test('não dispara envios nem lê aparelhos, modelos e registros', async ({ request }) => {
    for (const fn of ['claim_birthday_push', 'claim_birthday_email', 'claim_leader_summaries', 'platform_push_targets', 'birthday_email_backlog', 'clean_message_log']) {
      expect((await rpc(request, fn, { p_secret: 'errada' })).ok(), fn).toBe(false);
    }
    expect((await rpc(request, 'mark_message_failed', { p_secret: 'errada', p_log_id: 1 })).ok()).toBe(false);
    expect((await rpc(request, 'forget_push_subscription', { p_secret: 'errada', p_endpoint: 'https://x' })).ok()).toBe(false);
    expect((await rpc(request, 'save_push_subscription', { p_endpoint: 'https://x', p_p256dh: 'a', p_auth: 'b' })).ok()).toBe(false);
    expect((await rpc(request, 'birthdays_between', { p_church: UUID, p_from: '2027-01-01', p_to: '2027-01-31' })).ok()).toBe(false);
    for (const fn of ['claim_event_reminders', 'claim_announcement_push', 'deliver_birthday_notifications', 'clean_notifications']) {
      expect((await rpc(request, fn, { p_secret: 'errada' })).ok(), fn).toBe(false);
    }
    expect((await rpc(request, 'events_between', { p_church: UUID, p_from: '2027-01-01T00:00:00Z', p_to: '2027-01-31T00:00:00Z' })).ok()).toBe(false);
    for (const fn of ['export_my_data', 'delete_my_account']) expect((await rpc(request, fn)).ok(), fn).toBe(false);
    // O relógio (007) usa a chave do GitHub: nada dele pode ser chamado de fora.
    for (const fn of ['github_dispatch', 'churches_publish']) {
      expect((await rpc(request, fn, { p_workflow: 'deploy.yml' })).ok(), fn).toBe(false);
    }
    const privateSchema = await request.post(rest('rpc/github_dispatch'), {
      headers: { ...headers, 'Content-Profile': 'private' },
      data: { p_workflow: 'deploy.yml' },
    });
    expect(privateSchema.ok()).toBe(false);
    expect((await rpc(request, 'leave_church', { p_church: UUID })).ok()).toBe(false);
    for (const table of ['push_subscriptions', 'message_log', 'message_templates', 'events', 'announcements', 'notifications']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      if (res.ok()) expect(await res.json(), table).toEqual([]);
    }
  });
});

test.describe('Banco: visitante sem login (oração, células e mapa)', () => {
  test('não lê nem grava pedidos de oração, células, encontros e presenças', async ({ request }) => {
    for (const table of ['prayer_requests', 'prayer_praying', 'cells', 'cell_members', 'cell_meetings', 'cell_attendance']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      if (res.ok()) expect(await res.json(), table).toEqual([]);
    }
    const prayer = await request.post(rest('prayer_requests'), { headers, data: { church_id: UUID, body: 'Teste anônimo', audience: 'igreja' } });
    expect(prayer.ok()).toBe(false);
    const cell = await request.post(rest('cells'), { headers, data: { church_id: UUID, name: 'Célula intrusa' } });
    expect(cell.ok()).toBe(false);
    expect(await (await rpc(request, 'prayer_wall', { p_church: UUID })).text()).not.toMatch(/"body"/);
    expect((await rpc(request, 'prayer_toggle', { p_request: UUID })).ok()).toBe(false);
    expect((await rpc(request, 'save_cell_meeting', { p_cell: UUID, p_date: '2027-01-01', p_topic: null, p_notes: null, p_visitors: 0, p_present: [] })).ok()).toBe(false);
    expect((await rpc(request, 'claim_notification_push', { p_secret: 'errada' })).ok()).toBe(false);
    // Funções de gatilho não são chamadas de fora.
    for (const fn of ['create_default_templates', 'cell_members_guard', 'prayer_notify']) {
      expect((await rpc(request, fn)).ok(), fn).toBe(false);
    }
  });
});

test.describe('Banco: visitante sem login (cadastro de visitantes)', () => {
  test('não lê os cadastros, não grava direto, não vira membro e não limpa', async ({ request }) => {
    const res = await request.get(rest('visitors?select=*'), { headers });
    if (res.ok()) expect(await res.json()).toEqual([]);
    const direct = await request.post(rest('visitors'), { headers, data: { church_id: UUID, name: 'Intruso', consent_at: new Date().toISOString() } });
    expect(direct.ok()).toBe(false);
    expect((await rpc(request, 'visitor_to_member', { p_visitor: UUID })).ok()).toBe(false);
    expect((await rpc(request, 'clean_visitors', { p_secret: 'errada' })).ok()).toBe(false);
    // Igreja que não existe (ou sem a funcionalidade): o cadastro é recusado.
    const reg = await rpc(request, 'register_visitor', {
      p_church: UUID, p_name: 'Fulano', p_phone: null, p_email: null, p_first_time: true, p_source: null, p_wants_contact: true, p_message: null, p_consent: true,
    });
    expect(reg.ok()).toBe(false);
  });
});

test.describe('Banco: visitante sem login (devocional e plano de leitura)', () => {
  test('não lê nem grava devocionais, planos e progresso; não chama as funções', async ({ request }) => {
    for (const table of ['devotionals', 'devotional_amens', 'reading_plans', 'reading_plan_members', 'reading_progress']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      if (res.ok()) expect(await res.json(), table).toEqual([]);
    }
    const dev = await request.post(rest('devotionals'), { headers, data: { church_id: UUID, title: 'Intruso', body: 'x', publish_date: '2030-01-01' } });
    expect(dev.ok()).toBe(false);
    const plan = await request.post(rest('reading_plans'), { headers, data: { church_id: UUID, plan_key: 'nt-90', start_date: '2030-01-01' } });
    expect(plan.ok()).toBe(false);
    expect(await (await rpc(request, 'devotional_list', { p_church: UUID })).text()).not.toMatch(/"body"/);
    expect((await rpc(request, 'devotional_amen', { p_devotional: UUID })).ok()).toBe(false);
    expect((await rpc(request, 'reading_plan_stats', { p_church: UUID })).ok()).toBe(false);
    expect((await rpc(request, 'deliver_devotional_notifications', { p_secret: 'errada' })).ok()).toBe(false);
    for (const fn of ['devotionals_guard', 'reading_progress_guard']) expect((await rpc(request, fn)).ok(), fn).toBe(false);
  });
});

test.describe('Banco: visitante sem login (ministérios e escalas)', () => {
  test('não lê nem grava ministérios, equipes e escalas; não chama as funções', async ({ request }) => {
    for (const table of ['ministries', 'ministry_members', 'schedules', 'schedule_slots']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      if (res.ok()) expect(await res.json(), table).toEqual([]);
    }
    expect((await request.post(rest('ministries'), { headers, data: { church_id: UUID, name: 'Intruso' } })).ok()).toBe(false);
    expect((await request.post(rest('schedules'), { headers, data: { ministry_id: UUID, service_date: '2030-01-01' } })).ok()).toBe(false);
    const calls = {
      ministry_overview: { p_church: UUID },
      ministry_roster: { p_ministry: UUID },
      ministry_candidates: { p_ministry: UUID, p_search: 'Fulano' },
      ministry_schedules: { p_ministry: UUID },
      my_schedules: { p_church: UUID },
      save_schedule: { p_ministry: UUID, p_id: null, p_date: '2030-01-01', p_time: null, p_title: null, p_notes: null, p_slots: [] },
      schedule_answer: { p_slot: UUID, p_confirm: true },
      can_manage_ministry: { p_ministry: UUID },
      visitor_team_users: { p_church: UUID },
      my_visitor_churches: {},
    };
    for (const [fn, data] of Object.entries(calls)) expect((await rpc(request, fn, data)).ok(), fn).toBe(false);
    expect((await rpc(request, 'deliver_schedule_reminders', { p_secret: 'errada' })).ok()).toBe(false);
    for (const fn of ['ministry_members_guard', 'ministry_members_left']) expect((await rpc(request, fn)).ok(), fn).toBe(false);
  });
});

test.describe('Banco: visitante sem login (inscrição em eventos)', () => {
  test('não lê nem grava inscrições; não chama as funções', async ({ request }) => {
    const res = await request.get(rest('event_registrations?select=*'), { headers });
    if (res.ok()) expect(await res.json()).toEqual([]);
    expect((await request.post(rest('event_registrations'), { headers, data: { event_id: UUID, member_id: UUID, status: 'confirmada' } })).ok()).toBe(false);
    const calls = {
      event_registration_summary: { p_church: UUID },
      event_register: { p_event: UUID },
      event_unregister: { p_event: UUID },
      event_registrants: { p_event: UUID },
      event_registration_remove: { p_registration: UUID },
      event_promote: { p_event: UUID },
    };
    for (const [fn, data] of Object.entries(calls)) expect((await rpc(request, fn, data)).ok(), fn).toBe(false);
    expect((await rpc(request, 'claim_registration_emails', { p_secret: 'errada' })).ok()).toBe(false);
    for (const fn of ['event_registrations_left', 'events_registration_changed']) expect((await rpc(request, fn)).ok(), fn).toBe(false);
  });
});

test.describe('Banco: visitante sem login (check-in infantil)', () => {
  test('não lê nem grava crianças, salas e entradas; não chama as funções', async ({ request }) => {
    for (const table of ['children', 'kids_rooms', 'kids_checkins']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      if (res.ok()) expect(await res.json(), table).toEqual([]);
    }
    expect((await request.post(rest('children'), { headers, data: { church_id: UUID, name: 'Intrusa', guardian_name: 'X' } })).ok()).toBe(false);
    const calls = {
      kids_roster: { p_church: UUID },
      kids_checkin: { p_child: UUID, p_room: null },
      kids_lookup_code: { p_church: UUID, p_code: 'ABCD' },
      kids_checkout: { p_checkin: UUID, p_code: 'ABCD' },
      kids_new_code: { p_church: UUID, p_day: '2030-01-01' },
      can_kids: { p_church: UUID },
      my_member_id: { p_church: UUID },
    };
    for (const [fn, data] of Object.entries(calls)) expect((await rpc(request, fn, data)).ok(), fn).toBe(false);
    expect((await rpc(request, 'clean_kids', { p_secret: 'errada' })).ok()).toBe(false);
    expect((await rpc(request, 'children_guard')).ok()).toBe(false);
  });
});

test.describe('Banco: visitante sem login (carteirinha)', () => {
  test('não troca códigos; a conferência só responde pelo código exato', async ({ request }) => {
    expect((await rpc(request, 'rotate_card_token', { p_church: UUID })).ok()).toBe(false);
    expect((await rpc(request, 'cards_on', { p_church: UUID })).ok()).toBe(false);
    expect((await rpc(request, 'members_since_guard')).ok()).toBe(false);
    const res = await rpc(request, 'verify_member_card', { p_token: UUID });
    expect(res.ok(), await res.text()).toBe(true);
    expect(await res.json()).toEqual([]);
    // Sem login, a tabela de membros (e os códigos) continua fechada.
    expect((await request.get(rest('members?select=card_token'), { headers })).ok()).toBe(false);
  });
});

test.describe('Banco: visitante sem login (relatórios)', () => {
  test('não calcula relatórios', async ({ request }) => {
    expect((await rpc(request, 'church_report', { p_church: UUID, p_from: '2026-01-01', p_to: '2026-03-31' })).ok()).toBe(false);
  });
});

test.describe('Banco: visitante sem login (galeria)', () => {
  test('não lê álbuns, fotos nem arquivos; não registra nem pede retirada', async ({ request }) => {
    for (const table of ['gallery_albums', 'gallery_photos', 'gallery_removal_requests']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      if (res.ok()) expect(await res.json(), table).toEqual([]);
    }
    expect((await request.post(rest('gallery_albums'), { headers, data: { church_id: UUID, title: 'Intruso' } })).ok()).toBe(false);
    const calls = {
      gallery_album_list: { p_church: UUID },
      gallery_add_photo: { p_album: UUID, p_ext: 'webp' },
      gallery_request_removal: { p_photo: UUID },
      can_gallery: { p_church: UUID },
    };
    for (const [fn, data] of Object.entries(calls)) expect((await rpc(request, fn, data)).ok(), fn).toBe(false);
    expect((await rpc(request, 'gallery_albums_guard')).ok()).toBe(false);
    const list = await request.post(`${SUPABASE_URL}/storage/v1/object/list/galeria`, { headers: storageHeaders, data: { prefix: '', limit: 10 } });
    if (list.ok()) expect(await list.json()).toEqual([]);
    const up = await request.post(`${SUPABASE_URL}/storage/v1/object/galeria/${UUID}/x.webp`, {
      headers: { ...storageHeaders, 'Content-Type': 'image/webp' },
      data: Buffer.from('52494646', 'hex'),
    });
    expect(up.ok()).toBe(false);
  });
});
