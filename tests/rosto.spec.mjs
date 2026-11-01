// Cadastro do rosto nas telas, com contas da igreja Teste A (Android).
// A câmera e o reconhecimento são de mentira (nenhum rosto de verdade nos testes): o fluxo,
// o termo, a autorização e o banco são de verdade. Um teste à parte carrega o face-api real.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const ids = {};
const rpc = (who, fn, data) => api.post(rest(`rpc/${fn}`), { headers: as[who].headers, data });

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['adm-a', 'membro-a']) as[u] = await loginAs(api, u);
  const people = await (await api.get(rest('members?select=id,name&name=in.("Membro da A","Fulano da A")'), { headers: as['adm-a'].headers })).json();
  ids.membro = people.find((p) => p.name === 'Membro da A').id;
  ids.fulano = people.find((p) => p.name === 'Fulano da A').id;
  for (const id of [ids.membro, ids.fulano]) await rpc('adm-a', 'face_delete', { p_member: id });
});

test.afterAll(async () => {
  if (!api) return;
  for (const id of [ids.membro, ids.fulano]) await rpc('adm-a', 'face_delete', { p_member: id });
  await api.dispose();
});

// Câmera (um quadro cinza) e reconhecimento de mentira: sempre "um rosto, perto e nítido".
async function fakeFace(page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 480, height: 640 });
      const g = canvas.getContext('2d');
      setInterval(() => {
        g.fillStyle = '#888';
        g.fillRect(0, 0, 480, 640);
      }, 100);
      return canvas.captureStream(10);
    };
    const descriptor = Array.from({ length: 128 }, (_, i) => Math.sin(i) / 10);
    window.__rostoFalso = { detect: async () => [{ descriptor, score: 0.95, box: { x: 0.3, y: 0.2, width: 0.4, height: 0.5 } }] };
  });
}

test('o membro lê o termo, autoriza, cadastra e apaga o próprio rosto', async ({ page }) => {
  await fakeFace(page);
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Meu rosto (presença)' }).click();
  await expect(page.getByRole('heading', { name: 'Sem cadastro facial' })).toBeVisible();
  await page.getByRole('link', { name: 'Cadastrar meu rosto' }).click();
  await expect(page.locator('.face-term')).toContainText('Nenhuma foto é guardada nem enviada.');
  // Sem marcar as caixas, o navegador não deixa seguir.
  await page.getByRole('button', { name: 'Eu autorizo' }).click();
  await expect(page.locator('#face-camera')).toBeHidden();
  await page.getByLabel('Tenho 18 anos ou mais.').check();
  await page.getByLabel('Li e autorizo o cadastro do meu rosto para a presença nos cultos.').check();
  await page.getByRole('button', { name: 'Eu autorizo' }).click();
  await expect(page.locator('#face-step')).toHaveText(/Olhe para a câmera|Vire o rosto/);
  await expect(page.getByText('Pronto: seu rosto foi cadastrado.')).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('heading', { name: '✓ Rosto cadastrado' })).toBeVisible();

  await page.getByRole('button', { name: 'Apagar meu cadastro facial' }).click();
  await answer(page);
  await expect(page.getByText('Cadastro facial apagado.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sem cadastro facial' })).toBeVisible();
});

test('a secretaria cadastra o rosto de quem não usa o app, com a pessoa autorizando', async ({ page }) => {
  await fakeFace(page);
  await openLoggedIn(page, as['adm-a'].session, `/i/teste-a/#/membros/${ids.fulano}`);
  await page.getByRole('link', { name: 'Rosto para a presença' }).click();
  await page.getByRole('link', { name: 'Cadastrar o rosto' }).click();
  await expect(page.locator('.notice')).toContainText('Entregue o aparelho a Fulano');
  // Fulano tem data de nascimento: não pergunta a idade.
  await expect(page.getByLabel('A pessoa tem 18 anos ou mais.')).toHaveCount(0);
  await page.getByLabel('Eu, Fulano da A, li e autorizo o cadastro do meu rosto para a presença nos cultos.').check();
  await page.getByRole('button', { name: 'Eu autorizo' }).click();
  await expect(page.getByText('Pronto: rosto cadastrado.')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.card')).toContainText('pela secretaria');
});

test('quem não é da secretaria não vê o cadastro de rosto dos outros', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, `/i/teste-a/#/membros/${ids.fulano}/rosto`);
  await expect(page.getByRole('heading', { name: /Rosto de/ })).toHaveCount(0);
});

test('o face-api de verdade carrega com a regra de segurança do app e não acha rosto num quadro vazio', async ({ page }) => {
  test.setTimeout(120000);
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await expect(page.locator('#tabbar')).toBeVisible();
  const found = await page.evaluate(async () => {
    const { loadFaceEngine } = await import(new URL('js/rosto.js', document.baseURI).href);
    const face = await loadFaceEngine();
    const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
    canvas.getContext('2d').fillRect(0, 0, 320, 240);
    Object.assign(canvas, { videoWidth: 320, videoHeight: 240 });
    return (await face.detect(canvas)).length;
  });
  expect(found).toBe(0);
});
