// O site abre no Android e no iPhone: início, página da igreja e páginas que não existem.
import { test, expect } from '@playwright/test';
import { configured } from './helpers.mjs';

test.beforeEach(() => test.skip(!configured, 'Falta a chave pública em js/config.js'));

test('início convida a entrar', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Igreja Conecta' })).toBeVisible();
  await expect(page.locator('.hero').getByRole('link', { name: 'Entrar' })).toBeVisible();
});

test('página da igreja mostra o nome dela, mesmo antes de ganhar a pasta própria', async ({ page }) => {
  await page.goto('/i/exemplo/');
  await expect(page.locator('.church-hero h1')).toHaveText('Igreja Exemplo');
  await expect(page.locator('#app-name')).toHaveText('Igreja Exemplo');
  await expect(page).toHaveTitle('Igreja Exemplo');
  await page.locator('.page').getByRole('link', { name: 'Entrar' }).click();
  await expect(page.getByRole('button', { name: 'Receber link de acesso' })).toBeVisible();
});

test('igreja que não existe', async ({ page }) => {
  await page.goto('/i/nao-existe-esta/');
  await expect(page.getByRole('heading', { name: 'Igreja não encontrada' })).toBeVisible();
});

test('página que não existe', async ({ page }) => {
  const res = await page.goto('/qualquer-coisa');
  expect(res.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
});

test('textos da igreja não viram código na tela', async ({ page }) => {
  const evil = '<img src=x onerror="window.__xss=1">';
  await page.route('**/rest/v1/churches?*', async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    const poison = (r) => ({ ...r, welcome_text: evil, about_text: evil });
    await route.fulfill({ response: res, json: Array.isArray(data) ? data.map(poison) : poison(data) });
  });
  await page.goto('/i/exemplo/');
  await expect(page.locator('.church-hero p')).toContainText('<img');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});
