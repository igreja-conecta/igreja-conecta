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
    const created = await request.post(rest('churches'), { headers, data: { slug: 'invasora', name: 'Invasora' } });
    expect(created.ok()).toBe(false);
    const write = { headers: { ...headers, Prefer: 'return=representation' } };
    const changed = await request.patch(rest('churches?slug=eq.exemplo'), { ...write, data: { name: 'Hackeada' } });
    if (changed.ok()) expect(await changed.json()).toEqual([]);
    const removed = await request.delete(rest('churches?slug=eq.exemplo'), write);
    if (removed.ok()) expect(await removed.json()).toEqual([]);
    const still = await (await request.get(rest('churches?select=name&slug=eq.exemplo'), { headers })).json();
    expect(still[0]?.name).toBe('Igreja Exemplo');
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
