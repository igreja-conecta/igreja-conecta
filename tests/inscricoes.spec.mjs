// Inscrição em eventos nas telas, com contas da igreja Teste A (Android).
// O que o teste cria leva uma marca no nome e é apagado no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const title = `Retiro UI ${Date.now().toString(36)}`;
// Daqui a 3 dias (aparece na Agenda e no Início), no horário de Brasília.
const day = new Date(Date.now() + 3 * 864e5).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

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
  await api.delete(rest(`events?title=eq.${encodeURIComponent(title)}`), { headers: as['lider-a'].headers });
  await api.dispose();
});

const eventId = async () =>
  (await (await api.get(rest(`events?select=id&title=eq.${encodeURIComponent(title)}`), { headers: as['lider-a'].headers })).json())[0].id;

test('a líder cria um evento com inscrição e 1 vaga', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/agenda/novo');
  await page.getByLabel('Título').fill(title);
  await page.getByLabel('Data', { exact: true }).fill(day);
  await page.getByLabel('Começa: hora').selectOption('19');
  // Evento que se repete não tem inscrição.
  await page.getByLabel('Repetir toda semana').check();
  await expect(page.getByText('Abrir inscrições')).toBeHidden();
  await page.getByLabel('Repetir toda semana').uncheck();
  await page.getByLabel('Abrir inscrições').check();
  await page.getByLabel('Vagas (em branco: sem limite)').fill('1');
  await expect(page.getByLabel('Lista de espera quando as vagas acabarem')).toBeChecked();
  await page.getByRole('button', { name: 'Criar evento' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.locator('#reg-box')).toContainText('Resta 1 vaga de 1.');
  await expect(page.locator('#reg-box').getByRole('link', { name: 'Ver inscritos (0)' })).toBeVisible();
});

test('o membro se inscreve e vê a etiqueta na Agenda', async ({ page }) => {
  const id = await eventId();
  await openLoggedIn(page, as['membro-a'].session, `/i/teste-a/#/agenda/${id}`);
  const box = page.locator('#reg-box');
  await box.getByRole('button', { name: 'Quero me inscrever' }).click();
  await expect(box).toContainText('Você está inscrito.');
  await expect(box).toContainText('Vagas esgotadas (1).');
  await expect(box.getByRole('link', { name: /Ver inscritos/ })).toHaveCount(0); // só a liderança vê a lista
  await page.locator('#tabbar').getByRole('link', { name: 'Agenda' }).click();
  await expect(page.locator('.event-card', { hasText: title })).toContainText('Inscrito');
});

test('com as vagas esgotadas, a líder entra na lista de espera e vê os inscritos', async ({ page }) => {
  const id = await eventId();
  await openLoggedIn(page, as['lider-a'].session, `/i/teste-a/#/agenda/${id}`);
  const box = page.locator('#reg-box');
  await box.getByRole('button', { name: 'Entrar na lista de espera' }).click();
  await expect(box).toContainText('lista de espera: posição 1');
  await box.getByRole('link', { name: 'Ver inscritos (1 + 1 na espera)' }).click();
  await expect(page.getByRole('heading', { name: 'Confirmados (1 de 1)' })).toBeVisible();
  await expect(page.locator('[data-reg-id]').first()).toContainText('Membro da A');
  await expect(page.getByRole('heading', { name: 'Lista de espera (1)' })).toBeVisible();
  await expect(page.locator('[data-reg-id]').nth(1)).toContainText('Líder da A');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Baixar planilha' }).click();
  expect((await download).suggestedFilename()).toMatch(/^inscritos-retiro-ui-.*\.csv$/);
});

test('o membro cancela e a vaga passa sozinha para a fila', async ({ page }) => {
  const id = await eventId();
  await openLoggedIn(page, as['membro-a'].session, `/i/teste-a/#/agenda/${id}`);
  const box = page.locator('#reg-box');
  await box.getByRole('button', { name: 'Cancelar minha inscrição' }).click();
  await answer(page);
  await expect(page.getByText('Inscrição cancelada.')).toBeVisible();
  // A vaga foi para a líder (primeira da fila): para o membro, continua esgotado.
  await expect(box).toContainText('Vagas esgotadas (1).');
  await expect(box.getByRole('button', { name: 'Entrar na lista de espera' })).toBeVisible();
  const notes = await (
    await api.get(rest(`notifications?select=title&title=eq.${encodeURIComponent(`Abriu uma vaga: ${title}`)}`), { headers: as['lider-a'].headers })
  ).json();
  expect(notes).toHaveLength(1);
});

test('a Agenda e o evento abrem na hora, com a inscrição já desenhada', async ({ page }) => {
  // O Início já busca a Agenda, os eventos e as inscrições em segundo plano.
  const prefetched = page.waitForResponse(/rpc\/event_registration_summary/);
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await prefetched;
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  const fast = { timeout: 1000 };
  await page.locator('#tabbar').getByRole('link', { name: 'Agenda' }).click();
  await page.locator('.event-card', { hasText: title }).click();
  await expect(page.locator('#reg-box')).toContainText('Vagas esgotadas (1).', fast);
});
