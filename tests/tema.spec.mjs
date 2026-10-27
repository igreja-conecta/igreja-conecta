// Tema claro ou escuro pelo botão do topo, guardado no aparelho (Android).
import { test, expect } from '@playwright/test';
import { configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('o botão troca o tema, a escolha fica no aparelho e a página não pisca ao abrir', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  // Anota o tema no instante em que a página fica pronta (antes de o app desenhar).
  await page.addInitScript(() =>
    document.addEventListener('DOMContentLoaded', () => (window.__temaNaAbertura = document.documentElement.dataset.theme || 'celular')),
  );
  await page.goto('/i/teste-a/');
  const btn = page.locator('#theme-btn');
  await expect(btn).toHaveAttribute('aria-label', 'Usar tema escuro');
  expect(await bg(page)).toBe('rgb(245, 246, 250)');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-label', 'Usar tema claro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg(page)).toBe('rgb(17, 19, 24)');

  await page.reload();
  expect(await page.evaluate(() => window.__temaNaAbertura)).toBe('dark');
  await expect(btn).toHaveAttribute('aria-label', 'Usar tema claro');
  // Também na raiz do site.
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#theme-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('"Tema: seguir o celular" volta ao automático', async ({ page, playwright }) => {
  test.skip(!configured || !testPassword(), 'Sem as contas de teste');
  const api = await playwright.request.newContext();
  const membro = await loginAs(api, 'membro-a');
  await api.dispose();
  await page.emulateMedia({ colorScheme: 'dark' });
  await openLoggedIn(page, membro.session, '/i/teste-a/#/menu');
  await expect(page.getByRole('button', { name: 'Tema: seguir o celular' })).toHaveCount(0); // ainda não escolheu
  await page.locator('#theme-btn').click(); // celular escuro: passa para o claro
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Tema: seguir o celular' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  await expect(page.locator('#theme-btn')).toHaveAttribute('aria-label', 'Usar tema claro');
  expect(await bg(page)).toBe('rgb(17, 19, 24)');
});
