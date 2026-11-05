// Ordem dos atalhos do Início (SQL 043, churches.home_order): o administrador da Teste A organiza
// arrastando, a ordem vale para todos (o membro vê igual e não vê o botão) e o banco recusa quem
// não é administrador, outra igreja e chave inválida. No fim a ordem volta a ser a de sempre (nula).
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
let church;

const setOrder = (who, order) =>
  api.patch(rest(`churches?id=eq.${church}`), { headers: { ...as[who].headers, Prefer: 'return=representation' }, data: { home_order: order } });
const savedOrder = async () => (await (await api.get(rest(`churches?select=home_order&id=eq.${church}`), { headers: as['adm-a'].headers })).json())[0]?.home_order ?? null;

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['adm-a', 'membro-a', 'adm-b']) as[u] = await loginAs(api, u);
  [{ id: church }] = await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: as['adm-a'].headers })).json();
  const col = await api.get(rest(`churches?select=home_order&id=eq.${church}`), { headers: as['adm-a'].headers });
  expect(col.ok(), 'Falta rodar o supabase/043_ordem_atalhos.sql').toBe(true);
  expect((await setOrder('adm-a', null)).ok()).toBe(true);
});

test.afterAll(async () => {
  if (!api) return;
  await setOrder('adm-a', null).catch(() => {});
  await api.dispose();
});

test('o banco: só o administrador da própria igreja grava a ordem, e só com chaves válidas', async () => {
  // Membro da A e administrador da B: o banco não grava (nenhuma linha muda).
  for (const who of ['membro-a', 'adm-b']) {
    const res = await setOrder(who, ['agenda', 'avisos']);
    if (res.ok()) expect(await res.json(), who).toEqual([]);
    expect(await savedOrder(), who).toBeNull();
  }
  // Chave fora do formato e mais de 60 chaves: recusadas pela regra da coluna.
  expect((await setOrder('adm-a', ['Agenda!'])).status()).toBe(400);
  expect((await setOrder('adm-a', Array.from({ length: 61 }, (_, i) => `k_${'x'.repeat(i % 20)}`))).status()).toBe(400);
  // O administrador da A grava.
  expect((await setOrder('adm-a', ['avisos', 'agenda'])).ok()).toBe(true);
  expect(await savedOrder()).toEqual(['avisos', 'agenda']);
  expect((await setOrder('adm-a', null)).ok()).toBe(true);
});

test('o administrador organiza os atalhos arrastando e o membro vê a mesma ordem', async ({ page, browser }) => {
  await openLoggedIn(page, as['adm-a'].session, '/i/teste-a/#/');
  const tiles = page.locator('#home-shortcuts > [data-key]');
  await expect(tiles.nth(2)).toBeVisible();
  const keys = () => tiles.evaluateAll((els) => els.map((el) => el.dataset.key));
  const before = await keys();

  await page.getByRole('button', { name: '≡ Organizar atalhos' }).click();
  await expect(page.getByText('Arraste para mudar a ordem. Vale para todos da igreja.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pronto' })).toBeVisible();
  // No modo organizando, tocar no atalho não abre a tela.
  const url = page.url();
  await tiles.first().click();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(url);

  // Arrasta o primeiro atalho até o lugar do terceiro.
  await expect(async () => {
    const a = await tiles.first().boundingBox();
    const b = await tiles.nth(2).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 16 });
    await page.waitForTimeout(350);
    await page.mouse.up();
    expect((await keys())[0]).not.toBe(before[0]);
  }).toPass({ timeout: 15000 });
  const after = await keys();
  expect([...after].sort()).toEqual([...before].sort());
  await expect.poll(savedOrder).toEqual(after);

  await page.getByRole('button', { name: 'Pronto' }).click();
  await expect(page.getByText('Arraste para mudar a ordem. Vale para todos da igreja.')).toBeHidden();

  // Outra sessão (membro): mesma ordem, sem o botão de organizar.
  const ctx = await browser.newContext();
  const member = await ctx.newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/');
  const theirs = member.locator('#home-shortcuts > [data-key]');
  await expect(theirs.first()).toBeVisible();
  const seen = await theirs.evaluateAll((els) => els.map((el) => el.dataset.key));
  expect(seen).toEqual(after.filter((k) => seen.includes(k)));
  await expect(member.getByRole('button', { name: '≡ Organizar atalhos' })).toHaveCount(0);
  await ctx.close();
});
