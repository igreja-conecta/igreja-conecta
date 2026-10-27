// Devocional e plano de leitura nas telas, com contas da igreja Teste A (Android).
// O devocional de hoje e o plano "Salmos e Provérbios" da Teste A são deste teste: começa
// apagando os que sobraram de uma rodada interrompida e apaga o que criou no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
let churchA;
const as = {};
const tag = `UI ${Date.now().toString(36)}`;
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

async function cleanUp() {
  const h = { headers: as['lider-a'].headers };
  await api.delete(rest(`devotionals?church_id=eq.${churchA}&publish_date=eq.${today}`), h);
  await api.delete(rest(`reading_plans?church_id=eq.${churchA}&plan_key=eq.salmos-proverbios`), h);
}

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['lider-a', 'membro-a']) as[u] = await loginAs(api, u);
  churchA = (await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: as['lider-a'].headers })).json())[0].id;
  await cleanUp();
});

test.afterAll(async () => {
  if (!api) return;
  await cleanUp();
  await api.dispose();
});

test('o líder escreve o devocional de hoje, com o versículo e o link da Bíblia', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Devocional', exact: true }).click();
  await page.getByRole('link', { name: 'Novo devocional' }).click();
  await expect(page.getByLabel('Dia em que aparece')).toHaveValue(today);
  await page.getByLabel('Título').fill(`Descanso em Deus ${tag}`);
  await page.getByLabel('Livro').selectOption({ label: 'Salmos' });
  await page.getByLabel('Capítulo').fill('200');
  await page.getByLabel('Mensagem').fill('O Senhor é o nosso pastor.');
  await page.getByRole('button', { name: 'Publicar devocional' }).click();
  await expect(page.getByText('Salmos tem 150 capítulos.')).toBeVisible();
  await page.getByLabel('Capítulo').fill('23');
  await page.getByLabel('Do versículo').fill('1');
  await page.getByLabel('Texto do versículo').fill('O Senhor é o meu pastor; nada me faltará.');
  await page.getByRole('button', { name: 'Publicar devocional' }).click();
  await expect(page.getByText('Devocional publicado.')).toBeVisible();
  await expect(page.getByRole('heading', { name: `Descanso em Deus ${tag}` })).toBeVisible();
  await expect(page.locator('blockquote.verse')).toContainText('Salmos 23:1');
  await expect(page.getByRole('link', { name: 'Ler na Bíblia' })).toHaveAttribute('href', /^https:\/\/www\.bible\.com\/bible\/\d+\/PSA\.23\.1\.[A-Z]+$/);
  await expect(page.getByRole('button', { name: 'Excluir' })).toBeVisible();
});

test('o membro vê o devocional no Início e toca em Amém; não escreve devocionais', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  const card = page.locator('#home-devotional');
  await expect(card).toContainText('Devocional de hoje');
  await expect(card).toContainText(tag);
  await card.getByRole('link', { name: 'Ler o devocional' }).click();
  await expect(page.getByRole('heading', { name: `Descanso em Deus ${tag}` })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Editar' })).toHaveCount(0);
  const amen = page.getByRole('button', { name: /Amém/ });
  await expect(amen).toHaveAttribute('aria-pressed', 'false');
  await amen.click();
  await expect(amen).toHaveAttribute('aria-pressed', 'true');
  await expect(amen).toHaveText('🙏 Amém · 1');
  await page.getByRole('link', { name: '← Devocional' }).click();
  await expect(page.getByRole('link', { name: 'Novo devocional' })).toHaveCount(0);
  await expect(page.locator('.devotional-today')).toContainText(tag);
});

test('o líder cria um plano de leitura; o membro entra, marca a leitura de hoje e vê o progresso', async ({ page, browser }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/leitura');
  await page.getByRole('link', { name: 'Novo plano' }).click();
  await page.getByLabel('Salmos e Provérbios em 31 dias').check();
  await expect(page.getByLabel('Data de início')).toHaveValue(today);
  await page.getByRole('button', { name: 'Criar plano' }).click();
  await expect(page.getByText('Plano criado. Os membros já podem entrar.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salmos e Provérbios em 31 dias' })).toBeVisible();
  await expect(page.getByLabel('Plano ativo')).toBeChecked();

  const member = await (await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' })).newPage();
  await watchCsp(member);
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/leitura');
  const plan = member.locator('section.reading-plan', { hasText: 'Salmos e Provérbios em 31 dias' });
  await expect(plan).toContainText('Dia 1 de 31');
  await expect(member.getByRole('link', { name: 'Novo plano' })).toHaveCount(0);
  await plan.getByRole('button', { name: 'Entrar no plano' }).click();
  await expect(member.getByText('Você entrou no plano. Boa leitura!')).toBeVisible();
  await expect(plan).toContainText('Leitura de hoje');
  await expect(plan.getByRole('link', { name: 'Salmos 1–4' })).toHaveAttribute('href', /PSA\.1\./);
  await expect(plan.getByRole('link', { name: 'Provérbios 1' })).toBeVisible();
  await plan.getByRole('button', { name: 'Marcar o dia 1 como lido' }).click();
  await expect(plan).toContainText('1 de 31 dias lidos (3%)');
  await expect(plan.getByRole('button', { name: 'Desmarcar o dia 1' })).toHaveAttribute('aria-pressed', 'true');

  // No Início, a leitura de hoje aparece como lida; dentro do plano, o lembrete pode ser desligado.
  await member.goto('/i/teste-a/#/');
  await expect(member.locator('#home-reading')).toContainText('Salmos 1–4; Provérbios 1');
  await expect(member.locator('#home-reading')).toContainText('lida ✓');
  await member.locator('#home-reading').getByRole('link', { name: /Salmos 1–4/ }).click();
  await member.getByLabel('Lembrete às 7h, se eu ainda não tiver lido').uncheck();
  await expect(member.getByText('Lembrete desligado.')).toBeVisible();
  expect(await cspViolations(member)).toEqual([]);
  await member.context().close();

  // A liderança vê só os números do plano.
  await page.reload();
  await expect(page.getByText('1 pessoa lendo').first()).toBeVisible();
  await expect(page.getByText('Progresso médio de quem está lendo: 3%.')).toBeVisible();
});
