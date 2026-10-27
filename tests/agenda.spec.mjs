// Agenda, avisos e central de notificações nas telas, com contas da igreja Teste A (Android).
// O que o teste cria leva uma marca no título e é apagado no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const tag = `UI ${Date.now().toString(36)}`;

// Amanhã no horário de Brasília, o mesmo do navegador nos testes (o GitHub roda em UTC:
// entre 21h e meia-noite, o "amanhã" de lá já seria depois de amanhã aqui).
const tomorrow = () => new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['lider-a', 'membro-a']) as[u] = await loginAs(api, u);
});

test.afterAll(async () => {
  if (!api) return;
  for (const table of ['events', 'announcements']) {
    await api.delete(rest(`${table}?title=like.*${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  }
  await api.dispose();
});

test('a líder cria um evento semanal e o membro vê na agenda, com "adicionar à agenda"', async ({ page, browser }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/agenda/novo');
  await page.getByLabel('Título').fill(`Culto ${tag}`);
  await page.getByLabel('Data').fill(tomorrow());
  await page.getByLabel('Começa').fill('19:00');
  await page.getByLabel('Termina (opcional)').fill('21:00');
  await page.getByLabel('Local (opcional)').fill('Templo principal');
  await page.getByLabel('Repetir toda semana').check();
  await page.getByRole('button', { name: 'Criar evento' }).click();
  await expect(page.getByRole('heading', { name: `Culto ${tag}` })).toBeVisible();
  await expect(page.locator('.page')).toContainText('Amanhã · 19h–21h');
  await expect(page.locator('.page')).toContainText('Repete toda semana');

  const member = await (await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' })).newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/agenda');
  const card = member.locator('.event-card', { hasText: `Culto ${tag}` }).first();
  await expect(card).toContainText('19h');
  await expect(card).toContainText('Toda semana');
  await card.click();
  await expect(member.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  const download = member.waitForEvent('download');
  await member.getByRole('button', { name: 'Adicionar à agenda' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^evento-\d{4}-\d{2}-\d{2}\.ics$/);
  await expect(member.getByRole('link', { name: 'Google Agenda' })).toHaveAttribute('href', /calendar\.google\.com/);
  await member.context().close();
});

test('a líder publica um aviso fixado e o membro vê no mural e no início', async ({ page, browser }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/avisos/novo');
  await page.getByLabel('Título').fill(`Aviso ${tag}`);
  await page.getByRole('textbox', { name: 'Aviso', exact: true }).fill('Ensaio do coral no sábado às 15h.');
  await page.getByLabel('Fixar no topo').check();
  await page.getByRole('button', { name: 'Publicar aviso' }).click();
  await expect(page.locator('.announcement', { hasText: `Aviso ${tag}` })).toContainText('Fixado');

  const member = await (await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' })).newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/avisos');
  const card = member.locator('.announcement', { hasText: `Aviso ${tag}` });
  await expect(card).toContainText('Ensaio do coral');
  await expect(card.getByRole('button', { name: 'Excluir' })).toHaveCount(0);
  await member.evaluate(() => (location.hash = '/'));
  await expect(member.locator('#home-notices')).toContainText(`Aviso ${tag}`);
  await member.context().close();
});

test('o membro abre a central de notificações pelo sininho', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await page.getByRole('link', { name: 'Notificações' }).first().click();
  await expect(page.getByRole('heading', { name: 'Notificações', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No celular' })).toBeVisible();
  await expect(page).toHaveURL(/\/i\/teste-a\/#\/notificacoes$/);
});
