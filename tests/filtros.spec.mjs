// Filtros das notificações numa linha só (Android, celular pequeno).
import { test, expect } from '@playwright/test';
import { configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test('os filtros ficam numa linha só, deslizam para o lado e mostram só os grupos com notificação', async ({ page, playwright }) => {
  test.skip(!configured || !testPassword(), 'Sem as contas de teste');
  const api = await playwright.request.newContext();
  const lider = await loginAs(api, 'lider-a');
  await api.dispose();
  await page.setViewportSize({ width: 360, height: 760 });
  await openLoggedIn(page, lider.session, '/i/teste-a/#/notificacoes');
  const nav = page.getByRole('navigation', { name: 'Filtrar notificações' });
  await expect(nav.getByRole('link', { name: 'Todas' })).toHaveAttribute('aria-current', 'page');
  // Uma linha: a faixa tem a altura de uma pílula, e o que não cabe fica para o lado.
  const box = await nav.boundingBox();
  expect(box.height).toBeLessThan(60);
  expect(await nav.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // Só os grupos que têm notificação aparecem (a líder da Teste A sempre tem pedidos de oração).
  const labels = await nav.getByRole('link').allInnerTexts();
  expect(labels.length).toBeGreaterThan(1);
  await nav.getByRole('link', { name: /^Oração/ }).click();
  await expect(nav.getByRole('link', { name: /^Oração/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.notif-icon').first()).toHaveClass(/k-oracao/);
});
