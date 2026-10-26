// O site abre no Android e no iPhone: início, página da igreja e páginas que não existem.
import { test, expect } from '@playwright/test';
import { configured } from './helpers.mjs';

test.beforeEach(() => test.skip(!configured, 'Falta a chave pública em js/config.js'));

test('início convida a entrar', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Igreja Conecta' })).toBeVisible();
  await expect(page.locator('.hero').getByRole('link', { name: 'Entrar' })).toBeVisible();
});

// A Igreja Teste A nunca ganha pasta própria (igrejas de teste ficam fora da publicação), e o nome dela não muda.
test('página da igreja mostra o nome dela, mesmo antes de ganhar a pasta própria', async ({ page }) => {
  await page.goto('/i/teste-a/');
  await expect(page.locator('.church-hero h1')).toHaveText('Igreja Teste A');
  await expect(page.locator('#app-name')).toHaveText('Igreja Teste A');
  await expect(page).toHaveTitle('Igreja Teste A');
  await page.locator('.page').getByRole('link', { name: 'Entrar' }).click();
  // O link continua dentro da igreja (o <base> da página aponta para a raiz do site).
  await expect(page).toHaveURL(/\/i\/teste-a\/#\/entrar$/);
  await expect(page.locator('#app-name')).toHaveText('Igreja Teste A');
  await expect(page.getByRole('button', { name: 'Receber link de acesso' })).toBeVisible();
});

test('botão do Google só aparece com o login do Google ligado no Supabase', async ({ page }) => {
  const settings = (google) => (route) => route.fulfill({ json: { external: { email: true, google } } });
  await page.route('**/auth/v1/settings', settings(false));
  await page.goto('/i/exemplo/#/entrar');
  await expect(page.getByRole('button', { name: 'Receber link de acesso' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Entrar com Google' })).toBeHidden();

  await page.unroute('**/auth/v1/settings');
  await page.route('**/auth/v1/settings', settings(true));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Entrar com Google' })).toBeVisible();
});

test('limite de envio de e-mails aparece em português', async ({ page }) => {
  await page.route('**/auth/v1/otp*', (route) =>
    route.fulfill({ status: 429, json: { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' } }),
  );
  await page.goto('/i/exemplo/#/entrar');
  await page.getByLabel('Seu e-mail').fill('alguem@exemplo.com');
  await page.getByRole('button', { name: 'Receber link de acesso' }).click();
  await expect(page.locator('#toast')).toContainText('Muitos pedidos de link de acesso');
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
