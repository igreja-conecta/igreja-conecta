// Telas de aniversário com contas de teste da igreja Teste A (Android).
import { test, expect } from '@playwright/test';
import { configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

const accounts = {};

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  const api = await playwright.request.newContext();
  for (const u of ['membro-a', 'lider-a', 'adm-a']) accounts[u] = await loginAs(api, u);
  await api.dispose();
});

test('o membro vê no mês só quem autorizou mostrar o aniversário', async ({ page }) => {
  await openLoggedIn(page, accounts['membro-a'].session, '/i/teste-a/#/aniversariantes?mes=2027-02');
  await expect(page.getByRole('heading', { name: 'Aniversariantes de fevereiro' })).toBeVisible();
  const day = page.locator('.bday-day', { hasText: 'Bissexto da A' });
  await expect(day.locator('.bday-date strong')).toHaveText('28');
  await expect(day).not.toContainText('anos');
  await page.evaluate(() => (location.hash = '/aniversariantes?mes=2027-03'));
  await expect(page.getByRole('heading', { name: 'Aniversariantes de março' })).toBeVisible();
  await expect(page.getByText('Nenhum aniversariante em março.')).toBeVisible();
});

test('a liderança vê todos, com a idade, e pode imprimir', async ({ page }) => {
  await openLoggedIn(page, accounts['lider-a'].session, '/i/teste-a/#/aniversariantes?mes=2027-03');
  await expect(page.locator('.bday-day', { hasText: 'Fulano da A' })).toContainText('faz 47 anos');
  await page.getByRole('link', { name: 'Próximo mês' }).click();
  await expect(page.getByRole('heading', { name: 'Aniversariantes de abril' })).toBeVisible();
  // Imprimir fica no botão redondo (com o ícone da impressora, não o "+").
  // O botão mostra primeiro a folha na tela (prévia), com o mês que estava aberto.
  await page.locator('.fab#print').click();
  await expect(page).toHaveURL(/#\/aniversariantes\/imprimir\?mes=2027-04$/);
  await expect(page.getByRole('heading', { name: 'Aniversariantes de abril de 2027' })).toBeVisible();
  await expect(page.locator('.sheet .sheet-church')).toHaveText('Igreja Teste A');
  await expect(page.locator('.sheet-foot')).toContainText('Gerado pelo app da Igreja Teste A');
  await expect(page.locator('.sheet-signs')).toHaveCount(0);
  // Na impressão sai só a folha: o voltar e o botão somem.
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.sheet-foot')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Imprimir ou salvar PDF' })).toBeHidden();
  await expect(page.getByRole('link', { name: '← Aniversariantes' })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('link', { name: '← Aniversariantes' }).click();
  await expect(page.getByRole('heading', { name: 'Aniversariantes de abril' })).toBeVisible();

  // A folha de março traz as pessoas, sem fotos.
  await page.evaluate(() => (location.hash = '/aniversariantes/imprimir?mes=2027-03'));
  await expect(page.locator('.sheet-bday', { hasText: 'Fulano da A' })).toContainText('faz 47 anos');
  await expect(page.locator('.sheet .avatar')).toHaveCount(0);
});

test('o admin vê a prévia da mensagem com os campos trocados', async ({ page }) => {
  await openLoggedIn(page, accounts['adm-a'].session, '/i/teste-a/#/config/aniversario');
  await page.getByLabel('Título', { exact: true }).fill('Parabéns, ');
  await page.getByRole('button', { name: '{primeiro_nome}' }).click();
  await expect(page.locator('#pv-title')).toHaveText('Parabéns, Admin');
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('{igreja} deseja feliz {idade} anos!');
  await expect(page.locator('#pv-body')).toHaveText('Igreja Teste A deseja feliz 30 anos!');
  // Emoji entra onde está o cursor (aqui, no fim da mensagem).
  await page.getByRole('button', { name: 'Colocar 🎂' }).click();
  await expect(page.locator('#pv-body')).toHaveText('Igreja Teste A deseja feliz 30 anos!🎂');
  await page.getByLabel('Título', { exact: true }).focus();
  await page.getByRole('button', { name: 'Colocar 🎉' }).click();
  await expect(page.locator('#pv-title')).toHaveText('Parabéns, Admin🎉');
});

test('a imagem escolhida aparece na prévia, e some ao remover', async ({ page }) => {
  await openLoggedIn(page, accounts['adm-a'].session, '/i/teste-a/#/config/aniversario');
  // PNG de 1x1 ponto; não salva: só olha a prévia.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.locator('input[name="image"]').setInputFiles({ name: 'parabens.png', mimeType: 'image/png', buffer: png });
  const pv = page.locator('.push-preview #pv-image');
  await expect(pv).toBeVisible();
  await expect(pv).toHaveAttribute('src', /^blob:/);
  await page.getByRole('button', { name: 'Remover imagem' }).click();
  await expect(pv).toBeHidden();
});

test('com o cartão ligado, a prévia mostra a imagem com a mensagem escrita por cima', async ({ page }) => {
  // Banco ainda sem o supabase/040_cartao.sql: completa os modelos com as opções do cartão (não salva nada).
  await page.route('**/rest/v1/message_templates?*', async (route) => {
    const res = await route.fetch();
    const rows = await res.json();
    const body = JSON.stringify(rows.map((r) => ({ card: false, card_position: 'meio', card_color: 'claro', card_x: 50, card_y: 50, card_width: 84, card_size: 100, card_font: 'padrao', card_text_color: '#ffffff', ...r })));
    await route.fulfill({ response: res, body });
  });
  await openLoggedIn(page, accounts['adm-a'].session, '/i/teste-a/#/config/aniversario');
  await expect(page.getByRole('heading', { name: 'Mensagem de aniversário' })).toBeVisible();
  const cardBox = page.getByLabel(/como um cartão/);
  // Imagem de 400x200 pontos, só uma cor; não salva: só olha a prévia.
  const jpg = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#123456';
    g.fillRect(0, 0, 400, 200);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.locator('input[name="image"]').setInputFiles({ name: 'arte.png', mimeType: 'image/png', buffer: Buffer.from(jpg, 'base64') });
  await expect(page.locator('#pv-image')).toBeVisible();
  await cardBox.check();
  const card = page.locator('#pv-card');
  await expect(card).toBeVisible();
  await expect(page.locator('#pv-image')).toBeHidden();
  // 1080 de largura; a imagem 2:1 fica com 540 de altura.
  await expect(card).toHaveJSProperty('width', 1080);
  await expect(card).toHaveJSProperty('height', 540);
  // O texto foi escrito por cima: no meio do cartão há pontos brancos (texto claro).
  const white = () =>
    card.evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) n++;
      return n;
    });
  expect(await white()).toBeGreaterThan(500);

  // Área do texto estreita e arrastada para a esquerda: o texto fica todo na metade esquerda.
  const side = (from, to) =>
    card.evaluate(
      (c, [a, b]) => {
        const x0 = Math.round(c.width * a);
        const d = c.getContext('2d').getImageData(x0, 0, Math.round(c.width * b) - x0, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) n++;
        return n;
      },
      [from, to],
    );
  await page.locator('input[name="card_width"]').fill('40');
  await expect(page.locator('#card-width-out')).toHaveText('40%');
  const editor = page.locator('#card-edit');
  await editor.scrollIntoViewIfNeeded();
  const r = await editor.boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.3, r.y + r.height / 2, { steps: 5 });
  await page.mouse.move(r.x + r.width * 0.15, r.y + r.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => side(0.5, 1)).toBeLessThan(20);
  expect(await side(0, 0.5)).toBeGreaterThan(300);
  // Centralizar volta para o meio.
  await page.getByRole('button', { name: 'Centralizar' }).click();
  await expect.poll(() => side(0.5, 1)).toBeGreaterThan(100);

  // Letras maiores: mais pontos brancos (com a área larga, para o texto caber sem diminuir).
  await page.locator('input[name="card_width"]').fill('100');
  await page.locator('input[name="card_size"]').fill('50');
  await expect(page.locator('#card-size-out')).toHaveText('50%');
  const before = await white();
  await page.locator('input[name="card_size"]').fill('80');
  await expect(page.locator('#card-size-out')).toHaveText('80%');
  await expect.poll(white).toBeGreaterThan(before * 1.5);

  // Cor pronta (Preto): some o branco. E a cor digitada vale também.
  await page.getByRole('button', { name: 'Preto' }).click();
  await expect(page.locator('.color-code[data-for="card_text_color"]')).toHaveValue('#1b1e27');
  await expect.poll(white).toBeLessThan(50);
  await page.locator('.color-code[data-for="card_text_color"]').fill('#ffffff');
  await expect.poll(white).toBeGreaterThan(500);
  // Letra: baixa o arquivo da letra escolhida e redesenha com ela.
  await page.locator('select[name="card_font"]').selectOption('greatvibes');
  await expect
    .poll(() => page.evaluate(() => [...document.fonts].some((f) => f.family.includes('Cartao GreatVibes') && f.status === 'loaded')))
    .toBe(true);
  // Desligado: volta a imagem sozinha.
  await cardBox.uncheck();
  await expect(card).toBeHidden();
  await expect(page.locator('input[name="card_size"]')).toBeHidden();
});

// Datas especiais (008): na Teste A, "Casada da A" (12/06/2010, autorizou mostrar) e
// "Batizado da A" (20/06/2020, não autorizou).
test('a liderança vê casamento e batismo na lista do mês, com os anos', async ({ page }) => {
  await openLoggedIn(page, accounts['lider-a'].session, '/i/teste-a/#/aniversariantes?mes=2027-06');
  await expect(page.locator('.bday-day', { hasText: 'Casada da A' })).toContainText('💍 Casamento · 17 anos');
  await expect(page.locator('.bday-day', { hasText: 'Batizado da A' })).toContainText('🕊️ Batismo · 7 anos');
});

test('o membro vê na lista do mês só as datas especiais autorizadas, sem os anos', async ({ page }) => {
  await openLoggedIn(page, accounts['membro-a'].session, '/i/teste-a/#/aniversariantes?mes=2027-06');
  const wedding = page.locator('.bday-day', { hasText: 'Casada da A' });
  await expect(wedding).toContainText('💍 Casamento');
  await expect(wedding).not.toContainText('anos');
  await expect(page.getByText('Batizado da A')).toHaveCount(0);
});

test('o admin escreve a mensagem de casamento com {anos}', async ({ page }) => {
  await openLoggedIn(page, accounts['adm-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Mensagem de casamento' }).click();
  await expect(page.getByRole('heading', { name: 'Mensagem de casamento' })).toBeVisible();
  await expect(page.getByRole('button', { name: '{idade}' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Parabéns pelos ');
  await page.getByRole('button', { name: '{anos}' }).click();
  await expect(page.locator('#pv-body')).toHaveText('Parabéns pelos 10 anos');
});

test('o membro vê as datas de casamento e batismo no próprio cadastro', async ({ page }) => {
  await openLoggedIn(page, accounts['membro-a'].session, '/i/teste-a/#/perfil');
  await expect(page.getByLabel('Data de casamento')).toBeVisible();
  await expect(page.getByLabel('Data de batismo')).toBeVisible();
  await expect(page.getByLabel('Meu aniversário de casamento (dia e mês)')).toBeVisible();
  await expect(page.getByLabel('Meu aniversário de batismo (dia e mês)')).toBeVisible();
});

test('o Início mostra avisos, eventos e aniversariantes num carrossel abaixo dos atalhos', async ({ page }) => {
  // 10/06/2027: "Casada da A" faz aniversário de casamento no dia 12. Aviso e evento fixos.
  await page.clock.setFixedTime(new Date('2027-06-10T12:00:00-03:00'));
  await page.route('**/rest/v1/announcements?*', (r) =>
    r.fulfill({ json: [{ id: 'a1', title: 'Retiro de jovens', body: 'Inscrições abertas', pinned: false, created_at: '2027-06-09T12:00:00Z' }] }),
  );
  await page.route('**/rest/v1/rpc/events_between', (r) =>
    r.fulfill({ json: [{ event_id: 'e1', title: 'Culto de domingo', starts_at: '2027-06-13T22:00:00Z', ends_at: null, location: null, repeat_weekly: false }] }),
  );
  await openLoggedIn(page, accounts['lider-a'].session, '/i/teste-a/#/');
  const carousel = page.locator('#home-carousel');
  await expect(carousel).toBeVisible();
  // Abaixo dos atalhos.
  expect(await page.evaluate(() => {
    const s = document.querySelector('.shortcuts');
    return !!(s.compareDocumentPosition(document.getElementById('home-carousel')) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await expect(carousel.locator('.slide h2')).toHaveText([/Avisos/, /Próximos eventos/, /Aniversariantes/]);
  const dots = carousel.locator('.carousel-dots button');
  await expect(dots).toHaveCount(3);
  await dots.nth(2).click();
  await expect(dots.nth(2)).toHaveAttribute('aria-current', 'true');
  await expect(carousel.locator('#week-birthdays')).toBeInViewport();
});
