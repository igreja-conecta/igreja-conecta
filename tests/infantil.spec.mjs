// Check-in do ministério infantil nas telas, com contas da igreja Teste A (Android).
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
const kid = `Ana ${tag}`;
const room = `Sala ${tag}`;
const birth = `${new Date().getFullYear() - 6}-03-10`;
let code;

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
  await api.delete(rest(`children?name=eq.${encodeURIComponent(kid)}`), { headers: as['lider-a'].headers });
  await api.delete(rest(`kids_rooms?name=eq.${encodeURIComponent(room)}`), { headers: as['lider-a'].headers });
  await api.dispose();
});

const notes = async (who, title) =>
  (await api.get(rest(`notifications?select=title,body&title=eq.${encodeURIComponent(title)}`), { headers: as[who].headers })).json();

test('o responsável cadastra o filho com as alergias', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Meus filhos' }).click();
  await page.getByRole('link', { name: 'Cadastrar filho' }).click();
  await page.getByLabel('Nome da criança').fill(kid);
  await page.getByLabel('Data de nascimento').fill(birth);
  await page.getByLabel('Alergias e cuidados (opcional)').fill('Alergia a amendoim');
  // Sem a autorização, o navegador não deixa enviar.
  await page.getByRole('button', { name: 'Cadastrar' }).click();
  await expect(page.getByRole('heading', { name: 'Cadastrar filho' })).toBeVisible();
  await page.getByLabel('Autorizo a igreja a guardar estes dados do meu filho para o check-in do infantil.').check();
  await page.getByRole('button', { name: 'Cadastrar' }).click();
  await expect(page.getByText('Criança cadastrada.')).toBeVisible();
  const card = page.locator('.kid-card', { hasText: kid });
  await expect(card).toContainText('6 anos · ⚠️ Alergia a amendoim');
});

test('a liderança cria a sala, faz a entrada e imprime a etiqueta com o código', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Check-in infantil' }).click();
  await page.getByRole('link', { name: 'Salas', exact: true }).click();
  await page.getByLabel('Nome').fill(room);
  await page.getByLabel('Idade de').selectOption('0');
  await page.getByLabel('até').selectOption('12');
  await page.getByRole('button', { name: 'Criar sala' }).click();
  await expect(page.getByText('Sala criada.')).toBeVisible();
  await expect(page.locator('.member-row', { hasText: room })).toContainText('0 a 12 anos');

  await page.getByRole('link', { name: '← Check-in infantil' }).click();
  await page.getByLabel('Buscar').fill(tag);
  const row = page.locator('[data-kid]', { hasText: kid });
  await expect(row).toContainText('resp.: Membro da A');
  await row.getByRole('link', { name: 'Entrada' }).click();
  await expect(page.locator('.kid-warning')).toContainText('Alergia a amendoim');
  await page.getByLabel('Sala').selectOption(room);
  await page.getByRole('button', { name: 'Confirmar entrada' }).click();
  await expect(page.getByRole('heading', { name: 'Entrada confirmada' })).toBeVisible();
  code = (await page.locator('p.kid-code').textContent()).trim();
  expect(code).toMatch(/^[A-Z0-9]{4}$/);
  // Duas etiquetas: a da criança (com o alerta) e a do responsável, as duas com o código.
  await expect(page.locator('.kid-label')).toHaveCount(2);
  await expect(page.locator('.kid-label').first()).toContainText('⚠️ Alergia a amendoim');
  await expect(page.locator('.kid-label').nth(1)).toContainText(code);
  await page.getByRole('link', { name: 'Próxima criança' }).click();
  await expect(page.locator('.card', { hasText: room })).toContainText(kid);
});

test('o responsável vê o código no Início e em Meus filhos', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await expect(page.locator('#home-kids')).toContainText(code);
  await page.locator('#home-kids').getByRole('link').first().click();
  const card = page.locator('.kid-card', { hasText: kid });
  await expect(card.locator('.kid-code')).toHaveText(code);
  await expect(card).toContainText(`No infantil (${room})`);
  expect((await notes('membro-a', `Ana entrou no ${room}`))[0].body).toContain(code);
});

test('a retirada só sai com o código certo', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/infantil/retirada');
  const wrong = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
  await page.getByLabel('Código de retirada').fill(wrong.toLowerCase());
  await expect(page.getByLabel('Código de retirada')).toHaveValue(wrong);
  await page.getByRole('button', { name: 'Conferir código' }).click();
  await expect(page.getByText('Nenhuma criança no infantil com esse código hoje.')).toBeVisible();
  await page.getByLabel('Código de retirada').fill(code);
  await page.getByRole('button', { name: 'Conferir código' }).click();
  await expect(page.locator('#found')).toContainText(kid);
  await expect(page.locator('#found')).toContainText('Responsável: Membro da A');
  await page.getByRole('button', { name: 'Confirmar retirada' }).click();
  await expect(page.getByText('Ana foi retirado.')).toBeVisible();
  await expect(page.locator('[data-kid]', { hasText: kid })).toContainText('Retirado');
  expect(await notes('membro-a', 'Ana foi retirado')).not.toHaveLength(0);
});

test('Meus filhos abre na hora, mesmo com o banco demorando', async ({ page }) => {
  const prefetched = page.waitForResponse(/kids_checkins/);
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await prefetched;
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Meus filhos' }).click();
  await expect(page.locator('.kid-card', { hasText: kid })).toContainText('Retirado às', { timeout: 1000 });
});
