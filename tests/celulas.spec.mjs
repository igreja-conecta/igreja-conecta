// Células nas telas, com contas da igreja Teste A (Android).
// O que o teste cria leva uma marca no nome e é apagado no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const tag = `UI ${Date.now().toString(36)}`;
const name = `Célula ${tag}`;

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
  await api.delete(rest(`cells?name=like.*${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  await api.dispose();
});

test('a líder cria a célula, coloca os participantes e escolhe o líder', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Células' }).click();
  await expect(page.getByRole('heading', { name: 'Membros sem célula', exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Nova célula' }).click();
  await page.getByLabel('Nome').fill(name);
  await page.getByLabel('Dia da semana').selectOption({ label: 'quarta' });
  await page.getByLabel('Horário').fill('19:30');
  await page.getByLabel('Local (opcional)').fill('Rua das Flores, 10');
  await page.getByRole('button', { name: 'Criar célula' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.locator('.page')).toContainText('Toda quarta-feira, às 19h30');

  for (const person of ['Membro da A', 'Fulano da A']) {
    await page.getByLabel('Colocar participante').fill(person.split(' ')[0]);
    await page.getByRole('button', { name: person }).click();
    await expect(page.locator('[data-member]', { hasText: person })).toBeVisible();
  }
  await page.getByLabel('Papel de Membro da A na célula').selectOption('lider');
  await expect(page.getByText('Papel na célula salvo.')).toBeVisible();
  // A líder da igreja vê o telefone de todos.
  await expect(page.locator('[data-member]', { hasText: 'Fulano da A' })).toContainText('(61) 99999-0001');
});

test('o membro que lidera a célula registra o encontro com a presença', async ({ page }) => {
  const [cell] = await (await api.get(rest(`cells?select=id&name=eq.${encodeURIComponent(name)}`), { headers: as['lider-a'].headers })).json();
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/menu');
  await expect(page.getByRole('link', { name: 'Minha célula' })).toBeVisible();
  await page.evaluate((id) => (location.hash = `/celulas/${id}`), cell.id);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0); // o papel na célula é escolhido pela liderança
  await page.getByRole('link', { name: 'Registrar encontro' }).click();
  await page.getByLabel('Tema (opcional)').fill('Estudo de Romanos 8');
  await page.getByLabel('Fulano da A').check();
  await expect(page.getByText('1 de 2 presentes')).toBeVisible();
  await page.getByLabel('Visitantes (quantos vieram)').fill('1');
  await page.getByRole('button', { name: 'Salvar encontro' }).click();
  await expect(page.getByText('Encontro salvo.')).toBeVisible();
  const card = page.locator('.event-card', { hasText: 'Estudo de Romanos 8' });
  await expect(card).toContainText('1 de 2 presentes · 1 visitante');
  // O próprio líder faltou: ainda é só 1 encontro, então não aparece aviso de faltas.
  await expect(page.getByText(/Faltou nos/)).toHaveCount(0);
});
