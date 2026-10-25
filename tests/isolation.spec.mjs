// Separação entre igrejas, testada com contas de verdade nas igrejas Teste A e Teste B.
// Cada tentativa de ler ou mexer na outra igreja (ou de passar do próprio papel) precisa falhar.
// Contas: supabase/002_igrejas_de_teste.sql + supabase/usuarios-de-teste.local.sql.
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, rest, configured, testPassword, loginAs } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

let api;
const as = {}; // contas logadas: { id, headers }
const church = {}; // 'a' e 'b': id das igrejas de teste
const returning = (h) => ({ ...h, Prefer: 'return=representation' });

const get = async (who, path) => {
  const res = await api.get(rest(path), { headers: as[who].headers });
  expect(res.ok(), `${who} GET ${path}: ${await res.text()}`).toBe(true);
  return res.json();
};
const rpc = (who, fn, data = {}) => api.post(rest(`rpc/${fn}`), { headers: as[who].headers, data });
// Cada pasta recebe um formato que ela aceita: assim uma recusa só pode ser por falta de permissão.
const FORMAT = { igrejas: 'image/png', membros: 'image/webp' };
const upload = (who, bucket, path) =>
  api.post(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    headers: { ...as[who].headers, 'Content-Type': FORMAT[bucket] },
    data: Buffer.from('89504e470d0a1a0a', 'hex'),
  });
async function expectDenied(res, label) {
  const body = await res.text();
  expect(res.ok(), `${label}: ${body}`).toBe(false);
  expect(body, label).not.toMatch(/mime|too large|payload/i);
}
const removeFile = (who, bucket, path) =>
  api.delete(`${SUPABASE_URL}/storage/v1/object/${bucket}`, { headers: as[who].headers, data: { prefixes: [path] } });

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    // No GitHub os testes não podem pular em silêncio.
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['adm-a', 'lider-a', 'membro-a', 'adm-b', 'sem-igreja']) as[u] = await loginAs(api, u);
  const rows = await (await api.get(rest('churches?select=id,slug&slug=in.(teste-a,teste-b)'), { headers: as['adm-a'].headers })).json();
  church.a = rows.find((r) => r.slug === 'teste-a').id;
  church.b = rows.find((r) => r.slug === 'teste-b').id;
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('Leitura de membros', () => {
  test('a liderança vê só os membros da própria igreja', async () => {
    for (const who of ['adm-a', 'lider-a']) {
      const rows = await get(who, 'members?select=name,church_id');
      expect(rows.length, who).toBeGreaterThan(0);
      expect(rows.every((r) => r.church_id === church.a), who).toBe(true);
      expect(rows.map((r) => r.name)).toContain('Fulano da A');
      expect(rows.map((r) => r.name)).not.toContain('Fulano da B');
    }
    const b = await get('adm-b', 'members?select=name,church_id');
    expect(b.every((r) => r.church_id === church.b)).toBe(true);
    expect(b.map((r) => r.name)).not.toContain('Fulano da A');
  });

  test('pedir os membros da outra igreja pelo id não traz nada', async () => {
    expect(await get('adm-a', `members?select=*&church_id=eq.${church.b}`)).toEqual([]);
    const embedded = await get('adm-a', `churches?select=slug,members(name)&id=eq.${church.b}`);
    expect(embedded[0].members).toEqual([]);
  });

  test('o membro comum vê só o próprio cadastro (telefones e aniversários dos outros, não)', async () => {
    const rows = await get('membro-a', 'members?select=name,user_id');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(as['membro-a'].id);
  });

  test('quem não é de nenhuma igreja não vê ninguém', async () => {
    expect(await get('sem-igreja', 'members?select=*')).toEqual([]);
    expect(await (await rpc('sem-igreja', 'my_church_ids')).json()).toEqual([]);
    expect(await (await rpc('sem-igreja', 'link_my_account')).json()).toBe(0);
  });
});

test.describe('Alterações na outra igreja', () => {
  test('o admin da A não altera membros nem a configuração da B', async () => {
    const h = returning(as['adm-a'].headers);
    const members = await api.patch(rest(`members?church_id=eq.${church.b}`), { headers: h, data: { name: 'Invadido' } });
    if (members.ok()) expect(await members.json()).toEqual([]);
    const conf = await api.patch(rest(`churches?id=eq.${church.b}`), { headers: h, data: { welcome_text: 'Invadido' } });
    if (conf.ok()) expect(await conf.json()).toEqual([]);
    const removed = await api.delete(rest(`members?church_id=eq.${church.b}`), { headers: h });
    if (removed.ok()) expect(await removed.json()).toEqual([]);
    const still = await get('adm-b', 'members?select=name&name=eq.Fulano da B');
    expect(still).toHaveLength(1);
  });

  test('o admin da A não cadastra ninguém na B', async () => {
    const res = await api.post(rest('members'), { headers: as['adm-a'].headers, data: { church_id: church.b, name: 'Intruso' } });
    expect(res.ok()).toBe(false);
  });

  test('ninguém leva um membro da sua igreja para a outra', async () => {
    const [fulano] = await get('adm-a', 'members?select=id&name=eq.Fulano da A');
    const res = await api.patch(rest(`members?id=eq.${fulano.id}`), { headers: as['adm-a'].headers, data: { church_id: church.b } });
    expect(res.ok()).toBe(false);
  });

  test('o admin da A edita a própria igreja', async () => {
    const [mine] = await get('adm-a', `churches?select=welcome_text&id=eq.${church.a}`);
    const res = await api.patch(rest(`churches?id=eq.${church.a}`), { headers: returning(as['adm-a'].headers), data: { welcome_text: mine.welcome_text } });
    expect(res.ok()).toBe(true);
    expect(await res.json()).toHaveLength(1);
  });

  test('ninguém troca o endereço, o limite de membros nem a marca de teste da igreja', async () => {
    for (const data of [{ slug: 'outra' }, { max_members: 999999 }, { is_test: false }, { active: false }]) {
      const res = await api.patch(rest(`churches?id=eq.${church.a}`), { headers: as['adm-a'].headers, data });
      expect(res.ok(), JSON.stringify(data)).toBe(false);
    }
  });
});

test.describe('Papéis dentro da igreja', () => {
  test('o membro não muda o próprio papel nem o e-mail, mas edita os próprios dados', async () => {
    const id = as['membro-a'].id;
    const role = await api.patch(rest(`members?user_id=eq.${id}`), { headers: as['membro-a'].headers, data: { role: 'admin' } });
    expect(role.ok()).toBe(false);
    const email = await api.patch(rest(`members?user_id=eq.${id}`), { headers: as['membro-a'].headers, data: { email: 'outro@exemplo.com' } });
    expect(email.ok()).toBe(false);
    const own = await api.patch(rest(`members?user_id=eq.${id}`), { headers: returning(as['membro-a'].headers), data: { show_phone: false } });
    expect(own.ok()).toBe(true);
    expect(await own.json()).toHaveLength(1);
  });

  test('o membro não cadastra ninguém', async () => {
    const res = await api.post(rest('members'), { headers: as['membro-a'].headers, data: { church_id: church.a, name: 'Novo' } });
    expect(res.ok()).toBe(false);
  });

  test('o líder cadastra membros, mas não dá papéis, não liga contas e não apaga', async () => {
    const lider = as['lider-a'].headers;
    const admin = await api.post(rest('members'), { headers: lider, data: { church_id: church.a, name: 'Quer ser admin', role: 'admin' } });
    expect(admin.ok()).toBe(false);
    const linked = await api.post(rest('members'), { headers: lider, data: { church_id: church.a, name: 'Conta alheia', user_id: as['adm-b'].id } });
    expect(linked.ok()).toBe(false);

    const created = await api.post(rest('members'), { headers: returning(lider), data: { church_id: church.a, name: 'Teste temporário' } });
    expect(created.ok(), await created.text()).toBe(true);
    const [row] = await created.json();
    try {
      const del = await api.delete(rest(`members?id=eq.${row.id}`), { headers: returning(lider) });
      if (del.ok()) expect(await del.json()).toEqual([]);
    } finally {
      const cleanup = await api.delete(rest(`members?id=eq.${row.id}`), { headers: returning(as['adm-a'].headers) });
      expect(await cleanup.json()).toHaveLength(1);
    }
  });

  test('o líder não muda o papel de ninguém', async () => {
    const res = await api.patch(rest(`members?user_id=eq.${as['membro-a'].id}`), { headers: as['lider-a'].headers, data: { role: 'lider' } });
    expect(res.ok()).toBe(false);
  });

  test('o último administrador não deixa de ser administrador', async () => {
    const res = await api.patch(rest(`members?user_id=eq.${as['adm-a'].id}`), { headers: as['adm-a'].headers, data: { role: 'membro' } });
    expect(res.ok()).toBe(false);
  });

  test('a liderança não configura a igreja (só o admin)', async () => {
    const res = await api.patch(rest(`churches?id=eq.${church.a}`), { headers: returning(as['lider-a'].headers), data: { welcome_text: 'Líder mudou' } });
    if (res.ok()) expect(await res.json()).toEqual([]);
  });
});

test.describe('Administração da plataforma', () => {
  test('admin de igreja não é admin da plataforma', async () => {
    expect(await (await rpc('adm-a', 'is_platform_admin')).json()).toBe(false);
    expect((await api.get(rest('platform_admins?select=*'), { headers: as['adm-a'].headers })).ok()).toBe(false);
    expect((await rpc('adm-a', 'create_church', { p_slug: 'invasora', p_name: 'Invasora', p_admin_email: 'a@b.com' })).ok()).toBe(false);
    expect((await rpc('adm-a', 'set_church_admin', { p_church: church.b, p_email: 'adm-a@teste.igrejaconecta.invalid' })).ok()).toBe(false);
    expect((await rpc('adm-a', 'set_church_active', { p_church: church.b, p_active: false })).ok()).toBe(false);
  });

  test('responder ao convite de outra igreja não dá acesso a ela', async () => {
    await rpc('adm-a', 'respond_to_church', { p_church: church.b, p_accept: true });
    expect(await (await rpc('adm-a', 'my_church_ids')).json()).toEqual([church.a]);
  });
});

test.describe('Arquivos por igreja', () => {
  test('o admin grava na pasta pública da própria igreja e não na da outra', async () => {
    const mine = `${church.a}/testes/isolamento.png`;
    const ok = await upload('adm-a', 'igrejas', mine);
    expect(ok.ok(), await ok.text()).toBe(true);
    await removeFile('adm-a', 'igrejas', mine);
    await expectDenied(await upload('adm-a', 'igrejas', `${church.b}/testes/isolamento.png`), 'adm-a na pasta da B');
  });

  test('líder e membro não gravam na pasta pública da igreja', async () => {
    for (const who of ['lider-a', 'membro-a']) {
      await expectDenied(await upload(who, 'igrejas', `${church.a}/testes/${who}.png`), who);
    }
  });

  test('fotos dos membros: a liderança grava na própria igreja; o membro e a outra igreja, não', async () => {
    const path = `${church.a}/testes/isolamento.webp`;
    const ok = await upload('lider-a', 'membros', path);
    expect(ok.ok(), await ok.text()).toBe(true);
    try {
      // A outra igreja não baixa a foto, e quem não é da igreja também não.
      for (const who of ['adm-b', 'sem-igreja']) {
        const res = await api.get(`${SUPABASE_URL}/storage/v1/object/authenticated/membros/${path}`, { headers: as[who].headers });
        expect(res.ok(), who).toBe(false);
      }
      const member = await api.get(`${SUPABASE_URL}/storage/v1/object/authenticated/membros/${path}`, { headers: as['membro-a'].headers });
      expect(member.ok()).toBe(true);
    } finally {
      await removeFile('lider-a', 'membros', path);
    }
    await expectDenied(await upload('membro-a', 'membros', `${church.a}/testes/membro.webp`), 'membro-a');
    await expectDenied(await upload('lider-a', 'membros', `${church.b}/testes/isolamento.webp`), 'lider-a na pasta da B');
  });
});
