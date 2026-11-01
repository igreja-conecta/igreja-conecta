// Presença nos cultos nas telas, com contas da igreja Teste A (Android).
// A lista criada pelo teste leva uma marca no nome e é apagada no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const tag = `UI ${Date.now().toString(36)}`;
const title = `Culto ${tag}`;
let sessionUrl;

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
  await api.delete(rest(`attendance_sessions?title=like.${encodeURIComponent(title)}*`), { headers: as['lider-a'].headers });
  await api.dispose();
});

const tile = (page, label) => page.locator('.stat-tile', { hasText: label }).locator('.stat-value');

// Câmera de mentira: um quadro com o QR Code da carteirinha (desenhado pelo próprio app), no lugar
// da câmera do aparelho. Assim o leitor de verdade (jsQR ou o do navegador) lê o código.
async function fakeCamera(page, text) {
  await page.addInitScript((qrText) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const { qrImage } = await import(new URL('js/pix.js', document.baseURI).href);
      const img = await qrImage(qrText, 6);
      const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
      const g = canvas.getContext('2d');
      const paint = () => {
        g.fillStyle = '#fff';
        g.fillRect(0, 0, 640, 480);
        const size = 360;
        g.drawImage(img, (640 - size) / 2, (480 - size) / 2, size, size);
      };
      paint();
      setInterval(paint, 100);
      return canvas.captureStream(10);
    };
  }, text);
}

test('quem não é da equipe não vê a presença', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/menu');
  await expect(page.getByRole('link', { name: 'Meu cadastro' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Presença nos cultos' })).toHaveCount(0);
  await page.goto('/i/teste-a/#/presenca');
  await expect(page.locator('h1')).not.toHaveText('Presença nos cultos');
});

test('a liderança abre a lista pelo +, marca pelo nome e o contador mostra a forma', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Presença nos cultos' }).click();
  await page.getByRole('link', { name: 'Nova lista de presença' }).click();
  await page.getByLabel('Nome da lista').fill(title);
  await page.getByRole('button', { name: 'Abrir lista' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  sessionUrl = page.url();
  await expect(tile(page, 'Presentes')).toHaveText('0');

  await page.getByLabel('Buscar').fill('Fulano da A');
  const saved = page.waitForResponse((r) => r.url().includes('rpc/attendance_mark') && r.ok());
  await page.getByRole('button', { name: 'Marcar Fulano da A' }).click();
  await saved;
  await expect(tile(page, 'Pela lista')).toHaveText('1');
  await expect(tile(page, 'Presentes')).toHaveText('1');
  const row = page.locator('[data-person]', { hasText: 'Fulano da A' });
  await expect(row).toContainText('Presente');
  await expect(row).toContainText('Lista ·');

  // Ficou gravado: abrindo de novo, vem do banco igual.
  await page.reload();
  await expect(tile(page, 'Pela lista')).toHaveText('1');
  await page.getByRole('link', { name: /^Presentes/ }).click();
  await expect(page.locator('[data-person]')).toHaveCount(1);
  await expect(page.locator('[data-person]')).toContainText('Fulano da A');
});

test('o leitor lê o QR Code da carteirinha e marca a presença', async ({ page }) => {
  const [me] = await (await api.get(rest(`members?select=card_token&user_id=eq.${as['membro-a'].id}`), { headers: as['membro-a'].headers })).json();
  await fakeCamera(page, `https://igreja-conecta.github.io/igreja-conecta/i/teste-a/#/carteirinha/verificar/${me.card_token}`);
  await openLoggedIn(page, as['lider-a'].session, sessionUrl.replace(/^https?:\/\/[^/]+/, ''));
  await page.getByRole('link', { name: 'Ler QR Code da carteirinha' }).click();
  await expect(page.locator('#qr-result')).toHaveText('✓ Bom culto, Membro!', { timeout: 15000 });
  await expect(page.locator('#qr-recent')).toContainText('Membro da A');
  await page.getByRole('link', { name: '← Lista de presença' }).click();
  await expect(tile(page, 'Pelo QR Code')).toHaveText('1');
  await expect(tile(page, 'Presentes')).toHaveText('2');
});

test('sem permissão para a câmera, o leitor explica o que fazer', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    };
  });
  await openLoggedIn(page, as['lider-a'].session, `${sessionUrl.replace(/^https?:\/\/[^/]+/, '')}/qr`);
  await expect(page.locator('#qr-result')).toContainText('não tem permissão para usar a câmera');
});

test('as listas abrem na hora, mesmo com o banco demorando; o relatório mostra a presença', async ({ page }) => {
  const prefetched = page.waitForResponse(/attendance_sessions_list/);
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/');
  await prefetched;
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Presença nos cultos' }).click();
  await expect(page.locator('.member-row', { hasText: title })).toContainText('Câmera 0 · QR Code 1 · Lista 1', { timeout: 1000 });
  await page.unroute('**/rest/v1/**');

  await page.goto('/i/teste-a/#/relatorios');
  const section = page.locator('.report-section', { hasText: 'Presença nos cultos' });
  await expect(section).toContainText('Como a presença foi marcada');
  await expect(section).toContainText('Pelo QR Code da carteirinha');
});

test('a pastoral vê quem está faltando e marca "Vou procurar"', async ({ page }) => {
  const adm = await loginAs(api, 'adm-a');
  const rpc = (fn, data) => api.post(rest(`rpc/${fn}`), { headers: as['lider-a'].headers, data });
  const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const [{ id: church }] = await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: adm.headers })).json();
  const name = `Ausente ${tag}`;
  const made = await api.post(rest('members'), { headers: { ...adm.headers, Prefer: 'return=representation' }, data: { church_id: church, name } });
  const [{ id: member }] = await made.json();
  try {
    for (const [n, present] of [[-60, true], [-50, true], [-14, false], [-7, false], [0, false]]) {
      const session = await (await rpc('attendance_open', { p_church: church, p_title: `${title} ${n}`, p_date: day(n), p_event: null })).json();
      if (present) await rpc('attendance_mark', { p_session: session, p_member: member });
    }
    await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/presenca');
    await page.getByRole('link', { name: 'Quem está faltando' }).click();
    const row = page.locator('[data-absent]', { hasText: name });
    await expect(row).toContainText('há 7 semanas');
    await row.getByRole('button', { name: `Vou procurar ${name}` }).click();
    await expect(page.getByText('Anotado: você vai procurar.')).toBeVisible();
    await expect(page.locator('[data-absent]', { hasText: name })).toContainText('Acompanhando: Líder da A');
    // Membro comum não abre a lista.
    const other = await page.context().newPage();
    await openLoggedIn(other, as['membro-a'].session, '/i/teste-a/#/presenca/faltas');
    await expect(other.getByRole('heading', { name: 'Quem está faltando' })).toHaveCount(0);
  } finally {
    await api.delete(rest(`members?id=eq.${member}`), { headers: adm.headers });
  }
});
