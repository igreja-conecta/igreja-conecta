// Tema claro ou escuro pelo botão do topo, guardado no aparelho (Android).
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

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

// Cor que a página usa nos links e ícones (--link), já calculada pelo navegador.
const linkColor = (page) =>
  page.evaluate(() => {
    const probe = document.body.appendChild(Object.assign(document.createElement('span'), { style: 'color: var(--link)' }));
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
const brandColor = (page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim());

test('no tema escuro, o admin escolhe entre a cor clareada e a cor principal nos links', async ({ page, playwright }) => {
  test.skip(!configured || !testPassword(), 'Sem as contas de teste');
  const api = await playwright.request.newContext();
  const admin = await loginAs(api, 'adm-a');
  const reset = () => api.patch(rest('churches?slug=eq.teste-a'), { headers: admin.headers, data: { dark_brand: 'clara' } });
  try {
    await reset();
    await page.emulateMedia({ colorScheme: 'dark' });
    await openLoggedIn(page, admin.session, '/i/teste-a/#/config');
    const clara = page.getByLabel('A cor principal clareada');
    const principal = page.getByLabel('A cor principal da igreja');
    await expect(clara).toBeChecked();
    const lighter = await linkColor(page);
    // Cor escura demais para o fundo escuro: avisa (só ao escolher a cor principal).
    const color = await page.getByLabel('Cor principal').inputValue();
    await page.getByLabel('Cor principal').fill('#1b2a4a');
    await expect(page.locator('#dark-warn')).toBeHidden();
    await principal.check();
    await expect(page.locator('#dark-warn')).toBeVisible();
    await page.getByLabel('Cor principal').fill(color);
    await expect(page.locator('#dark-warn')).toBeHidden();

    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.locator('#toast')).toContainText(/salva|Pronto/);
    await expect(page.locator('html')).toHaveAttribute('data-dark-brand', 'principal');
    const pure = await linkColor(page);
    expect(pure).not.toBe(lighter);
    const hex = await brandColor(page);
    const rgb = `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    expect(pure).toBe(rgb);
    // Vale também ao abrir de novo e no tema escuro escolhido pelo botão.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    expect(await linkColor(page)).toBe(rgb); // tema claro: sempre a cor principal
    await page.locator('#theme-btn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await linkColor(page)).toBe(rgb);
  } finally {
    await reset();
    await api.dispose();
  }
});
