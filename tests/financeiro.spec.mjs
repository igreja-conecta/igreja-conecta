// Financeiro da tesouraria na igreja Teste A: o administrador lança entrada, saída e transferência,
// vê os totais, edita e apaga arrastando, com Desfazer; fecha e publica um mês antigo e o membro vê
// só os totais na Prestação de contas. Quem não é da tesouraria não vê o Financeiro.
// Os lançamentos do teste levam a marca "UI fin" na descrição e ficam marcados como apagados no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
let admin;
let membro;
let church;
const TAG = `UI fin ${Date.now().toString(36)}`;
// Mês antigo só deste teste: fechar e publicar não mexe nos meses de verdade.
const MONTH = '2002-03';
const reopen = () => api.post(rest('rpc/finance_reopen_month'), { headers: admin.headers, data: { p_church: church, p_month: `${MONTH}-01` } });

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  admin = await loginAs(api, 'adm-a');
  membro = await loginAs(api, 'membro-a');
  [{ id: church }] = await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: admin.headers })).json();
  await reopen(); // se uma rodada parou no meio, o mês ficou fechado
});

test.afterAll(async () => {
  if (!api) return;
  if (church) await reopen();
  await api.patch(rest(`fin_entries?description=like.${encodeURIComponent(TAG)}*`), {
    headers: admin.headers,
    data: { deleted_at: new Date().toISOString() },
  });
  await api.dispose();
});

// "R$ 1.234,56" → 123456
const cents = (text) => Math.round(Number(text.replace(/[^\d,-]/g, '').replace(',', '.')) * 100);

test('a tesouraria lança, vê os totais, edita e apaga arrastando, com Desfazer', async ({ page }) => {
  await openLoggedIn(page, admin.session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Financeiro' }).click();
  await expect(page.getByRole('heading', { name: 'Financeiro' })).toBeVisible();
  const tile = (label) => page.locator('.stat-tile', { hasText: label }).locator('strong');
  await expect(tile('Entradas')).toContainText('R$');
  const inBefore = cents(await tile('Entradas').innerText());
  const outBefore = cents(await tile('Saídas').innerText());

  // Entrada (o tipo que já vem marcado).
  await page.getByRole('link', { name: 'Novo lançamento' }).click();
  await expect(page.getByRole('heading', { name: 'Novo lançamento' })).toBeVisible();
  await page.getByLabel('Valor (R$)').fill('1.234,56');
  await page.getByLabel('Categoria').selectOption({ label: 'Ofertas' });
  await page.getByLabel('Descrição (opcional)').fill(`${TAG} entrada`);
  await page.getByRole('button', { name: 'Lançar' }).click();
  await expect(page.locator('#toast')).toContainText('Lançamento feito.');
  const entrada = page.locator('.fin-row', { hasText: `${TAG} entrada` });
  await expect(entrada).toContainText(/\+ R\$\s1\.234,56/);
  await expect.poll(async () => cents(await tile('Entradas').innerText())).toBe(inBefore + 123456);

  // Saída: as categorias mudam para as de saída.
  await page.getByRole('link', { name: 'Novo lançamento' }).click();
  await page.getByLabel('Saída').check();
  await expect(page.getByLabel('Categoria').locator('option', { hasText: 'Aluguel' })).toHaveCount(1);
  await expect(page.getByLabel('Categoria').locator('option', { hasText: 'Dízimos' })).toHaveCount(0);
  await page.getByLabel('Valor (R$)').fill('50');
  await page.getByLabel('Categoria').selectOption({ label: 'Aluguel' });
  await page.getByLabel('Descrição (opcional)').fill(`${TAG} saída`);
  await page.getByRole('button', { name: 'Lançar' }).click();
  const saida = page.locator('.swipe', { hasText: `${TAG} saída` });
  await expect(saida).toContainText(/− R\$\s50,00/);
  await expect.poll(async () => cents(await tile('Saídas').innerText())).toBe(outBefore + 5000);

  // Transferência: escolhe as duas contas e não tem categoria; não entra nas entradas nem nas saídas.
  await page.getByRole('link', { name: 'Novo lançamento' }).click();
  await page.getByLabel('Transferência').check();
  await expect(page.getByLabel('Categoria')).toBeHidden();
  await expect(page.getByLabel('Para a conta')).toBeVisible();
  await page.getByLabel('Valor (R$)').fill('10');
  await page.getByLabel('Descrição (opcional)').fill(`${TAG} transferência`);
  await page.getByRole('button', { name: 'Lançar' }).click();
  await expect(page.locator('.fin-row', { hasText: `${TAG} transferência` })).toContainText('Caixa → Banco');
  expect(cents(await tile('Entradas').innerText())).toBe(inBefore + 123456);

  // Editar: o valor vem preenchido.
  await entrada.click();
  await expect(page.getByRole('heading', { name: 'Lançamento', exact: true })).toBeVisible();
  await expect(page.getByLabel('Valor (R$)')).toHaveValue('1.234,56');
  await page.getByLabel('Valor (R$)').fill('1.000');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(entrada).toContainText(/\+ R\$\s1\.000,00/);

  // Arrastar para a esquerda apaga, com Desfazer.
  await expect(page.getByText('Arraste um lançamento para a esquerda para apagar.')).toBeVisible();
  const box = await saida.locator('.fin-row').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.9, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('#toast')).toContainText('Lançamento apagado.');
  await expect(saida).toHaveCount(0);
  await expect.poll(async () => cents(await tile('Saídas').innerText())).toBe(outBefore);
  await page.getByRole('button', { name: 'Desfazer' }).click();
  await expect(saida).toBeVisible();
  await expect.poll(async () => cents(await tile('Saídas').innerText())).toBe(outBefore + 5000);

  // Contas e categorias.
  await page.getByRole('link', { name: 'Contas e categorias' }).click();
  await expect(page.getByRole('heading', { name: 'Contas e categorias' })).toBeVisible();
  await expect(page.locator('.fin-config-row', { hasText: 'Caixa' })).toBeVisible();
  await expect(page.locator('.fin-config-row', { hasText: 'Dízimos' })).toBeVisible();
});

test('a tesouraria fecha e publica o mês; o membro vê só os totais; reabrir tira da prestação', async ({ page, browser }) => {
  await openLoggedIn(page, admin.session, `/i/teste-a/#/financeiro?mes=${MONTH}`);
  await expect(page.locator('.month-nav')).toContainText('março de 2002');
  const add = async (kind, value, category, text) => {
    await page.getByRole('link', { name: 'Novo lançamento' }).click();
    await page.getByLabel(kind).check();
    await expect(page.getByLabel('Data')).toHaveValue(`${MONTH}-31`); // mês passado: o último dia
    await page.getByLabel('Valor (R$)').fill(value);
    await page.getByLabel('Categoria').selectOption({ label: category });
    await page.getByLabel('Descrição (opcional)').fill(`${TAG} ${text}`);
    await page.getByRole('button', { name: 'Lançar' }).click();
    await expect(page.locator('.fin-row', { hasText: `${TAG} ${text}` })).toBeVisible();
  };
  await add('Entrada', '300', 'Dízimos', 'dízimo');
  await add('Saída', '100', 'Aluguel', 'aluguel');

  // Prévia: só a tesouraria vê, antes de publicar.
  await page.getByRole('link', { name: 'Prévia' }).click();
  await expect(page.getByText('Prévia: este mês ainda não foi publicado.')).toBeVisible();
  await page.goBack();

  // Fechar e publicar, com recado: os lançamentos travam.
  await page.getByRole('button', { name: 'Fechar e publicar o mês' }).click();
  await answer(page, `Recado ${TAG}`);
  await expect(page.locator('#toast')).toContainText('Mês fechado e publicado.');
  await expect(page.getByRole('button', { name: 'Reabrir o mês' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Novo lançamento' })).toHaveCount(0);
  await expect(page.locator('.swipe')).toHaveCount(0);

  // O membro vê o mês publicado, com os totais por categoria e o recado, sem os lançamentos.
  const member = await (await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' })).newPage();
  await openLoggedIn(member, membro.session, '/i/teste-a/#/menu');
  await member.getByRole('link', { name: 'Prestação de contas' }).click();
  await member.getByRole('link', { name: /março de 2002/ }).click();
  await expect(member.getByRole('heading', { name: /março de 2002/ })).toBeVisible();
  await expect(member.locator('.page')).toContainText(`Recado ${TAG}`);
  await expect(member.locator('.fin-balances div', { hasText: 'Dízimos' })).toContainText(/R\$\s300,00/);
  await expect(member.locator('.fin-balances div', { hasText: 'Aluguel' })).toContainText(/R\$\s100,00/);
  await expect(member.locator('.page')).not.toContainText(`${TAG} dízimo`);
  await expect(member.getByRole('button', { name: 'Imprimir' })).toBeVisible();

  // Reaberto: volta a aceitar lançamentos e sai da prestação de contas.
  await page.getByRole('button', { name: 'Reabrir o mês' }).click();
  await answer(page);
  await expect(page.locator('#toast')).toContainText('Mês reaberto.');
  await expect(page.getByRole('link', { name: 'Novo lançamento' })).toBeVisible();
  await member.reload();
  await expect(member.getByRole('heading', { name: 'Prestação de contas não publicada' })).toBeVisible();
  await member.context().close();
});

test('quem não é da tesouraria não vê o Financeiro', async ({ page }) => {
  await openLoggedIn(page, membro.session, '/i/teste-a/#/menu');
  await expect(page.getByRole('link', { name: 'Meu cadastro' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Financeiro' })).toHaveCount(0);
  await page.goto('/i/teste-a/#/financeiro');
  await expect(page.getByRole('heading', { name: 'Só para a tesouraria' })).toBeVisible();
});
