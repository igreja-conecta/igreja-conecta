// Ministérios e escalas nas telas, com contas da igreja Teste A (Android).
// O que o teste cria leva uma marca no nome e é apagado no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const tag = `UI ${Date.now().toString(36)}`;
const name = `Louvor ${tag}`;

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
  await api.delete(rest(`ministries?name=like.*${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  await api.dispose();
});

const ministryId = async () =>
  (await (await api.get(rest(`ministries?select=id&name=eq.${encodeURIComponent(name)}`), { headers: as['lider-a'].headers })).json())[0].id;

test('a líder cria o ministério, monta a equipe e a primeira escala', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Ministérios e escalas' }).click();
  // A liderança cria pelo botão redondo "+".
  await expect(page.locator('.fab')).toHaveAttribute('href', '#/ministerios/novo');
  await page.getByRole('link', { name: 'Novo ministério' }).click();
  // A sugestão preenche nome e descrição; o nome leva a marca do teste.
  await page.getByRole('button', { name: 'Louvor' }).click();
  await expect(page.getByLabel('Descrição (opcional)')).toHaveValue(/Música/);
  await page.getByLabel('Nome').fill(name);
  await page.getByRole('button', { name: 'Criar ministério' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();

  for (const person of ['Membro da A', 'Fulano da A']) {
    await page.getByLabel('Colocar na equipe').fill(person.split(' ')[0]);
    await page.getByRole('button', { name: person }).click();
    await expect(page.locator('[data-member]', { hasText: person })).toBeVisible();
  }

  await page.getByRole('link', { name: 'Nova escala' }).click();
  await page.getByLabel('Horário: hora').selectOption('19');
  await page.getByLabel('Horário: minutos').selectOption('00');
  await page.getByLabel('Culto ou evento (opcional)').fill('Culto de domingo');
  await page.getByLabel('Função de Membro da A').fill('Vocal'); // escrever a função já marca a pessoa
  await page.getByLabel('Função de Fulano da A').fill('Teclado');
  await expect(page.getByText('2 pessoas escaladas')).toBeVisible();
  await page.getByRole('button', { name: 'Criar escala' }).click();
  await expect(page.getByText('Escala criada.')).toBeVisible();
  const card = page.locator('.card.schedule', { hasText: 'Culto de domingo' });
  await expect(card).toContainText('às 19h');
  await expect(card.locator('li', { hasText: 'Membro da A' })).toContainText('Falta confirmar');
  // Quem não tem o app não recebe aviso: o líder fica sabendo.
  await expect(card.locator('li', { hasText: 'Fulano da A' })).toContainText('Sem o app');
});

test('o voluntário vê a escala no Início, confirma e depois pede troca', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await expect(page.locator('#home-schedules')).toContainText(`${name} · Vocal`);
  await page.locator('#home-schedules').getByRole('link').first().click();
  const mine = page.locator('.schedule-mine', { hasText: name });
  await expect(mine).toContainText('Falta confirmar');
  await expect(page.getByRole('link', { name: 'Novo ministério' })).toHaveCount(0);
  await expect(page.locator('.fab')).toHaveCount(0);
  await mine.getByRole('button', { name: 'Confirmo' }).click();
  await expect(mine).toContainText('Confirmado');
  await mine.getByRole('button', { name: 'Pedir troca' }).click();
  await answer(page, 'Viagem');
  await expect(mine).toContainText('Pediu troca');
  await expect(mine).toContainText('Motivo: Viagem');
  // Continua assim ao abrir de novo (veio do banco).
  await page.reload();
  await expect(page.locator('.schedule-mine', { hasText: name })).toContainText('Pediu troca');
  // A equipe vê a escala completa, mas não monta escalas.
  await page.locator('.schedule-mine', { hasText: name }).getByRole('link', { name: 'Ver a escala' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.locator('.card.schedule li', { hasText: 'Fulano da A' })).toContainText('Teclado');
  await expect(page.getByRole('link', { name: 'Nova escala' })).toHaveCount(0);
});

test('a líder vê o pedido de troca e passa a liderança do ministério para o membro', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/escalas');
  await page.getByRole('link', { name: `1 pedido de troca em ${name}.`, exact: false }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const slot = page.locator('.card.schedule li', { hasText: 'Membro da A' });
  await expect(slot).toContainText('Pediu troca');
  await expect(slot).toContainText('Motivo: Viagem');
  await page.getByLabel('Papel de Membro da A no ministério').selectOption('lider');
  await expect(page.getByText('Papel no ministério salvo.')).toBeVisible();
});

test('o membro que lidera o ministério monta uma escala', async ({ page }) => {
  const id = await ministryId();
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await page.evaluate((x) => (location.hash = `/ministerios/${x}`), id);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0); // quem lidera o ministério é escolhido pela liderança
  await page.getByRole('link', { name: 'Nova escala' }).click();
  await page.getByLabel('Culto ou evento (opcional)').fill('Ensaio');
  await page.getByLabel('Função de Fulano da A').fill('Som');
  await expect(page.getByText('1 pessoa escalada')).toBeVisible();
  await page.getByRole('button', { name: 'Criar escala' }).click();
  await expect(page.getByText('Escala criada.')).toBeVisible();
  await expect(page.locator('.card.schedule', { hasText: 'Ensaio' })).toContainText('Som');
});

test('Escalas e o ministério abrem na hora, mesmo com o banco demorando', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  // O Início já busca as escalas e os ministérios da pessoa em segundo plano.
  await expect(page.locator('#home-schedules')).toContainText(name);
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  const fast = { timeout: 1000 };
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Ministérios e escalas' }).click();
  const mine = page.locator('.schedule-mine', { hasText: name });
  await expect(mine).toContainText('Vocal', fast);
  await mine.getByRole('link', { name: 'Ver a escala' }).click();
  await expect(page.locator('.card.schedule', { hasText: 'Ensaio' })).toBeVisible(fast);
});
