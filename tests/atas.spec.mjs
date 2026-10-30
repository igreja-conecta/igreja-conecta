// ATAs das reuniões na igreja Teste A: o administrador envia o PDF, os membros abrem e recebem
// o aviso; líder e membro não enviam nem apagam; quem é de outra igreja não vê. A pasta só aceita
// PDF de até 5 MB. As ATAs do teste levam a marca no título e são apagadas no fim (com os PDFs).
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, ANON_KEY, rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
let church;
const TAG = `ATA teste ${Date.now().toString(36)}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');

const mine = async (who = 'adm-a') =>
  (await api.get(rest(`meeting_minutes?select=id,title,path,published_at,file_size&title=like.${encodeURIComponent(TAG)}*`), { headers: as[who].headers })).json();
const upload = (who, path, body, type = 'application/pdf') =>
  api.post(`${SUPABASE_URL}/storage/v1/object/atas/${path}`, {
    headers: { apikey: ANON_KEY, Authorization: as[who].headers.Authorization, 'Content-Type': type, 'x-upsert': 'true' },
    data: body,
  });
const download = (who, path) => api.get(`${SUPABASE_URL}/storage/v1/object/authenticated/atas/${path}`, { headers: as[who].headers });

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['adm-a', 'lider-a', 'membro-a', 'adm-b']) as[u] = await loginAs(api, u);
  [{ id: church }] = await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: as['adm-a'].headers })).json();
});

test.afterAll(async () => {
  if (!api) return;
  const rows = await mine().catch(() => []);
  if (rows.length) {
    await api.delete(`${SUPABASE_URL}/storage/v1/object/atas`, { headers: as['adm-a'].headers, data: { prefixes: rows.map((r) => r.path) } });
    await api.delete(rest(`meeting_minutes?id=in.(${rows.map((r) => r.id).join(',')})`), { headers: as['adm-a'].headers });
  }
  await api.dispose();
});

test('o banco: só admin e secretaria enviam, só PDF até 5 MB, e a ATA aparece aos membros depois do arquivo', async () => {
  const row = { church_id: church, title: `${TAG} banco`, meeting_date: '2026-10-12' };
  // Líder e membro não registram ATA.
  for (const who of ['lider-a', 'membro-a']) {
    const res = await api.post(rest('meeting_minutes'), { headers: as[who].headers, data: row });
    expect(res.status(), who).toBe(403);
  }
  // O administrador registra; o caminho do arquivo é o banco que decide.
  const res = await api.post(rest('meeting_minutes'), {
    headers: { ...as['adm-a'].headers, Prefer: 'return=representation' },
    data: row,
  });
  expect(res.status()).toBe(201);
  const [ata] = await res.json();
  expect(ata.path).toBe(`${church}/${ata.id}.pdf`);
  expect(ata.published_at).toBeNull();
  // Antes do arquivo: o membro não vê, e não dá para publicar.
  expect(await mine('membro-a')).toHaveLength(0);
  const early = await api.post(rest('rpc/minutes_publish'), { headers: as['adm-a'].headers, data: { p_id: ata.id } });
  expect(early.ok()).toBe(false);
  // A pasta recusa o que não é PDF e o que passa de 5 MB; o membro e o líder não enviam.
  expect((await upload('adm-a', ata.path, Buffer.from('<html></html>'), 'text/html')).ok()).toBe(false);
  expect((await upload('adm-a', ata.path, Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]))).ok()).toBe(false);
  for (const who of ['lider-a', 'membro-a']) expect((await upload(who, ata.path, PDF)).ok(), who).toBe(false);
  // Outro caminho, mesmo na pasta da igreja: recusado.
  expect((await upload('adm-a', `${church}/qualquer.pdf`, PDF)).ok()).toBe(false);
  expect((await upload('adm-a', ata.path, PDF)).ok()).toBe(true);
  // Só quem envia publica.
  const byMember = await api.post(rest('rpc/minutes_publish'), { headers: as['membro-a'].headers, data: { p_id: ata.id } });
  expect(byMember.ok()).toBe(false);
  const pub = await api.post(rest('rpc/minutes_publish'), { headers: as['adm-a'].headers, data: { p_id: ata.id } });
  expect(pub.ok(), await pub.text()).toBe(true);
  // Agora o membro vê e baixa; quem é de outra igreja, não.
  const [seen] = await mine('membro-a');
  expect(seen.file_size).toBe(PDF.length);
  expect((await download('membro-a', ata.path)).ok()).toBe(true);
  expect(await mine('adm-b')).toHaveLength(0);
  expect((await download('adm-b', ata.path)).ok()).toBe(false);
  // O membro recebeu o aviso (uma vez só, mesmo publicando de novo ao trocar o PDF).
  await api.post(rest('rpc/minutes_publish'), { headers: as['adm-a'].headers, data: { p_id: ata.id } });
  const notes = await (
    await api.get(rest(`notifications?select=kind,url&title=eq.${encodeURIComponent(`Nova ATA: ${TAG} banco`)}`), { headers: as['membro-a'].headers })
  ).json();
  expect(notes).toEqual([{ kind: 'ata', url: '#/atas' }]);
  // O membro não muda, não troca o caminho e não apaga.
  await api.patch(rest(`meeting_minutes?id=eq.${ata.id}`), { headers: as['membro-a'].headers, data: { title: 'Mudou' } });
  await api.delete(rest(`meeting_minutes?id=eq.${ata.id}`), { headers: as['membro-a'].headers });
  await api.delete(`${SUPABASE_URL}/storage/v1/object/atas`, { headers: as['membro-a'].headers, data: { prefixes: [ata.path] } });
  const patchPath = await api.patch(rest(`meeting_minutes?id=eq.${ata.id}`), { headers: as['adm-a'].headers, data: { path: 'outra/coisa.pdf' } });
  expect(patchPath.ok()).toBe(false);
  const [still] = await mine();
  expect(still.title).toBe(`${TAG} banco`);
  expect(still.path).toBe(ata.path);
  expect((await download('adm-a', ata.path)).ok()).toBe(true);
});

test('o administrador envia a ATA pelo botão +; o PDF errado é recusado no aparelho', async ({ page }) => {
  await openLoggedIn(page, as['adm-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'ATAs das reuniões' }).click();
  await expect(page.getByRole('heading', { name: 'ATAs', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Nova ATA' }).click();
  await page.getByLabel('Título').fill(`${TAG} tela`);
  await page.getByLabel('Data da reunião').fill('2026-09-14');
  await page.getByLabel('Arquivo PDF').setInputFiles({ name: 'foto.pdf', mimeType: 'application/pdf', buffer: Buffer.from('não é PDF') });
  await page.getByRole('button', { name: 'Enviar ATA' }).click();
  await expect(page.getByText('Escolha um arquivo PDF.')).toBeVisible();
  await page.getByLabel('Arquivo PDF').setInputFiles({ name: 'ata-setembro.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByRole('button', { name: 'Enviar ATA' }).click();
  await expect(page.getByText('ATA enviada. Os membros vão receber um aviso.')).toBeVisible();
  await expect(page.getByRole('heading', { name: '2026' })).toBeVisible();
  await expect(page.locator('.minutes-item', { hasText: `${TAG} tela` })).toContainText('Reunião de 14/09/2026');
  const rows = await mine();
  expect(rows.find((r) => r.title === `${TAG} tela`)?.published_at).toBeTruthy();
});

test('o membro abre a ATA (PDF numa aba nova) e não vê o + nem o Editar', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/atas');
  const row = page.locator('.minutes-item', { hasText: `${TAG} tela` });
  await expect(row).toBeVisible();
  await expect(page.locator('.fab')).toHaveCount(0);
  await expect(row.getByRole('link', { name: /Editar/ })).toHaveCount(0);
  const link = row.locator('a.menu-row');
  await expect(link).toHaveAttribute('href', /\/storage\/v1\/object\/sign\/atas\//);
  await expect(link).toHaveAttribute('target', '_blank');
  const res = await page.request.get(await link.getAttribute('href'));
  expect(res.ok()).toBe(true);
  expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
});

test('a tela das ATAs abre na hora, mesmo com o banco demorando', async ({ page }) => {
  const prefetched = page.waitForResponse(/rest\/v1\/meeting_minutes/);
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await prefetched;
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  // Pelo atalho do Início.
  await page.locator('.shortcuts').getByRole('link', { name: 'ATAs' }).click();
  await expect(page.locator('.minutes-item', { hasText: `${TAG} tela` })).toBeVisible({ timeout: 1000 });
});

test('o administrador corrige a data e apaga a ATA (com o PDF)', async ({ page }) => {
  await openLoggedIn(page, as['adm-a'].session, '/i/teste-a/#/atas');
  await page.getByRole('link', { name: `Editar ${TAG} tela` }).click();
  await expect(page.getByLabel('Trocar o PDF (opcional)')).toBeVisible();
  await page.getByLabel('Data da reunião').fill('2025-09-14');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('ATA salva.')).toBeVisible();
  await expect(page.getByRole('heading', { name: '2025' })).toBeVisible();
  const [ata] = (await mine()).filter((r) => r.title === `${TAG} tela`);
  await page.getByRole('link', { name: `Editar ${TAG} tela` }).click();
  await page.getByRole('button', { name: 'Apagar a ATA' }).click();
  await answer(page);
  await expect(page.getByText('ATA apagada.')).toBeVisible();
  await expect(page.locator('.minutes-item', { hasText: `${TAG} tela` })).toHaveCount(0);
  expect((await download('adm-a', ata.path)).ok()).toBe(false);
});
