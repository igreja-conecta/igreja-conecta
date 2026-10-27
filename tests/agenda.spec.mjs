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
  await expect(page).toHaveURL(/\/i\/teste-a\/#\/notificacoes$/);
  // Nenhuma aba de baixo fica marcada: a central abre pelo sininho.
  await expect(page.locator('#tabbar a.active')).toHaveCount(0);
  await page.getByRole('link', { name: 'Avisos', exact: true }).first().click();
  await expect(page).toHaveURL(/#\/notificacoes\?ver=avisos$/);
  await expect(page.locator('.chip.active')).toHaveText('Avisos');
});

test('a central mostra as notificações por dia, com destaque nas não lidas', async ({ page }) => {
  // Meio-dia fixo: perto da meia-noite, "30 horas atrás" já não seria "ontem".
  const now = new Date('2027-06-10T12:00:00-03:00').getTime();
  await page.clock.setFixedTime(now);
  const rows = [
    { id: 1, kind: 'oracao', title: 'Seu pedido de oração está no mural', body: 'A igreja já pode orar com você.', url: '#/oracao/meus', read_at: null, created_at: new Date(now - 5 * 60e3).toISOString() },
    { id: 2, kind: 'evento', title: 'Culto de domingo', body: 'Amanhã às 19h', url: '#/agenda', read_at: new Date(now).toISOString(), created_at: new Date(now - 30 * 3600e3).toISOString() },
    { id: 3, kind: 'aviso', title: 'Retiro de jovens', body: 'Inscrições abertas', url: '#/avisos', read_at: new Date(now).toISOString(), created_at: new Date(now - 20 * 864e5).toISOString() },
  ];
  // Lista fixa (a central de verdade muda com os outros testes); "marcar como lida" não grava.
  await page.route('**/rest/v1/notifications?*', (route) =>
    route.request().method() === 'GET' && !route.request().headers()['prefer']?.includes('count')
      ? route.fulfill({ json: rows })
      : route.fulfill({ status: 204 }),
  );
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/notificacoes');
  await expect(page.locator('.notif-day')).toHaveText(['Hoje', 'Ontem', 'Mais antigas']);
  await expect(page.locator('.notif-row.unread')).toHaveCount(1);
  await expect(page.locator('.notif-row.unread')).toContainText('Seu pedido de oração está no mural');
  await expect(page.locator('.notif-row').nth(1).locator('.notif-icon')).toHaveClass(/k-agenda/);
  await expect(page.getByRole('button', { name: 'Apagar as lidas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ver mais' })).toBeHidden();
});

test('a líder marca o local do evento no mapa, e o membro vê o mapa e a rota', async ({ page, browser }) => {
  // A busca de endereço responde sempre o mesmo ponto (o serviço de verdade fica fora do teste).
  await page.route('https://nominatim.openstreetmap.org/**', (r) =>
    r.fulfill({ json: [{ lat: '-15.7942', lon: '-47.8822', display_name: 'Praça dos Três Poderes, Brasília' }] }),
  );
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/agenda/novo');
  await page.getByLabel('Título').fill(`Mapa ${tag}`);
  await page.getByLabel('Data').fill(tomorrow());
  await page.getByLabel('Começa').fill('19:00');
  await page.getByLabel('Local (opcional)').fill('Praça dos Três Poderes');
  await expect(page.getByText('Sem alfinete no mapa')).toBeVisible();
  await page.getByRole('button', { name: 'Marcar no mapa' }).click();
  const dialog = page.getByRole('dialog', { name: 'Marcar no mapa' });
  // Já busca o endereço digitado; com um resultado só, o alfinete vai para lá.
  await expect(dialog.locator('.map-pin')).toBeVisible();
  await dialog.getByRole('button', { name: 'Usar este ponto' }).click();
  await expect(page.getByText('📍 Local marcado no mapa')).toBeVisible();
  await page.getByRole('button', { name: 'Criar evento' }).click();
  await expect(page.getByRole('heading', { name: `Mapa ${tag}` })).toBeVisible();

  const member = await (await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' })).newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/agenda');
  await member.locator('.event-card', { hasText: `Mapa ${tag}` }).first().click();
  await expect(member.locator('.place-map .map-pin')).toBeVisible();
  await expect(member.getByRole('link', { name: 'Rota no Google Maps' })).toHaveAttribute('href', /destination=-15\.7942,-47\.8822$/);
  await expect(member.getByRole('link', { name: 'Ir com o Waze' })).toHaveAttribute('href', /ll=-15\.7942,-47\.8822&navigate=yes$/);
  await member.context().close();
});
