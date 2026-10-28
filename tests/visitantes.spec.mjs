// Cadastro de visitantes nas telas: o visitante sem conta e a liderança da Teste A (Android).
// O que o teste cria leva uma marca no nome e é apagado no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const tag = `UI ${Date.now().toString(36)}`;
const name = `Visitante ${tag}`;

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  as['lider-a'] = await loginAs(api, 'lider-a');
});

test.afterAll(async () => {
  if (!api) return;
  await api.delete(rest(`visitors?name=like.*${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  await api.dispose();
});

test('o visitante, sem conta, deixa o contato pelo link do QR Code', async ({ page }) => {
  await page.goto('/i/teste-a/#/');
  await page.getByRole('link', { name: /Sou visitante/ }).click();
  await expect(page.getByRole('heading', { name: 'Seja bem-vindo!' })).toBeVisible();
  await page.getByLabel('Seu nome').fill(name);
  await page.getByLabel('WhatsApp').fill('(61) 99999-0009');
  await page.getByLabel('Como conheceu a igreja?').selectOption('amigos');
  await page.getByRole('button', { name: 'Enviar' }).click();
  // Sem a autorização marcada, o navegador não deixa enviar.
  await expect(page.getByRole('heading', { name: /Obrigado/ })).toHaveCount(0);
  await page.getByLabel(/Autorizo a Igreja Teste A/).check();
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByRole('heading', { name: 'Obrigado, Visitante!' })).toBeVisible();
});

test('a liderança vê o visitante, chama no WhatsApp e registra o acompanhamento', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Visitantes' }).click();
  await page.locator('.member-row', { hasText: name }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const wa = page.getByRole('link', { name: 'Chamar no WhatsApp' });
  await expect(wa).toHaveAttribute('href', /^https:\/\/wa\.me\/5561999990009\?text=Ol%C3%A1%2C%20Visitante!/);
  await page.getByLabel('Situação').selectOption('contatado');
  await page.getByLabel('Anotações do acompanhamento').fill('Mandei mensagem, vem domingo.');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Salvo.')).toBeVisible();
  await page.getByRole('link', { name: /^Contatado/ }).click();
  await expect(page.locator('.member-row', { hasText: name })).toContainText('Contatado');

  // O QR Code fica no botão redondo (com o ícone do QR Code, não o "+").
  await expect(page.locator('.fab')).toHaveAttribute('href', '#/visitantes/qr');
  await page.getByRole('link', { name: 'QR Code para o culto' }).click();
  await expect(page.locator('#visitor-qr svg')).toBeVisible();
  await expect(page.locator('.visitor-qr code')).toHaveText(/\/i\/teste-a\/#\/visitante$/);
});

test('Visitantes abre na hora para a liderança, mesmo com o banco demorando', async ({ page }) => {
  // O Início busca os visitantes em segundo plano (só na memória, nunca gravados no aparelho).
  const prefetched = page.waitForResponse((r) => r.url().includes('/rest/v1/visitors?'));
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/');
  await prefetched;
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Visitantes' }).click();
  await expect(page.getByRole('heading', { name: 'Visitantes' })).toBeVisible({ timeout: 1000 });
  // E nada dos visitantes fica gravado no aparelho.
  const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.endsWith(':visitantes')));
  expect(saved).toEqual([]);
});
