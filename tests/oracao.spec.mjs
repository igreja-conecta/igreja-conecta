// Pedidos de oração nas telas, com contas da igreja Teste A (Android).
// O que o teste cria leva uma marca no texto e é apagado no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const tag = `UI ${Date.now().toString(36)}`;

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
  await api.delete(rest(`prayer_requests?body=like.*${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  await api.dispose();
});

test('o membro pede oração para a igreja, sem o nome, e acompanha em "Meus pedidos"', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Pedidos de oração' }).click();
  await expect(page.getByRole('link', { name: 'Moderação' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Fazer um pedido' }).click();
  await page.getByLabel('Seu pedido').fill(`Pela saúde da minha mãe ${tag}`);
  await expect(page.getByLabel('Não mostrar meu nome')).toBeHidden();
  await page.getByLabel('Para a igreja orar junto').check();
  await page.getByLabel('Não mostrar meu nome').check();
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(page.getByText('Pedido enviado. Ele vai para o mural depois da aprovação.')).toBeVisible();
  const card = page.locator('article.prayer', { hasText: tag });
  await expect(card).toContainText('Aguardando aprovação');
  await expect(card).toContainText('Anônimo');
});

test('o líder corrige e aprova; o pedido vai para o mural e o membro ora junto', async ({ page, browser }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Moderar pedidos de oração' }).click();
  const card = page.locator('article.prayer', { hasText: 'Membro da A' }).filter({ has: page.locator('textarea', { hasText: tag }) });
  await expect(card).toContainText('Anônimo para os membros');
  await card.locator('textarea').fill(`Pela saúde da mãe (corrigido) ${tag}`);
  await card.getByRole('button', { name: 'Aprovar' }).click();
  await expect(page.getByText('Pedido aprovado: já está no mural.')).toBeVisible();
  await page.getByRole('link', { name: 'Mural', exact: true }).click();
  // A liderança vê o nome mesmo no pedido anônimo.
  await expect(page.locator('article.prayer', { hasText: tag })).toContainText('Membro da A (anônimo para os membros)');

  const member = await (await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' })).newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/oracao');
  const mine = member.locator('article.prayer', { hasText: tag });
  await expect(mine).toContainText('(corrigido)');
  await mine.getByRole('button', { name: /Vou orar/ }).click();
  await expect(mine.getByRole('button', { name: 'Estou orando · 1' })).toBeVisible();
  await member.getByRole('link', { name: 'Meus pedidos' }).click();
  const tracked = member.locator('article.prayer', { hasText: tag });
  await expect(tracked).toContainText('No mural');
  await tracked.getByRole('button', { name: 'Deus respondeu 🙌' }).click();
  await expect(tracked.locator('.tag', { hasText: 'Deus respondeu' })).toBeVisible();
  await member.context().close();
});

test('o pedido só para os pastores aparece na moderação, na aba própria', async ({ page }) => {
  const res = await api.post(rest('prayer_requests'), {
    headers: as['membro-a'].headers,
    data: { church_id: (await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: as['membro-a'].headers })).json())[0].id, body: `Privado ${tag}`, audience: 'pastores' },
  });
  expect(res.ok(), await res.text()).toBe(true);
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/oracao/moderar?ver=privado');
  const card = page.locator('article.prayer', { hasText: `Privado ${tag}` });
  await card.getByRole('button', { name: 'Já orei / já entrei em contato' }).click();
  await expect(page.locator('article.prayer', { hasText: `Privado ${tag}` })).toContainText('Já cuidado');
});
