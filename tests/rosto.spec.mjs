// Cadastro do rosto e totem nas telas, com contas da igreja Teste A (Android).
// A câmera e o reconhecimento são de mentira (nenhum rosto de verdade nos testes): o fluxo,
// o termo, a autorização e o banco são de verdade. Um teste à parte carrega o face-api real.
// Usa o Admin da A e uma pessoa temporária: o Membro da A e o Fulano são dos testes do banco,
// que rodam ao mesmo tempo.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

const FACE_MODEL = 'face-api-1.7.15';
const tag = `UI ${Date.now().toString(36)}`;
let api;
const as = {};
const ids = {};
const rpc = (who, fn, data) => api.post(rest(`rpc/${fn}`), { headers: as[who].headers, data });
const descriptor = (k) => Array.from({ length: 128 }, (_, i) => Math.round((Math.sin(i * k) / 10) * 10000) / 10000);

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['adm-a', 'membro-a']) as[u] = await loginAs(api, u);
  const [church] = await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: as['adm-a'].headers })).json();
  [{ id: ids.adm }] = await (await api.get(rest(`members?select=id&user_id=eq.${as['adm-a'].id}`), { headers: as['adm-a'].headers })).json();
  const made = await api.post(rest('members'), {
    headers: { ...as['adm-a'].headers, Prefer: 'return=representation' },
    data: { church_id: church.id, name: `Pessoa ${tag}`, birth_date: '1990-05-20' },
  });
  [{ id: ids.pessoa }] = await made.json();
  ids.church = church.id;
  await rpc('adm-a', 'face_delete', { p_member: ids.adm });
});

test.afterAll(async () => {
  if (!api) return;
  await rpc('adm-a', 'face_delete', { p_member: ids.adm });
  await api.delete(rest(`members?id=eq.${ids.pessoa}`), { headers: as['adm-a'].headers });
  await api.delete(rest(`attendance_sessions?title=like.${encodeURIComponent(`Culto ${tag}`)}*`), { headers: as['adm-a'].headers });
  await api.dispose();
});

// Câmera (um quadro cinza) e reconhecimento de mentira: sempre "um rosto, perto e nítido",
// com a assinatura k; os olhos piscam a cada 6 leituras.
async function fakeFace(page, k) {
  await page.addInitScript((d) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 480, height: 640 });
      const g = canvas.getContext('2d');
      setInterval(() => {
        g.fillStyle = '#888';
        g.fillRect(0, 0, 480, 640);
      }, 100);
      return canvas.captureStream(10);
    };
    const box = { x: 0.3, y: 0.2, width: 0.4, height: 0.5 };
    let n = 0;
    window.__rostoFalso = {
      detect: async () => [{ descriptor: d, score: 0.95, box }],
      track: async () => [{ score: 0.95, box, eyes: ++n % 6 === 0 ? 0.1 : 0.3 }],
    };
  }, descriptor(k));
}

test('o administrador lê o termo, autoriza, cadastra e apaga o próprio rosto', async ({ page }) => {
  await fakeFace(page, 1);
  await openLoggedIn(page, as['adm-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Meu rosto (presença)' }).click();
  await expect(page.getByRole('heading', { name: 'Sem cadastro facial' })).toBeVisible();
  await page.getByRole('link', { name: 'Cadastrar meu rosto' }).click();
  await expect(page.locator('.face-term')).toContainText('Nenhuma foto é guardada nem enviada.');
  // Sem marcar as caixas, o navegador não deixa seguir.
  await page.getByRole('button', { name: 'Eu autorizo' }).click();
  await expect(page.locator('#face-camera')).toBeHidden();
  const adult = page.getByLabel('Tenho 18 anos ou mais.');
  if (await adult.count()) await adult.check();
  await page.getByLabel('Li e autorizo o cadastro do meu rosto para a presença nos cultos.').check();
  await page.getByRole('button', { name: 'Eu autorizo' }).click();
  await expect(page.locator('#face-step')).toHaveText(/Olhe para a câmera|Vire o rosto|Agora|Levante|Salvando/);
  await expect(page.getByText('Pronto: seu rosto foi cadastrado.')).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('heading', { name: '✓ Rosto cadastrado' })).toBeVisible();

  await page.getByRole('button', { name: 'Apagar meu cadastro facial' }).click();
  await answer(page);
  await expect(page.getByText('Cadastro facial apagado.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sem cadastro facial' })).toBeVisible();
});

test('a secretaria cadastra o rosto de quem não usa o app, com a pessoa autorizando', async ({ page }) => {
  await fakeFace(page, 2);
  await openLoggedIn(page, as['adm-a'].session, `/i/teste-a/#/membros/${ids.pessoa}`);
  await page.getByRole('link', { name: 'Rosto para a presença' }).click();
  await page.getByRole('link', { name: 'Cadastrar o rosto' }).click();
  await expect(page.locator('.notice')).toContainText('Entregue o aparelho a Pessoa');
  // Tem data de nascimento: não pergunta a idade.
  await expect(page.getByLabel('A pessoa tem 18 anos ou mais.')).toHaveCount(0);
  await page.getByLabel(`Eu, Pessoa ${tag}, li e autorizo o cadastro do meu rosto para a presença nos cultos.`).check();
  await page.getByRole('button', { name: 'Eu autorizo' }).click();
  await expect(page.getByText('Pronto: rosto cadastrado.')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.card')).toContainText('pela secretaria');
});

test('quem não é da secretaria não vê o cadastro de rosto dos outros', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, `/i/teste-a/#/membros/${ids.pessoa}/rosto`);
  await expect(page.getByRole('heading', { name: /Rosto de/ })).toHaveCount(0);
});

test('o totem reconhece, marca com o contador da câmera e "Não sou eu" desfaz', async ({ page }) => {
  const saved = await rpc('adm-a', 'face_save', {
    p_member: ids.adm, p_embedding: descriptor(3), p_samples: 5, p_model: FACE_MODEL, p_term_version: '2026-11-01', p_adult_confirmed: true,
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  ids.session = await (await rpc('adm-a', 'attendance_open', { p_church: ids.church, p_title: `Culto ${tag}`, p_date: today, p_event: null })).json();

  await fakeFace(page, 3);
  await openLoggedIn(page, as['adm-a'].session, `/i/teste-a/#/presenca/${ids.session}`);
  await page.getByRole('link', { name: 'Totem (reconhecimento facial)' }).click();
  await expect(page.locator('#totem-msg')).toHaveText('✓ Bom culto, Admin!', { timeout: 20000 });
  await expect(page.locator('.stat-tile', { hasText: 'Pela câmera' }).locator('.stat-value')).toHaveText('1');
  await page.getByRole('button', { name: 'Não sou Admin' }).click();
  await expect(page.locator('#totem-msg')).toContainText('Desfeito');
  await expect(page.locator('.stat-tile', { hasText: 'Pela câmera' }).locator('.stat-value')).toHaveText('0');

  await page.getByRole('link', { name: '← Lista de presença' }).click();
  await page.reload();
  await expect(page.locator('.notice')).toContainText('"Não sou eu" no totem');
});

test('o membro marcado pela câmera recebe o aviso e toca em "Não fui eu"', async ({ page }) => {
  const res = await rpc('adm-a', 'face_match', { p_session: ids.session, p_embedding: descriptor(3), p_model: FACE_MODEL });
  expect((await res.json())[0]).toMatchObject({ member_id: ids.adm, already: false });
  await openLoggedIn(page, as['adm-a'].session, '/i/teste-a/#/notificacoes');
  await page.getByText(`Presença marcada: Culto ${tag}`).first().click();
  await expect(page.locator('.card')).toContainText('pela câmera da entrada');
  await page.getByRole('button', { name: 'Não fui eu' }).click();
  await answer(page);
  await expect(page.getByText('Pronto: a presença foi desfeita e a equipe vai conferir.')).toBeVisible();
  await expect(page.getByText('Você não está marcado nesta lista de presença.')).toBeVisible();
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
    return [(await face.detect(canvas)).length, (await face.track(canvas)).length];
  });
  expect(found).toEqual([0, 0]);
});
