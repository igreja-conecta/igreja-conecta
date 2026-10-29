// Chat nas telas, com contas da igreja Teste A (Android): membro e líder conversando em tempo real.
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, ANON_KEY, rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

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
  for (const u of ['lider-a', 'membro-a', 'adm-b']) as[u] = await loginAs(api, u);
});

test.afterAll(async () => {
  if (!api) return;
  // Se o teste de apagar parou no meio, a conversa do membro com a líder volta para ele.
  const h = { headers: as['membro-a'].headers };
  const [lider] = await (await api.get(rest('members?select=id,church_id&name=eq.Líder da A'), { headers: as['lider-a'].headers })).json();
  if (lider) {
    const conv = await (await api.post(rest('rpc/start_conversation'), { ...h, data: { p_church: lider.church_id, p_member: lider.id } })).json().catch(() => null);
    if (typeof conv === 'string') await api.post(rest('rpc/hide_conversation'), { ...h, data: { p_conv: conv, p_hide: false } });
  }
  await api.dispose();
});

test('o membro escreve para a liderança e a líder responde, em tempo real', async ({ page, browser }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await page.locator('#chat-link').click();
  await expect(page.getByRole('heading', { name: 'Conversas' })).toBeVisible();
  await page.getByRole('link', { name: 'Falar com a liderança' }).click();
  await page.getByRole('button', { name: /Líder da A/ }).click();
  await expect(page.locator('.chat-head')).toContainText('Líder da A');
  await page.getByLabel('Mensagem').fill(`Bom dia, pastor! ${tag}`);
  await page.getByRole('button', { name: 'Enviar' }).click();
  const mine = page.locator('.msg.mine', { hasText: tag });
  await expect(mine).toBeVisible();
  await expect(mine.locator('time')).not.toHaveText('enviando…');

  // A líder, em outro aparelho, vê o número no ícone e a conversa como não lida.
  const ctx2 = await browser.newContext({ ...test.info().project.use });
  const leader = await ctx2.newPage();
  await watchCsp(leader);
  await openLoggedIn(leader, as['lider-a'].session, '/i/teste-a/#/');
  await expect(leader.locator('#chat-badge')).toBeVisible();
  await leader.locator('#chat-link').click();
  const row = leader.locator('.chat-row', { hasText: 'Membro da A' });
  await expect(row).toHaveClass(/unread/);
  await expect(row).toContainText(tag);
  await row.click();
  await expect(leader.locator('.msg', { hasText: `Bom dia, pastor! ${tag}` })).toBeVisible();
  await leader.getByLabel('Mensagem').fill(`Bom dia! ${tag} resposta`);
  await leader.getByLabel('Mensagem').press('Shift+Enter');
  await leader.getByRole('button', { name: 'Enviar' }).click();
  await expect(leader.locator('.msg.mine', { hasText: `${tag} resposta` })).toBeVisible();
  expect(await cspViolations(leader)).toEqual([]);

  // Chega na tela do membro sem recarregar (tempo real).
  await expect(page.locator('.msg:not(.mine)', { hasText: `${tag} resposta` })).toBeVisible({ timeout: 15000 });
  await ctx2.close();
});

test('ninguém entra no canal particular de outra pessoa', async ({ page }) => {
  await openLoggedIn(page, as['adm-b'].session, '/i/teste-b/#/');
  // Cliente do Supabase na página, entrando no canal de outra conta.
  const listen = (key, topic, token) =>
    page.evaluate(
      async ({ url, anon, key, topic, token }) => {
        const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
        const c = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
        c.realtime.setAuth(token);
        window.__got = window.__got || {};
        window.__got[key] = [];
        return new Promise((resolve) => {
          c.channel(topic, { config: { private: true } })
            .on('broadcast', { event: 'message' }, ({ payload }) => window.__got[key].push(payload))
            .subscribe((s) => ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(s) && resolve(s));
          setTimeout(() => resolve('sem resposta'), 10000);
        });
      },
      { url: SUPABASE_URL, anon: ANON_KEY, key, topic, token },
    );
  const other = `user:${as['membro-a'].id}`;
  // O próprio membro entra no canal dele; a outra conta tenta entrar no mesmo canal.
  expect(await listen('dono', other, as['membro-a'].session.access_token)).toBe('SUBSCRIBED');
  await listen('intruso', other, as['adm-b'].session.access_token);

  // O membro manda uma mensagem: ela vai para o canal dele, que a outra conta não consegue ouvir.
  const [conv] = await (await api.get(rest('conversations?select=id&order=created_at&limit=1'), { headers: as['membro-a'].headers })).json();
  const sent = await api.post(rest('messages'), { headers: as['membro-a'].headers, data: { conversation_id: conv.id, body: `canal ${tag}` } });
  expect(sent.ok(), await sent.text()).toBe(true);
  await page.waitForTimeout(4000);
  const got = await page.evaluate(() => window.__got);
  expect(got.dono.map((m) => m.body)).toEqual([`canal ${tag}`]);
  expect(got.intruso).toEqual([]);
});

test('a lista de conversas e a conversa abrem na hora, mesmo com o banco demorando', async ({ page }) => {
  // O Início busca a lista e as mensagens das conversas recentes (só na memória).
  const prefetched = page.waitForResponse((r) => r.url().includes('/rest/v1/messages?') && r.url().includes('conversation_id=in.'));
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await prefetched;
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.locator('#chat-link').click();
  const row = page.locator('.chat-row', { hasText: 'Líder da A' });
  await expect(row).toBeVisible({ timeout: 1000 });
  await row.click();
  await expect(page.locator('.chat-head')).toContainText('Líder da A', { timeout: 1000 });
  await expect(page.locator('.msg').first()).toBeVisible({ timeout: 1000 });
});

test('nova conversa: a lista de pessoas e a conversa abrem na hora, mesmo com o banco demorando', async ({ page }) => {
  // Conversa apagada: some da lista e o toque na pessoa segue o caminho da conversa nova.
  const h = { headers: as['membro-a'].headers };
  const [lider] = await (await api.get(rest('members?select=id,church_id&name=eq.Líder da A'), { headers: as['lider-a'].headers })).json();
  const conv = await (await api.post(rest('rpc/start_conversation'), { ...h, data: { p_church: lider.church_id, p_member: lider.id } })).json();
  await api.post(rest('rpc/hide_conversation'), { ...h, data: { p_conv: conv } });
  try {
    // A lista de conversas já busca, em segundo plano, quem dá para chamar.
    const contacts = page.waitForResponse((r) => r.url().includes('/rpc/chat_contacts'));
    await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/chat');
    await contacts;
    await page.waitForLoadState('networkidle');
    await page.route('**/rest/v1/**', async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue().catch(() => {});
    });
    await page.getByRole('link', { name: 'Falar com a liderança' }).click();
    const person = page.locator('.chat-person', { hasText: 'Líder da A' });
    await expect(person).toBeVisible({ timeout: 1000 });
    await person.click();
    await expect(page.locator('.chat-head')).toContainText('Líder da A', { timeout: 1000 });
    // Já dá para digitar; o Enviar espera o banco criar a conversa.
    await page.getByLabel('Mensagem').fill(`primeira ${tag}`);
    await expect(page.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    await expect(page).toHaveURL(new RegExp(`#/chat/${conv}$`), { timeout: 15000 });
    await page.unroute('**/rest/v1/**');
    await expect(page.getByLabel('Mensagem')).toHaveValue(`primeira ${tag}`);
    await page.getByRole('button', { name: 'Enviar' }).click();
    await expect(page.locator('.msg.mine', { hasText: `primeira ${tag}` })).toContainText(/\d{2}:\d{2}/);
  } finally {
    await api.post(rest('rpc/hide_conversation'), { ...h, data: { p_conv: conv, p_hide: false } });
  }
});

test('o botão + abre a lista de quem dá para chamar, com busca', async ({ page }) => {
  // A líder vê a liderança e os membros.
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/chat');
  await page.getByRole('link', { name: 'Nova conversa' }).click();
  await expect(page.getByRole('heading', { name: 'Membros', exact: true })).toBeVisible();
  await expect(page.locator('.chat-person', { hasText: 'Membro da A' })).toBeVisible();
  // Mesmo formato da lista de membros: foto redonda de 44 px, sem esticar.
  const box = await page.locator('.chat-person .avatar').first().boundingBox();
  expect(Math.round(box.width)).toBe(44);
  expect(Math.round(box.height)).toBe(44);
  await page.getByLabel('Buscar pessoa').fill('membro');
  await expect(page.locator('.chat-person:visible')).toHaveCount(1);
  await page.getByLabel('Buscar pessoa').fill('ninguem-com-esse-nome');
  await expect(page.getByText('Ninguém com esse nome')).toBeVisible();
  await page.getByLabel('Buscar pessoa').fill('');
  await page.locator('.chat-person', { hasText: 'Membro da A' }).click();
  await expect(page.locator('.chat-head')).toContainText('Membro da A');

  // O membro comum (chat entre membros desligado) vê só a liderança.
  const member = await page.context().newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/chat');
  await member.getByRole('link', { name: 'Falar com a liderança' }).click();
  await expect(member.getByRole('heading', { name: 'Liderança', exact: true })).toBeVisible();
  await expect(member.getByRole('heading', { name: 'Membros', exact: true })).toHaveCount(0);
  await expect(member.locator('.chat-person', { hasText: 'Líder da A' })).toBeVisible();
});

test('arrastar a conversa para a esquerda apaga só para mim, com Desfazer; o menu ⋯ também apaga', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/chat');
  const wrap = page.locator('.swipe', { hasText: 'Líder da A' });
  await expect(wrap).toBeVisible();
  await expect(page.getByText('Arraste uma conversa para a esquerda para apagar.')).toBeVisible();

  // Arrasto curto: a linha volta ao lugar e nada é apagado.
  const drag = async (fraction) => {
    const box = await wrap.locator('.chat-row').boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.9, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * (0.9 - fraction), y, { steps: 12 });
    await page.mouse.up();
  };
  await drag(0.15);
  await expect(wrap).toBeVisible();
  await expect(page).toHaveURL(/#\/chat$/); // soltar depois de arrastar não abre a conversa

  // Arrasto longo: apaga, com Desfazer.
  await drag(0.7);
  await expect(page.locator('#toast')).toContainText('Conversa apagada.');
  await expect(wrap).toBeHidden();
  await page.getByRole('button', { name: 'Desfazer' }).click();
  await expect(page.locator('.swipe', { hasText: 'Líder da A' })).toBeVisible();

  // Pelo menu da conversa (para quem usa teclado ou leitor de tela).
  await page.locator('.swipe', { hasText: 'Líder da A' }).locator('.chat-row').click();
  await expect(page.locator('.chat-head')).toContainText('Líder da A');
  await page.getByLabel('Mais opções').click();
  // A pergunta é do app, com o nome da igreja no topo (não a janela do navegador com o endereço).
  page.once('dialog', () => {
    throw new Error('Apareceu a janela do navegador');
  });
  await page.getByRole('button', { name: 'Apagar conversa' }).click();
  const ask = page.getByRole('dialog');
  await expect(ask.getByRole('heading', { name: 'Igreja Teste A' })).toBeVisible();
  await expect(ask).toContainText('Ela some só para você');
  // Cancelar não apaga.
  await ask.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.chat-head')).toContainText('Líder da A');
  await page.getByLabel('Mais opções').click();
  await page.getByRole('button', { name: 'Apagar conversa' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Apagar' })).toBeVisible();
  await answer(page);
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(page.locator('#toast')).toContainText('Conversa apagada.');
  await expect(page.locator('.swipe', { hasText: 'Líder da A' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Desfazer' }).click();
  await expect(page.locator('.swipe', { hasText: 'Líder da A' })).toBeVisible();
});

test('numa conversa sem mensagens, o campo de escrever fica embaixo, logo acima das abas', async ({ page }) => {
  // A conversa apagada abre vazia (só o que chegar depois): o caso da conversa nova.
  const h = { headers: as['membro-a'].headers };
  const [lider] = await (await api.get(rest('members?select=id,church_id&name=eq.Líder da A'), { headers: as['lider-a'].headers })).json();
  const conv = await (await api.post(rest('rpc/start_conversation'), { ...h, data: { p_church: lider.church_id, p_member: lider.id } })).json();
  await api.post(rest('rpc/hide_conversation'), { ...h, data: { p_conv: conv } });
  try {
    await openLoggedIn(page, as['membro-a'].session, `/i/teste-a/#/chat/${conv}`);
    await expect(page.getByLabel('Mensagem')).toBeVisible();
    await expect(page.locator('.msg')).toHaveCount(0);
    const form = await page.locator('#chat-form').boundingBox();
    const tabbar = await page.locator('#tabbar').boundingBox();
    expect(Math.abs(form.y + form.height - tabbar.y)).toBeLessThan(4);
  } finally {
    await api.post(rest('rpc/hide_conversation'), { ...h, data: { p_conv: conv, p_hide: false } });
  }
});
