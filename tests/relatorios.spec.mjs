// Relatórios nas telas, com contas da igreja Teste A (Android).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

let api;
const as = {};

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['lider-a', 'membro-a']) as[u] = await loginAs(api, u);
});

test.afterAll(async () => api?.dispose());

test('a liderança vê os relatórios, troca o período e baixa as planilhas', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Relatórios' }).click();
  const members = page.locator('.report-section', { has: page.getByRole('heading', { name: 'Membros' }) });
  await expect(members.locator('.stat-tile', { hasText: 'Membros ativos' })).toBeVisible();
  await expect(members.getByText('Novos membros por mês')).toBeVisible();
  for (const section of ['Visitantes', 'Células', 'Ministério infantil', 'Escalas', 'Eventos com inscrição', 'Participação no app']) {
    await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
  }

  await page.getByRole('link', { name: 'Últimos 12 meses' }).click();
  await expect(page.getByText(/^Últimos 12 meses:/)).toBeVisible();

  const sectionCsv = page.waitForEvent('download');
  await members.getByRole('button', { name: 'Baixar planilha' }).click();
  const csv = await sectionCsv;
  expect(csv.suggestedFilename()).toMatch(/^relatorio-membros-.*\.csv$/);
  expect(readFileSync(await csv.path(), 'utf8')).toContain('"Membros ativos"');

  const listCsv = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Lista de membros completa' }).click();
  const list = await listCsv;
  expect(list.suggestedFilename()).toMatch(/^membros-.*\.csv$/);
  const text = readFileSync(await list.path(), 'utf8');
  expect(text).toContain('"Fulano da A"');
  expect(text).not.toContain('Fulano da B');
});

test('o membro comum não vê os relatórios', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/menu');
  await expect(page.getByRole('heading', { name: 'Menu' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Relatórios' })).toHaveCount(0);
  await page.evaluate(() => (location.hash = '/relatorios'));
  await expect(page.locator('.church-hero')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Relatórios' })).toHaveCount(0);
});

test('os relatórios abrem na hora, mesmo com o banco demorando', async ({ page }) => {
  const prefetched = page.waitForResponse(/rpc\/church_report/);
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/');
  await prefetched;
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Relatórios' }).click();
  await expect(page.locator('.stat-tile', { hasText: 'Membros ativos' })).toBeVisible({ timeout: 1000 });
});
