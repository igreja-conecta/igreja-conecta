// Telas de aniversário com contas de teste da igreja Teste A (Android).
import { test, expect } from '@playwright/test';
import { configured, testPassword, loginAs, openLoggedIn } from './helpers.mjs';

const accounts = {};

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  const api = await playwright.request.newContext();
  for (const u of ['membro-a', 'lider-a', 'adm-a']) accounts[u] = await loginAs(api, u);
  await api.dispose();
});

test('o membro vê no mês só quem autorizou mostrar o aniversário', async ({ page }) => {
  await openLoggedIn(page, accounts['membro-a'].session, '/i/teste-a/#/aniversariantes?mes=2027-02');
  await expect(page.getByRole('heading', { name: 'Aniversariantes de fevereiro' })).toBeVisible();
  const day = page.locator('.bday-day', { hasText: 'Bissexto da A' });
  await expect(day.locator('.bday-date strong')).toHaveText('28');
  await expect(day).not.toContainText('anos');
  await page.evaluate(() => (location.hash = '/aniversariantes?mes=2027-03'));
  await expect(page.getByRole('heading', { name: 'Aniversariantes de março' })).toBeVisible();
  await expect(page.getByText('Nenhum aniversariante em março.')).toBeVisible();
});

test('a liderança vê todos, com a idade, e pode imprimir', async ({ page }) => {
  await openLoggedIn(page, accounts['lider-a'].session, '/i/teste-a/#/aniversariantes?mes=2027-03');
  await expect(page.locator('.bday-day', { hasText: 'Fulano da A' })).toContainText('faz 47 anos');
  await page.getByRole('link', { name: 'Próximo mês' }).click();
  await expect(page.getByRole('heading', { name: 'Aniversariantes de abril' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Imprimir' })).toBeVisible();
});

test('o admin vê a prévia da mensagem com os campos trocados', async ({ page }) => {
  await openLoggedIn(page, accounts['adm-a'].session, '/i/teste-a/#/config/aniversario');
  await page.getByLabel('Título').fill('Parabéns, ');
  await page.getByRole('button', { name: '{primeiro_nome}' }).click();
  await expect(page.locator('#pv-title')).toHaveText('Parabéns, Admin');
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('{igreja} deseja feliz {idade} anos!');
  await expect(page.locator('#pv-body')).toHaveText('Igreja Teste A deseja feliz 30 anos!');
});
