// Tela de Ajuda: cada papel vê os tópicos que fazem sentido para ele (Android).
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

test('o membro abre a Ajuda pelo Menu e vê só os tópicos para todos', async ({ page }) => {
  await openLoggedIn(page, accounts['membro-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: /Ajuda/ }).click();
  await expect(page.getByRole('heading', { name: 'Ajuda', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Para todos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Para a liderança' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Para o administrador' })).toHaveCount(0);

  // Abrir um tópico e seguir um link dele continua dentro da igreja.
  await page.getByText('Meu cadastro e privacidade').click();
  await page.getByRole('link', { name: 'Menu > Meu cadastro' }).click();
  await expect(page).toHaveURL(/\/i\/teste-a\/#\/perfil$/);
});

test('a líder vê também os tópicos da liderança', async ({ page }) => {
  await openLoggedIn(page, accounts['lider-a'].session, '/i/teste-a/#/ajuda');
  await expect(page.getByRole('heading', { name: 'Para a liderança' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Para o administrador' })).toHaveCount(0);
  await expect(page.getByText('Importar uma planilha de membros')).toBeVisible();
});

test('não oferece instalar enquanto a página da igreja não tem o ícone atual', async ({ page }) => {
  // A Teste A nunca ganha pasta própria: a página não traz a versão do ícone.
  await openLoggedIn(page, accounts['membro-a'].session, '/i/teste-a/#/ajuda');
  await page.getByText('Instalar o app no celular').click();
  await expect(page.locator('#help-install')).toContainText('O ícone novo da igreja está sendo preparado');

  // Página publicada com o ícone atual (como build-site.mjs gera): o aviso some.
  await page.route('**/i/teste-a/', async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace('<head>', '<head><meta name="icone-versao" content="999">');
    await route.fulfill({ response: res, body: html });
  });
  await page.reload();
  await page.getByText('Instalar o app no celular').click();
  await expect(page.locator('#help-install')).not.toContainText('sendo preparado');
});

test('o administrador vê tudo, com o endereço do app para divulgar', async ({ page }) => {
  await openLoggedIn(page, accounts['adm-a'].session, '/i/teste-a/#/ajuda');
  await expect(page.getByRole('heading', { name: 'Para o administrador' })).toBeVisible();
  await page.getByText('Divulgar o app para a igreja').click();
  await expect(page.locator('#app-url')).toHaveText(/\/i\/teste-a\/$/);
});

test('a configuração mostra o nome que vai embaixo do ícone do app', async ({ page }) => {
  await openLoggedIn(page, accounts['adm-a'].session, '/i/teste-a/#/config');
  const iconName = page.getByLabel('Nome embaixo do ícone');
  await expect(iconName).toHaveText('Teste A');
  await page.getByLabel('Nome curto (embaixo do ícone no celular)').fill('');
  await expect(iconName).toHaveText('Igreja Teste A');
  await page.getByLabel('Nome curto (embaixo do ícone no celular)').fill('Minha Igreja');
  await expect(iconName).toHaveText('Minha Igreja');
});
