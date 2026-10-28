// Separação entre igrejas, testada com contas de verdade nas igrejas Teste A e Teste B.
// Cada tentativa de ler ou mexer na outra igreja (ou de passar do próprio papel) precisa falhar.
// Contas: supabase/002_igrejas_de_teste.sql + supabase/usuarios-de-teste.local.sql.
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, ANON_KEY, rest, configured, testPassword, loginAs, testEmail, assertCleanTestChurches } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

let api;
const as = {}; // contas logadas: { id, headers }
const church = {}; // 'a' e 'b': id das igrejas de teste
const returning = (h) => ({ ...h, Prefer: 'return=representation' });

const get = async (who, path) => {
  const res = await api.get(rest(path), { headers: as[who].headers });
  expect(res.ok(), `${who} GET ${path}: ${await res.text()}`).toBe(true);
  return res.json();
};
const rpc = (who, fn, data = {}) => api.post(rest(`rpc/${fn}`), { headers: as[who].headers, data });
// Cada pasta recebe um formato que ela aceita: assim uma recusa só pode ser por falta de permissão.
const FORMAT = { igrejas: 'image/png', membros: 'image/webp' };
const upload = (who, bucket, path) =>
  api.post(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    headers: { ...as[who].headers, 'Content-Type': FORMAT[bucket] },
    data: Buffer.from('89504e470d0a1a0a', 'hex'),
  });
async function expectDenied(res, label) {
  const body = await res.text();
  expect(res.ok(), `${label}: ${body}`).toBe(false);
  expect(body, label).not.toMatch(/mime|too large|payload/i);
}
const removeFile = (who, bucket, path) =>
  api.delete(`${SUPABASE_URL}/storage/v1/object/${bucket}`, { headers: as[who].headers, data: { prefixes: [path] } });

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    // No GitHub os testes não podem pular em silêncio.
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['adm-a', 'lider-a', 'membro-a', 'adm-b', 'sem-igreja']) as[u] = await loginAs(api, u);
  await assertCleanTestChurches(api, as);
  const rows = await (await api.get(rest('churches?select=id,slug&slug=in.(teste-a,teste-b)'), { headers: as['adm-a'].headers })).json();
  church.a = rows.find((r) => r.slug === 'teste-a').id;
  church.b = rows.find((r) => r.slug === 'teste-b').id;
  // A conta sem-igreja entra na Teste A só durante alguns testes. Se uma rodada parou no meio
  // (banco fora do ar, rodada cancelada), ela ficou lá: tira antes de começar.
  for (const who of ['adm-a', 'adm-b'])
    await api.delete(rest(`members?email=eq.${encodeURIComponent(testEmail('sem-igreja'))}`), { headers: as[who].headers });
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('Leitura de membros', () => {
  test('a liderança vê só os membros da própria igreja', async () => {
    for (const who of ['adm-a', 'lider-a']) {
      const rows = await get(who, 'members?select=name,church_id');
      expect(rows.length, who).toBeGreaterThan(0);
      expect(rows.every((r) => r.church_id === church.a), who).toBe(true);
      expect(rows.map((r) => r.name)).toContain('Fulano da A');
      expect(rows.map((r) => r.name)).not.toContain('Fulano da B');
    }
    const b = await get('adm-b', 'members?select=name,church_id');
    expect(b.every((r) => r.church_id === church.b)).toBe(true);
    expect(b.map((r) => r.name)).not.toContain('Fulano da A');
  });

  test('pedir os membros da outra igreja pelo id não traz nada', async () => {
    expect(await get('adm-a', `members?select=*&church_id=eq.${church.b}`)).toEqual([]);
    const embedded = await get('adm-a', `churches?select=slug,members(name)&id=eq.${church.b}`);
    expect(embedded[0].members).toEqual([]);
  });

  test('o membro comum vê só o próprio cadastro (telefones e aniversários dos outros, não)', async () => {
    const rows = await get('membro-a', 'members?select=name,user_id');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(as['membro-a'].id);
  });

  test('quem não é de nenhuma igreja não vê ninguém', async () => {
    expect(await get('sem-igreja', 'members?select=*')).toEqual([]);
    expect(await (await rpc('sem-igreja', 'my_church_ids')).json()).toEqual([]);
    expect(await (await rpc('sem-igreja', 'link_my_account')).json()).toBe(0);
  });
});

test.describe('Alterações na outra igreja', () => {
  test('o admin da A não altera membros nem a configuração da B', async () => {
    const h = returning(as['adm-a'].headers);
    const members = await api.patch(rest(`members?church_id=eq.${church.b}`), { headers: h, data: { name: 'Invadido' } });
    if (members.ok()) expect(await members.json()).toEqual([]);
    const conf = await api.patch(rest(`churches?id=eq.${church.b}`), { headers: h, data: { welcome_text: 'Invadido' } });
    if (conf.ok()) expect(await conf.json()).toEqual([]);
    const removed = await api.delete(rest(`members?church_id=eq.${church.b}`), { headers: h });
    if (removed.ok()) expect(await removed.json()).toEqual([]);
    const still = await get('adm-b', 'members?select=name&name=eq.Fulano da B');
    expect(still).toHaveLength(1);
  });

  test('o admin da A não cadastra ninguém na B', async () => {
    const res = await api.post(rest('members'), { headers: as['adm-a'].headers, data: { church_id: church.b, name: 'Intruso' } });
    expect(res.ok()).toBe(false);
  });

  test('ninguém leva um membro da sua igreja para a outra', async () => {
    const [fulano] = await get('adm-a', 'members?select=id&name=eq.Fulano da A');
    const res = await api.patch(rest(`members?id=eq.${fulano.id}`), { headers: as['adm-a'].headers, data: { church_id: church.b } });
    expect(res.ok()).toBe(false);
  });

  test('o admin da A edita a própria igreja', async () => {
    const [mine] = await get('adm-a', `churches?select=welcome_text&id=eq.${church.a}`);
    const res = await api.patch(rest(`churches?id=eq.${church.a}`), { headers: returning(as['adm-a'].headers), data: { welcome_text: mine.welcome_text } });
    expect(res.ok()).toBe(true);
    expect(await res.json()).toHaveLength(1);
  });

  test('ninguém troca o endereço, o limite de membros nem a marca de teste da igreja', async () => {
    for (const data of [{ slug: 'outra' }, { max_members: 999999 }, { is_test: false }, { active: false }]) {
      const res = await api.patch(rest(`churches?id=eq.${church.a}`), { headers: as['adm-a'].headers, data });
      expect(res.ok(), JSON.stringify(data)).toBe(false);
    }
  });
});

test.describe('Papéis dentro da igreja', () => {
  test('o membro não muda o próprio papel nem o e-mail, mas edita os próprios dados', async () => {
    const id = as['membro-a'].id;
    const role = await api.patch(rest(`members?user_id=eq.${id}`), { headers: as['membro-a'].headers, data: { role: 'admin' } });
    expect(role.ok()).toBe(false);
    const email = await api.patch(rest(`members?user_id=eq.${id}`), { headers: as['membro-a'].headers, data: { email: 'outro@exemplo.com' } });
    expect(email.ok()).toBe(false);
    const own = await api.patch(rest(`members?user_id=eq.${id}`), { headers: returning(as['membro-a'].headers), data: { show_phone: false } });
    expect(own.ok()).toBe(true);
    expect(await own.json()).toHaveLength(1);
  });

  test('o membro não cadastra ninguém', async () => {
    const res = await api.post(rest('members'), { headers: as['membro-a'].headers, data: { church_id: church.a, name: 'Novo' } });
    expect(res.ok()).toBe(false);
  });

  test('o líder cadastra membros, mas não dá papéis, não liga contas e não apaga', async () => {
    const lider = as['lider-a'].headers;
    const admin = await api.post(rest('members'), { headers: lider, data: { church_id: church.a, name: 'Quer ser admin', role: 'admin' } });
    expect(admin.ok()).toBe(false);
    const linked = await api.post(rest('members'), { headers: lider, data: { church_id: church.a, name: 'Conta alheia', user_id: as['adm-b'].id } });
    expect(linked.ok()).toBe(false);

    const created = await api.post(rest('members'), { headers: returning(lider), data: { church_id: church.a, name: 'Teste temporário' } });
    expect(created.ok(), await created.text()).toBe(true);
    const [row] = await created.json();
    try {
      const del = await api.delete(rest(`members?id=eq.${row.id}`), { headers: returning(lider) });
      if (del.ok()) expect(await del.json()).toEqual([]);
    } finally {
      const cleanup = await api.delete(rest(`members?id=eq.${row.id}`), { headers: returning(as['adm-a'].headers) });
      expect(await cleanup.json()).toHaveLength(1);
    }
  });

  test('o líder não muda o papel de ninguém', async () => {
    const res = await api.patch(rest(`members?user_id=eq.${as['membro-a'].id}`), { headers: as['lider-a'].headers, data: { role: 'lider' } });
    expect(res.ok()).toBe(false);
  });

  test('o último administrador não deixa de ser administrador', async () => {
    const res = await api.patch(rest(`members?user_id=eq.${as['adm-a'].id}`), { headers: as['adm-a'].headers, data: { role: 'membro' } });
    expect(res.ok()).toBe(false);
  });

  test('a liderança não configura a igreja (só o admin)', async () => {
    const res = await api.patch(rest(`churches?id=eq.${church.a}`), { headers: returning(as['lider-a'].headers), data: { welcome_text: 'Líder mudou' } });
    if (res.ok()) expect(await res.json()).toEqual([]);
  });
});

test.describe('Administração da plataforma', () => {
  test('admin de igreja não é admin da plataforma', async () => {
    expect(await (await rpc('adm-a', 'is_platform_admin')).json()).toBe(false);
    expect((await api.get(rest('platform_admins?select=*'), { headers: as['adm-a'].headers })).ok()).toBe(false);
    expect((await rpc('adm-a', 'create_church', { p_slug: 'invasora', p_name: 'Invasora', p_admin_email: 'a@b.com' })).ok()).toBe(false);
    expect((await rpc('adm-a', 'set_church_admin', { p_church: church.b, p_email: 'adm-a@teste.igrejaconecta.invalid' })).ok()).toBe(false);
    expect((await rpc('adm-a', 'set_church_active', { p_church: church.b, p_active: false })).ok()).toBe(false);
  });

  test('responder ao convite de outra igreja não dá acesso a ela', async () => {
    await rpc('adm-a', 'respond_to_church', { p_church: church.b, p_accept: true });
    expect(await (await rpc('adm-a', 'my_church_ids')).json()).toEqual([church.a]);
  });
});

test.describe('Arquivos por igreja', () => {
  test('o admin grava na pasta pública da própria igreja e não na da outra', async () => {
    const mine = `${church.a}/testes/isolamento.png`;
    const ok = await upload('adm-a', 'igrejas', mine);
    expect(ok.ok(), await ok.text()).toBe(true);
    await removeFile('adm-a', 'igrejas', mine);
    await expectDenied(await upload('adm-a', 'igrejas', `${church.b}/testes/isolamento.png`), 'adm-a na pasta da B');
  });

  test('líder e membro não gravam na pasta pública da igreja', async () => {
    for (const who of ['lider-a', 'membro-a']) {
      await expectDenied(await upload(who, 'igrejas', `${church.a}/testes/${who}.png`), who);
    }
  });

  test('fotos dos membros: a liderança grava na própria igreja; o membro e a outra igreja, não', async () => {
    const path = `${church.a}/testes/isolamento.webp`;
    const ok = await upload('lider-a', 'membros', path);
    expect(ok.ok(), await ok.text()).toBe(true);
    try {
      // A outra igreja não baixa a foto, e quem não é da igreja também não.
      for (const who of ['adm-b', 'sem-igreja']) {
        const res = await api.get(`${SUPABASE_URL}/storage/v1/object/authenticated/membros/${path}`, { headers: as[who].headers });
        expect(res.ok(), who).toBe(false);
      }
      const member = await api.get(`${SUPABASE_URL}/storage/v1/object/authenticated/membros/${path}`, { headers: as['membro-a'].headers });
      expect(member.ok()).toBe(true);
    } finally {
      await removeFile('lider-a', 'membros', path);
    }
    await expectDenied(await upload('membro-a', 'membros', `${church.a}/testes/membro.webp`), 'membro-a');
    await expectDenied(await upload('lider-a', 'membros', `${church.b}/testes/isolamento.webp`), 'lider-a na pasta da B');
  });
});

test.describe('Cadastro de membros (003)', () => {
  const memberOf = async (who) => (await get(who, `members?select=id,church_id,email&user_id=eq.${as[who].id}`))[0];

  test('o membro envia a própria foto, mas não na pasta de outro membro', async () => {
    const me = await memberOf('membro-a');
    const mine = `${church.a}/${me.id}/foto.webp`;
    const ok = await upload('membro-a', 'membros', mine);
    expect(ok.ok(), await ok.text()).toBe(true);
    await removeFile('membro-a', 'membros', mine);
    const [fulano] = await get('adm-a', 'members?select=id&name=eq.Fulano da A');
    await expectDenied(await upload('membro-a', 'membros', `${church.a}/${fulano.id}/foto.webp`), 'pasta do Fulano');
    await expectDenied(await upload('membro-a', 'membros', `${church.b}/${me.id}/foto.webp`), 'pasta na B');
  });

  test('a foto do cadastro precisa estar na pasta do próprio membro', async () => {
    const me = await memberOf('membro-a');
    const [fulano] = await get('adm-a', 'members?select=id&name=eq.Fulano da A');
    const res = await api.patch(rest(`members?id=eq.${me.id}`), {
      headers: as['membro-a'].headers,
      data: { photo_path: `${church.a}/${fulano.id}/foto.webp` },
    });
    expect(res.ok()).toBe(false);
  });

  test('o e-mail de quem já entrou no app não muda sem desligar a conta', async () => {
    const me = await memberOf('membro-a');
    const res = await api.patch(rest(`members?id=eq.${me.id}`), { headers: as['adm-a'].headers, data: { email: 'novo@teste.igrejaconecta.invalid' } });
    expect(res.ok()).toBe(false);
  });

  test('só o administrador da própria igreja desliga uma conta, e a pessoa volta ao aceitar de novo', async () => {
    // Usa a conta "sem-igreja" num cadastro temporário: desligar o "membro-a" derrubaria os
    // testes de tela que rodam ao mesmo tempo com ele.
    const created = await api.post(rest('members'), {
      headers: returning(as['lider-a'].headers),
      data: { church_id: church.a, name: 'Temporário do desligar', email: 'sem-igreja@teste.igrejaconecta.invalid' },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const [me] = await created.json();
    try {
      expect(await (await rpc('sem-igreja', 'link_my_account')).json()).toBe(1);
      expect((await rpc('sem-igreja', 'respond_to_church', { p_church: church.a, p_accept: true })).ok()).toBe(true);
      for (const who of ['lider-a', 'adm-b', 'sem-igreja']) {
        expect((await rpc(who, 'unlink_member_account', { p_member: me.id })).ok(), who).toBe(false);
      }
      expect((await rpc('adm-a', 'unlink_member_account', { p_member: me.id })).ok()).toBe(true);
      expect(await (await rpc('sem-igreja', 'my_church_ids')).json()).toEqual([]);
      // Entrar de novo liga a conta; aceitar o convite devolve o acesso.
      expect(await (await rpc('sem-igreja', 'link_my_account')).json()).toBe(1);
      expect((await rpc('sem-igreja', 'respond_to_church', { p_church: church.a, p_accept: true })).ok()).toBe(true);
      expect(await (await rpc('sem-igreja', 'my_church_ids')).json()).toEqual([church.a]);
    } finally {
      await api.delete(rest(`members?id=eq.${me.id}`), { headers: as['adm-a'].headers });
    }
  });

  test('o último administrador não é desligado', async () => {
    const me = await memberOf('adm-a');
    expect((await rpc('adm-a', 'unlink_member_account', { p_member: me.id })).ok()).toBe(false);
  });
});

test.describe('Aniversários (004)', () => {
  const between = async (who, churchKey, from, to) => {
    const res = await rpc(who, 'birthdays_between', { p_church: church[churchKey], p_from: from, p_to: to });
    expect(res.ok(), `${who}: ${await res.text()}`).toBe(true);
    return res.json();
  };

  test('a liderança vê todos os aniversariantes, com a idade', async () => {
    const rows = await between('lider-a', 'a', '2027-03-15', '2027-03-15');
    expect(rows).toEqual([expect.objectContaining({ name: 'Fulano da A', on_date: '2027-03-15', age: 47 })]);
  });

  test('o membro vê só quem autorizou, e sem a idade', async () => {
    expect(await between('membro-a', 'a', '2027-03-15', '2027-03-15')).toEqual([]);
    const rows = await between('membro-a', 'a', '2027-02-01', '2027-02-28');
    expect(rows).toEqual([expect.objectContaining({ name: 'Bissexto da A', on_date: '2027-02-28', age: null })]);
  });

  test('quem nasceu em 29/02 faz aniversário em 28/02 nos anos que não são bissextos', async () => {
    const days = async (from, to) =>
      (await between('lider-a', 'a', from, to)).filter((r) => r.name === 'Bissexto da A').map((r) => r.on_date);
    expect(await days('2027-02-27', '2027-03-01')).toEqual(['2027-02-28']);
    expect(await days('2028-02-27', '2028-03-01')).toEqual(['2028-02-29']);
  });

  test('outra igreja e quem não é de nenhuma não veem os aniversariantes', async () => {
    expect(await between('adm-b', 'a', '2027-03-01', '2027-03-31')).toEqual([]);
    expect(await between('sem-igreja', 'a', '2027-03-01', '2027-03-31')).toEqual([]);
  });

  test('período longo demais é recusado', async () => {
    const res = await rpc('lider-a', 'birthdays_between', { p_church: church.a, p_from: '2027-01-01', p_to: '2027-12-31' });
    expect(res.ok()).toBe(false);
  });

  test('a mensagem de aniversário: só o admin da igreja edita; a outra igreja nem lê', async () => {
    const mine = await get('adm-a', `message_templates?select=kind,title&church_id=eq.${church.a}`);
    expect(mine.map((r) => r.kind).sort()).toEqual(['aniversario', 'batismo', 'casamento', 'resumo_lideres']);
    expect(await get('adm-b', `message_templates?select=kind&church_id=eq.${church.a}`)).toEqual([]);
    expect(await get('membro-a', `message_templates?select=kind&church_id=eq.${church.a}`)).toEqual([]);
    for (const who of ['adm-b', 'lider-a']) {
      const res = await api.patch(rest(`message_templates?church_id=eq.${church.a}`), { headers: returning(as[who].headers), data: { title: 'Invadido' } });
      if (res.ok()) expect(await res.json(), who).toEqual([]);
    }
    const title = mine.find((r) => r.kind === 'aniversario').title;
    const own = await api.patch(rest(`message_templates?church_id=eq.${church.a}&kind=eq.aniversario`), {
      headers: returning(as['adm-a'].headers),
      data: { title },
    });
    expect(await own.json()).toHaveLength(1);
  });

  test('cada pessoa vê só os próprios aparelhos; o registro de envios não é aberto aos membros', async () => {
    // Endereço com a cara do serviço de push do Chrome (nunca recebe nada: o envio pula as igrejas de teste).
    const endpoint = `https://fcm.googleapis.com/fcm/send/teste-igreja-conecta-${Date.now()}`;
    const saved = await rpc('membro-a', 'save_push_subscription', { p_endpoint: endpoint, p_p256dh: 'chave', p_auth: 'auth' });
    expect(saved.ok(), await saved.text()).toBe(true);
    // Endereço que não é de um serviço de push: recusado (012).
    const other = await rpc('membro-a', 'save_push_subscription', { p_endpoint: 'https://atacante.invalid/x', p_p256dh: 'a', p_auth: 'b' });
    expect(other.ok()).toBe(false);
    const q = `push_subscriptions?select=endpoint&endpoint=eq.${encodeURIComponent(endpoint)}`;
    try {
      expect(await get('membro-a', q)).toHaveLength(1);
      expect(await get('adm-a', q)).toEqual([]);
    } finally {
      await api.delete(rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`), { headers: as['membro-a'].headers });
    }
    expect(await get('membro-a', 'message_log?select=id')).toEqual([]);
  });

  test('as funções de envio não respondem sem a senha, nem para quem está logado', async () => {
    for (const fn of ['claim_birthday_push', 'claim_birthday_email', 'claim_leader_summaries', 'platform_push_targets', 'birthday_email_backlog', 'clean_message_log']) {
      expect((await rpc('adm-a', fn, { p_secret: 'errada' })).ok(), fn).toBe(false);
    }
  });
});

test.describe('Datas especiais: casamento e batismo (008)', () => {
  const between = async (who, churchKey, from, to) => {
    const res = await rpc(who, 'celebrations_between', { p_church: church[churchKey], p_from: from, p_to: to });
    expect(res.ok(), `${who}: ${await res.text()}`).toBe(true);
    return res.json();
  };
  const special = (rows) => rows.filter((r) => r.kind !== 'aniversario');

  test('a liderança vê o casamento e o batismo, com os anos', async () => {
    const rows = special(await between('lider-a', 'a', '2027-06-01', '2027-06-30'));
    expect(rows).toEqual([
      expect.objectContaining({ name: 'Casada da A', kind: 'casamento', on_date: '2027-06-12', years: 17 }),
      expect.objectContaining({ name: 'Batizado da A', kind: 'batismo', on_date: '2027-06-20', years: 7 }),
    ]);
  });

  test('o membro vê só a data que a pessoa autorizou, e sem os anos', async () => {
    const rows = special(await between('membro-a', 'a', '2027-06-01', '2027-06-30'));
    expect(rows).toEqual([expect.objectContaining({ name: 'Casada da A', kind: 'casamento', years: null })]);
  });

  test('no próprio ano da data ainda não é aniversário', async () => {
    expect(special(await between('lider-a', 'a', '2010-06-01', '2010-06-30'))).toEqual([]);
  });

  test('a lista também traz os aniversários, como antes', async () => {
    const rows = await between('lider-a', 'a', '2027-03-15', '2027-03-15');
    expect(rows).toEqual([expect.objectContaining({ name: 'Fulano da A', kind: 'aniversario', years: 47 })]);
  });

  test('outra igreja e quem não é de nenhuma não veem as datas', async () => {
    expect(await between('adm-b', 'a', '2027-06-01', '2027-06-30')).toEqual([]);
    expect(await between('sem-igreja', 'a', '2027-06-01', '2027-06-30')).toEqual([]);
    const res = await rpc('lider-a', 'celebrations_between', { p_church: church.a, p_from: '2027-01-01', p_to: '2027-12-31' });
    expect(res.ok()).toBe(false);
  });

  test('o membro preenche as próprias datas e as autorizações', async () => {
    const id = as['membro-a'].id;
    const patch = (data) => api.patch(rest(`members?user_id=eq.${id}`), { headers: returning(as['membro-a'].headers), data });
    const res = await patch({ wedding_date: '2001-05-05', baptism_date: '1999-09-09', show_wedding: true, show_baptism: true });
    expect(res.ok(), await res.text()).toBe(true);
    expect(await res.json()).toEqual([expect.objectContaining({ wedding_date: '2001-05-05', show_baptism: true })]);
    const back = await patch({ wedding_date: null, baptism_date: null, show_wedding: false, show_baptism: false });
    expect(back.ok()).toBe(true);
  });

  test('a lista de quem comemora hoje não é aberta pelo app', async () => {
    for (const who of ['adm-a', 'sem-igreja']) {
      expect((await rpc(who, 'celebration_candidates', { p_day: '2027-06-12' })).ok(), who).toBe(false);
    }
  });
});

test.describe('Agenda, avisos e central de notificações (005)', () => {
  const tag = `teste-${Date.now()}`;

  test('agenda: a liderança cria um culto semanal; os membros veem as repetições; a outra igreja, nada', async () => {
    const start = new Date('2027-03-07T22:00:00Z'); // domingo, 19h em Brasília
    const created = await api.post(rest('events'), {
      headers: returning(as['lider-a'].headers),
      data: {
        church_id: church.a,
        title: `Culto ${tag}`,
        starts_at: start.toISOString(),
        ends_at: new Date(start.getTime() + 2 * 3600e3).toISOString(),
        repeat_weekly: true,
        repeat_until: '2027-03-28',
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const [ev] = await created.json();
    try {
      const range = { p_church: church.a, p_from: '2027-03-01T00:00:00Z', p_to: '2027-04-30T00:00:00Z' };
      const occ = (await (await rpc('membro-a', 'events_between', range)).json()).filter((o) => o.event_id === ev.id);
      expect(occ.map((o) => o.starts_at.slice(0, 10))).toEqual(['2027-03-07', '2027-03-14', '2027-03-21', '2027-03-28']);

      expect(await (await rpc('adm-b', 'events_between', range)).json()).toEqual([]);
      expect(await get('adm-b', `events?select=id&id=eq.${ev.id}`)).toEqual([]);
      const h = returning(as['adm-b'].headers);
      const changed = await api.patch(rest(`events?id=eq.${ev.id}`), { headers: h, data: { title: 'Invadido' } });
      if (changed.ok()) expect(await changed.json()).toEqual([]);
      const removed = await api.delete(rest(`events?id=eq.${ev.id}`), { headers: h });
      if (removed.ok()) expect(await removed.json()).toEqual([]);

      // O líder da A não leva o evento para a B; o membro não cria eventos.
      const moved = await api.patch(rest(`events?id=eq.${ev.id}`), { headers: as['lider-a'].headers, data: { church_id: church.b } });
      expect(moved.ok()).toBe(false);
      const byMember = await api.post(rest('events'), {
        headers: as['membro-a'].headers,
        data: { church_id: church.a, title: 'Do membro', starts_at: start.toISOString() },
      });
      expect(byMember.ok()).toBe(false);
    } finally {
      const del = await api.delete(rest(`events?id=eq.${ev.id}`), { headers: returning(as['lider-a'].headers) });
      expect(await del.json()).toHaveLength(1);
    }
  });

  test('avisos: vencido some para os membros (a liderança vê); a notificação não é ligada depois', async () => {
    const created = await api.post(rest('announcements'), {
      headers: returning(as['lider-a'].headers),
      data: { church_id: church.a, title: `Aviso ${tag}`, body: 'Texto', visible_until: '2020-01-01', pushed_at: '2020-01-01T00:00:00Z' },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const [a] = await created.json();
    try {
      expect(a.pushed_at).toBe(null);
      expect(await get('membro-a', `announcements?select=id&id=eq.${a.id}`)).toEqual([]);
      expect(await get('lider-a', `announcements?select=id&id=eq.${a.id}`)).toHaveLength(1);
      expect(await get('adm-b', `announcements?select=id&id=eq.${a.id}`)).toEqual([]);
      const push = await api.patch(rest(`announcements?id=eq.${a.id}`), { headers: as['lider-a'].headers, data: { push: true } });
      expect(push.ok()).toBe(false);
      const byMember = await api.post(rest('announcements'), { headers: as['membro-a'].headers, data: { church_id: church.a, title: 'Do membro', body: 'x' } });
      expect(byMember.ok()).toBe(false);
    } finally {
      const del = await api.delete(rest(`announcements?id=eq.${a.id}`), { headers: returning(as['lider-a'].headers) });
      expect(await del.json()).toHaveLength(1);
    }
  });

  test('notificações: ninguém cria pelo app, e cada um só lê as próprias', async () => {
    const res = await api.post(rest('notifications'), {
      headers: as['adm-a'].headers,
      data: { user_id: as['membro-a'].id, church_id: church.a, kind: 'sistema', title: 'Falsa', dedupe_key: tag },
    });
    expect(res.ok()).toBe(false);
    const rows = await get('membro-a', 'notifications?select=user_id');
    expect(rows.every((r) => r.user_id === as['membro-a'].id)).toBe(true);
  });

  test('as funções de envio dos lembretes e avisos não respondem sem a senha', async () => {
    for (const fn of ['claim_event_reminders', 'claim_announcement_push', 'deliver_birthday_notifications', 'clean_notifications']) {
      expect((await rpc('adm-a', fn, { p_secret: 'errada' })).ok(), fn).toBe(false);
    }
  });
});

test.describe('Os próprios dados: exportar, sair e excluir (006)', () => {
  test('o arquivo exportado traz só os dados da própria pessoa', async () => {
    const res = await rpc('membro-a', 'export_my_data');
    expect(res.ok(), await res.text()).toBe(true);
    const data = await res.json();
    expect(data.conta.email).toBe('membro-a@teste.igrejaconecta.invalid');
    expect(data.igrejas).toHaveLength(1);
    expect(data.igrejas[0]).toMatchObject({ igreja: 'Igreja Teste A', papel: 'membro', cadastro: { nome: 'Membro da A' } });
    // As conversas do chat trazem o nome de quem conversou com a pessoa (são dela também); o resto, nada dos outros.
    const { conversas_do_chat: chats, ...rest } = data;
    const text = JSON.stringify(rest);
    for (const other of ['Fulano', 'Bissexto', 'Casada', 'Batizado', 'Admin da A', 'Teste B', '5561999990001']) expect(text, other).not.toContain(other);
    for (const c of chats) expect(c.mensagens.every((m) => ['você', c.com].includes(m.de))).toBe(true);
    expect(data.igrejas[0].cadastro).toHaveProperty('casamento');
    expect(data.igrejas[0].cadastro).toHaveProperty('mostra_batismo_aos_membros');
  });

  test('o único administrador não sai da igreja nem exclui a conta', async () => {
    expect((await rpc('adm-a', 'leave_church', { p_church: church.a })).ok()).toBe(false);
    const del = await rpc('adm-a', 'delete_my_account');
    expect(del.ok()).toBe(false);
    expect(await del.text()).toContain('único administrador');
    expect(await (await rpc('adm-a', 'my_church_ids')).json()).toEqual([church.a]);
  });

  test('quem sai de uma igreja perde o acesso e o cadastro dela é apagado', async () => {
    const email = 'sem-igreja@teste.igrejaconecta.invalid';
    const created = await api.post(rest('members'), {
      headers: returning(as['lider-a'].headers),
      data: { church_id: church.a, name: 'Temporário da saída', email },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const [row] = await created.json();
    try {
      expect(await (await rpc('sem-igreja', 'link_my_account')).json()).toBe(1);
      expect((await rpc('sem-igreja', 'respond_to_church', { p_church: church.a, p_accept: true })).ok()).toBe(true);
      expect(await (await rpc('sem-igreja', 'my_church_ids')).json()).toEqual([church.a]);
      // Sair de outra igreja não mexe em nada; sair da A apaga o cadastro.
      expect((await rpc('sem-igreja', 'leave_church', { p_church: church.b })).ok()).toBe(true);
      expect(await get('lider-a', `members?select=id&id=eq.${row.id}`)).toHaveLength(1);
      expect((await rpc('sem-igreja', 'leave_church', { p_church: church.a })).ok()).toBe(true);
      expect(await (await rpc('sem-igreja', 'my_church_ids')).json()).toEqual([]);
      expect(await get('lider-a', `members?select=id&id=eq.${row.id}`)).toEqual([]);
    } finally {
      await api.delete(rest(`members?id=eq.${row.id}`), { headers: as['adm-a'].headers });
    }
  });
});

test.describe('Pedidos de oração (009)', () => {
  // Uma secretaria de verdade na Teste A (conta "sem-igreja", só durante estes testes):
  // é da liderança, mas não é pastoral, então não lê os pedidos privados nem modera.
  let secretary;
  const tag = `oração ${Date.now().toString(36)}`;
  const send = (who, data) =>
    api.post(rest('prayer_requests'), { headers: returning(as[who].headers), data: { church_id: church.a, ...data } });
  const patch = (who, id, data) =>
    api.patch(rest(`prayer_requests?id=eq.${id}`), { headers: returning(as[who].headers), data });
  const wall = async (who, c = church.a) => (await rpc(who, 'prayer_wall', { p_church: c })).json();

  test.beforeAll(async () => {
    const created = await api.post(rest('members'), {
      headers: returning(as['adm-a'].headers),
      data: { church_id: church.a, name: 'Secretaria temporária', email: 'sem-igreja@teste.igrejaconecta.invalid', role: 'secretaria' },
    });
    expect(created.ok(), await created.text()).toBe(true);
    [secretary] = await created.json();
    await rpc('sem-igreja', 'link_my_account');
    expect((await rpc('sem-igreja', 'respond_to_church', { p_church: church.a, p_accept: true })).ok()).toBe(true);
  });

  test.afterAll(async () => {
    const mine = `prayer_requests?body=like.*${encodeURIComponent(tag)}*`;
    await api.delete(rest(mine), { headers: as['adm-a'].headers });
    await api.delete(rest(mine), { headers: as['membro-a'].headers });
    if (secretary) await api.delete(rest(`members?id=eq.${secretary.id}`), { headers: as['adm-a'].headers });
  });

  test('pedido só para os pastores: o administrador e o líder leem; a secretaria, a outra igreja e o mural, não', async () => {
    const res = await send('membro-a', { body: `Privado ${tag}`, audience: 'pastores', anonymous: true, status: 'aprovado' });
    expect(res.ok(), await res.text()).toBe(true);
    const [p] = await res.json();
    // O banco decide a situação e o autor, não quem envia.
    expect(p).toMatchObject({ status: 'privado', anonymous: false, user_id: as['membro-a'].id });
    for (const who of ['adm-a', 'lider-a', 'membro-a']) expect(await get(who, `prayer_requests?select=id&id=eq.${p.id}`), who).toHaveLength(1);
    for (const who of ['sem-igreja', 'adm-b']) expect(await get(who, `prayer_requests?select=id&id=eq.${p.id}`), who).toEqual([]);
    for (const who of ['membro-a', 'sem-igreja', 'lider-a']) expect((await wall(who)).map((r) => r.id), who).not.toContain(p.id);
    // A liderança pastoral recebe o aviso na central, sem o texto do pedido.
    const [n] = await get('lider-a', `notifications?select=kind,title,body,url&dedupe_key=eq.oracao:${p.id}`);
    expect(n).toMatchObject({ kind: 'oracao', title: 'Novo pedido de oração', url: '#/oracao/moderar' });
    expect(n.body).not.toContain(tag);
    expect(await get('sem-igreja', `notifications?select=id&dedupe_key=eq.oracao:${p.id}`)).toEqual([]);
    // Ninguém de fora modera nem apaga; o líder marca que cuidou; a secretaria, não.
    expect(await (await patch('sem-igreja', p.id, { cared_at: new Date().toISOString() })).text()).not.toContain(p.id);
    expect(await (await patch('adm-b', p.id, { cared_at: new Date().toISOString() })).text()).not.toContain(p.id);
    expect((await patch('lider-a', p.id, { status: 'aprovado' })).ok()).toBe(false);
    const cared = await patch('lider-a', p.id, { cared_at: new Date().toISOString() });
    expect(cared.ok(), await cared.text()).toBe(true);
    const removed = await api.delete(rest(`prayer_requests?id=eq.${p.id}`), { headers: returning(as['adm-b'].headers) });
    expect(await removed.json()).toEqual([]);
  });

  test('pedido para a igreja: só vai ao mural depois da aprovação, e o anônimo esconde o nome dos membros', async () => {
    const res = await send('membro-a', { body: `Para a igreja ${tag}`, audience: 'igreja', anonymous: true });
    expect(res.ok(), await res.text()).toBe(true);
    const [p] = await res.json();
    expect(p.status).toBe('pendente');
    expect((await wall('sem-igreja')).map((r) => r.id)).not.toContain(p.id);
    const [n] = await get('adm-a', `notifications?select=title&dedupe_key=eq.oracao:${p.id}`);
    expect(n.title).toBe('Pedido de oração para aprovar');

    // O autor não aprova o próprio pedido; a secretaria também não.
    expect((await patch('membro-a', p.id, { status: 'aprovado' })).ok()).toBe(false);
    expect(await (await patch('sem-igreja', p.id, { status: 'aprovado' })).text()).not.toContain(p.id);
    // O líder corrige o texto e aprova.
    const ok = await patch('lider-a', p.id, { body: `Para a igreja (corrigido) ${tag}`, status: 'aprovado' });
    expect(ok.ok(), await ok.text()).toBe(true);
    const [author] = await get('membro-a', `notifications?select=title,url&dedupe_key=eq.oracao-aprovado:${p.id}`);
    expect(author).toMatchObject({ title: 'Seu pedido de oração está no mural', url: '#/oracao/meus' });

    const seen = (await wall('sem-igreja')).find((r) => r.id === p.id);
    expect(seen).toMatchObject({ body: `Para a igreja (corrigido) ${tag}`, author: null, anonymous: true, mine: false });
    expect((await wall('lider-a')).find((r) => r.id === p.id).author).toBe('Membro da A');
    expect((await wall('membro-a')).find((r) => r.id === p.id)).toMatchObject({ author: 'Membro da A', mine: true });
    expect(await wall('adm-b', church.a)).toEqual([]);
    expect(await wall('sem-igreja', church.b)).toEqual([]);
    // Depois de aprovado, o texto não muda mais.
    expect((await patch('lider-a', p.id, { body: `Mudado ${tag}` })).ok()).toBe(false);
  });

  test('"Estou orando" conta sem mostrar quem, e só vale para pedidos do mural da própria igreja', async () => {
    const [p] = await (await send('membro-a', { body: `Contador ${tag}`, audience: 'igreja' })).json();
    expect((await rpc('sem-igreja', 'prayer_toggle', { p_request: p.id })).ok()).toBe(false); // ainda não aprovado
    expect((await patch('adm-a', p.id, { status: 'aprovado' })).ok()).toBe(true);
    expect(await (await rpc('sem-igreja', 'prayer_toggle', { p_request: p.id })).json()).toEqual([{ praying: 1, i_pray: true }]);
    expect(await (await rpc('lider-a', 'prayer_toggle', { p_request: p.id })).json()).toEqual([{ praying: 2, i_pray: true }]);
    expect((await wall('membro-a')).find((r) => r.id === p.id)).toMatchObject({ praying: 2, i_pray: false });
    expect(await (await rpc('sem-igreja', 'prayer_toggle', { p_request: p.id })).json()).toEqual([{ praying: 1, i_pray: false }]);
    expect((await rpc('adm-b', 'prayer_toggle', { p_request: p.id })).ok()).toBe(false);
    expect((await api.get(rest('prayer_praying?select=user_id'), { headers: as['lider-a'].headers })).ok()).toBe(false);
  });

  test('só o autor marca "Deus respondeu" e apaga o pedido; o autor não muda o texto', async () => {
    const [p] = await (await send('membro-a', { body: `Resposta ${tag}`, audience: 'pastores' })).json();
    expect((await patch('lider-a', p.id, { answered_at: new Date().toISOString() })).ok()).toBe(false);
    expect((await patch('membro-a', p.id, { body: `Outro ${tag}` })).ok()).toBe(false);
    const answered = await patch('membro-a', p.id, { answered_at: new Date().toISOString() });
    expect(answered.ok(), await answered.text()).toBe(true);
    const removed = await api.delete(rest(`prayer_requests?id=eq.${p.id}`), { headers: returning(as['membro-a'].headers) });
    expect(await removed.json()).toHaveLength(1);
  });

  test('quem não é da igreja não envia, e com a funcionalidade desligada ninguém envia', async () => {
    expect((await send('adm-b', { body: `Intruso ${tag}`, audience: 'pastores' })).ok()).toBe(false);
    const [b] = await get('adm-b', `churches?select=features&id=eq.${church.b}`);
    const setFeatures = (features) => api.patch(rest(`churches?id=eq.${church.b}`), { headers: as['adm-b'].headers, data: { features } });
    expect((await setFeatures({ ...b.features, oracao: false })).ok()).toBe(true);
    try {
      const res = await api.post(rest('prayer_requests'), {
        headers: as['adm-b'].headers,
        data: { church_id: church.b, body: `Desligado ${tag}`, audience: 'pastores' },
      });
      expect(res.ok()).toBe(false);
    } finally {
      await setFeatures(b.features);
    }
  });

  test('os pedidos entram no arquivo dos próprios dados; o envio por push pede a senha', async () => {
    await send('membro-a', { body: `Exportado ${tag}`, audience: 'pastores' });
    const data = await (await rpc('membro-a', 'export_my_data')).json();
    expect(data.pedidos_de_oracao.map((p) => p.pedido)).toContain(`Exportado ${tag}`);
    expect(JSON.stringify((await (await rpc('lider-a', 'export_my_data')).json()).pedidos_de_oracao)).not.toContain(tag);
    expect((await rpc('adm-a', 'claim_notification_push', { p_secret: 'errada' })).ok()).toBe(false);
  });
});

test.describe('Células (010)', () => {
  // "membro-a" lidera uma célula (sem ser da liderança da igreja) e é só participante de outra.
  const tag = `Célula ${Date.now().toString(36)}`;
  const id = {}; // cadastros usados
  const cell = {}; // led: a que membro-a lidera; joined: a que membro-a só participa
  const members = (who, data) => api.post(rest('cell_members'), { headers: returning(as[who].headers), data });
  const roster = async (who, c) => (await rpc(who, 'cell_roster', { p_cell: c })).json();
  // Encontros de hoje e de amanhã (horário de Brasília): depois da entrada das pessoas na célula.
  const brDay = (plus) => new Date(Date.now() + plus * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const day1 = brDay(0);
  const day2 = brDay(1);
  const meeting = (who, c, present, date = day1) =>
    rpc(who, 'save_cell_meeting', { p_cell: c, p_date: date, p_topic: 'Tema', p_notes: null, p_visitors: 2, p_present: present });

  test.beforeAll(async () => {
    const people = await get('lider-a', 'members?select=id,name&name=in.("Membro da A","Fulano da A","Bissexto da A")');
    for (const p of people) id[p.name] = p.id;
    [{ id: id['Fulano da B'] }] = await get('adm-b', 'members?select=id&name=eq.Fulano da B');
    for (const k of ['led', 'joined']) {
      const res = await api.post(rest('cells'), {
        headers: returning(as['lider-a'].headers),
        data: { church_id: church.a, name: `${tag} ${k}`, weekday: 3, meets_at: '19:30' },
      });
      expect(res.ok(), await res.text()).toBe(true);
      [{ id: cell[k] }] = await res.json();
    }
    for (const [c, member, role] of [
      [cell.led, id['Membro da A'], 'lider'],
      [cell.led, id['Fulano da A'], 'participante'],
      [cell.joined, id['Membro da A'], 'participante'],
      [cell.joined, id['Fulano da A'], 'lider'],
    ]) {
      const res = await members('lider-a', { cell_id: c, member_id: member, role });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });

  test.afterAll(async () => {
    await api.delete(rest(`cells?name=like.*${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  });

  test('a liderança cria células; o membro comum e a outra igreja não criam nem veem as dos outros', async () => {
    expect((await api.post(rest('cells'), { headers: as['membro-a'].headers, data: { church_id: church.a, name: `${tag} intrusa` } })).ok()).toBe(false);
    expect((await api.post(rest('cells'), { headers: as['adm-b'].headers, data: { church_id: church.a, name: `${tag} intrusa` } })).ok()).toBe(false);
    expect(await get('adm-b', `cells?select=id&id=in.(${cell.led},${cell.joined})`)).toEqual([]);
    expect(await get('adm-b', `cell_members?select=member_id&cell_id=eq.${cell.led}`)).toEqual([]);
    expect(await roster('adm-b', cell.led)).toEqual([]);
    // O membro vê só as células de que participa.
    expect((await get('membro-a', `cells?select=id&name=like.*${encodeURIComponent(tag)}*`)).map((c) => c.id).sort()).toEqual([cell.led, cell.joined].sort());
    const [other] = await (await api.post(rest('cells'), { headers: returning(as['lider-a'].headers), data: { church_id: church.a, name: `${tag} outra` } })).json();
    expect(await get('membro-a', `cells?select=id&id=eq.${other.id}`)).toEqual([]);
    expect(await roster('membro-a', other.id)).toEqual([]);
  });

  test('o participante vê os outros sem o telefone de quem não autorizou, e não vê presença nem encontros', async () => {
    const list = await roster('membro-a', cell.joined);
    expect(list.map((p) => p.name).sort()).toEqual(['Fulano da A', 'Membro da A']);
    const fulano = list.find((p) => p.name === 'Fulano da A');
    expect(fulano).toMatchObject({ role: 'lider', phone: null, misses: null, last_present: null });
    expect((await meeting('membro-a', cell.joined, [id['Membro da A']])).ok()).toBe(false);
    expect(await get('membro-a', `cell_meetings?select=id&cell_id=eq.${cell.joined}`)).toEqual([]);
    expect((await members('membro-a', { cell_id: cell.joined, member_id: id['Bissexto da A'] })).ok()).toBe(false);
    expect(await (await rpc('membro-a', 'cell_candidates', { p_cell: cell.joined, p_search: 'Bissexto' })).json()).toEqual([]);
  });

  test('o líder da célula registra a presença (só de quem é da célula) e vê as faltas seguidas', async () => {
    const res = await meeting('membro-a', cell.led, [id['Membro da A'], id['Fulano da B']], day1);
    expect(res.ok(), await res.text()).toBe(true);
    const meetingId = await res.json();
    expect((await meeting('membro-a', cell.led, [id['Membro da A']], day2)).ok()).toBe(true);
    const present = await get('membro-a', `cell_attendance?select=member_id&meeting_id=eq.${meetingId}`);
    expect(present.map((p) => p.member_id)).toEqual([id['Membro da A']]); // a pessoa da outra igreja foi ignorada
    const list = await roster('membro-a', cell.led);
    expect(list.find((p) => p.name === 'Fulano da A')).toMatchObject({ misses: 2, last_present: null, phone: '5561999990001' });
    expect(list.find((p) => p.name === 'Membro da A')).toMatchObject({ misses: 0, last_present: day2, is_me: true });
    // Corrigir o mesmo dia troca a lista de presença.
    expect((await meeting('membro-a', cell.led, [id['Fulano da A']], day2)).ok()).toBe(true);
    expect((await roster('lider-a', cell.led)).find((p) => p.name === 'Fulano da A')).toMatchObject({ misses: 0, last_present: day2 });
    // A outra igreja não lê nem grava.
    expect(await get('adm-b', `cell_meetings?select=id&cell_id=eq.${cell.led}`)).toEqual([]);
    expect(await get('adm-b', `cell_attendance?select=member_id&meeting_id=eq.${meetingId}`)).toEqual([]);
    expect((await meeting('adm-b', cell.led, [])).ok()).toBe(false);
    expect((await api.post(rest('cell_attendance'), { headers: as['membro-a'].headers, data: { meeting_id: meetingId, member_id: id['Fulano da A'] } })).ok()).toBe(false);
  });

  test('o líder da célula coloca e tira participantes, mas não escolhe líderes', async () => {
    const found = await (await rpc('membro-a', 'cell_candidates', { p_cell: cell.led, p_search: 'bissexto' })).json();
    expect(found).toEqual([{ member_id: id['Bissexto da A'], name: 'Bissexto da A' }]);
    expect(await (await rpc('membro-a', 'cell_candidates', { p_cell: cell.led, p_search: 'Fulano' })).json()).toEqual([]); // já está
    expect((await members('membro-a', { cell_id: cell.led, member_id: id['Bissexto da A'], role: 'auxiliar' })).ok()).toBe(false);
    expect((await members('membro-a', { cell_id: cell.led, member_id: id['Bissexto da A'] })).ok()).toBe(true);
    const promote = await api.patch(rest(`cell_members?cell_id=eq.${cell.led}&member_id=eq.${id['Bissexto da A']}`), {
      headers: returning(as['membro-a'].headers),
      data: { role: 'lider' },
    });
    if (promote.ok()) expect(await promote.json()).toEqual([]);
    const removed = await api.delete(rest(`cell_members?cell_id=eq.${cell.led}&member_id=eq.${id['Bissexto da A']}`), {
      headers: returning(as['membro-a'].headers),
    });
    expect(await removed.json()).toHaveLength(1);
    // O líder não tira a si mesmo (o papel de líder é da liderança da igreja).
    const self = await api.delete(rest(`cell_members?cell_id=eq.${cell.led}&member_id=eq.${id['Membro da A']}`), {
      headers: returning(as['membro-a'].headers),
    });
    expect(await self.json()).toEqual([]);
    // Ninguém coloca na célula uma pessoa de outra igreja.
    expect((await members('lider-a', { cell_id: cell.led, member_id: id['Fulano da B'] })).ok()).toBe(false);
    expect((await members('adm-b', { cell_id: cell.led, member_id: id['Fulano da B'] })).ok()).toBe(false);
  });

  test('com a funcionalidade desligada, ninguém cria células', async () => {
    const [b] = await get('adm-b', `churches?select=features&id=eq.${church.b}`);
    const setFeatures = (features) => api.patch(rest(`churches?id=eq.${church.b}`), { headers: as['adm-b'].headers, data: { features } });
    expect((await setFeatures({ ...b.features, celulas: false })).ok()).toBe(true);
    try {
      expect((await api.post(rest('cells'), { headers: as['adm-b'].headers, data: { church_id: church.b, name: `${tag} desligada` } })).ok()).toBe(false);
    } finally {
      await setFeatures(b.features);
    }
  });

  test('as células e as próprias presenças entram no arquivo dos próprios dados', async () => {
    const data = await (await rpc('membro-a', 'export_my_data')).json();
    const mine = data.igrejas[0].celulas.filter((c) => c.celula.startsWith(tag));
    expect(mine.map((c) => c.papel).sort()).toEqual(['lider', 'participante']);
    expect(mine.find((c) => c.papel === 'lider').presencas).toEqual([day1]);
    expect(JSON.stringify(data)).not.toContain('Fulano');
  });
});

test.describe('Reforços de segurança (012)', () => {
  test('o admin não grava link "javascript:" nas redes sociais nem logo fora do https, nem pela API', async () => {
    const [before] = await get('adm-a', `churches?select=social,logo_url&id=eq.${church.a}`);
    const patch = (data) => api.patch(rest(`churches?id=eq.${church.a}`), { headers: returning(as['adm-a'].headers), data });
    try {
      for (const bad of ['javascript:alert(document.cookie)', 'JaVaScRiPt:alert(1)', 'http://site.com', 'https://x.com/"><img src=x>', 'data:text/html,oi']) {
        expect((await patch({ social: { site: bad } })).ok(), bad).toBe(false);
      }
      expect((await patch({ logo_url: 'javascript:alert(1)' })).ok()).toBe(false);
      const ok = await patch({ social: { instagram: 'https://instagram.com/igreja_teste' } });
      expect(ok.ok(), await ok.text()).toBe(true);
    } finally {
      await patch({ social: before.social, logo_url: before.logo_url });
    }
  });
});

test.describe('Visitantes (013)', () => {
  const tag = `Visitante ${Date.now().toString(36)}`;
  const anon = { apikey: ANON_KEY, 'Content-Type': 'application/json' };
  const register = (data, h = anon) =>
    api.post(rest('rpc/register_visitor'), {
      headers: h,
      data: { p_church: church.a, p_name: tag, p_phone: '5561999990009', p_email: null, p_first_time: true, p_source: 'amigos', p_wants_contact: true, p_message: 'Oração pela família', p_consent: true, ...data },
    });
  const mine = `visitors?select=id,name,status,notes,member_id&name=like.${encodeURIComponent(tag)}*`;

  test.afterEach(async () => {
    for (const v of await get('adm-a', mine)) {
      if (v.member_id) await api.delete(rest(`members?id=eq.${v.member_id}`), { headers: as['adm-a'].headers });
      await api.delete(rest(`visitors?id=eq.${v.id}`), { headers: as['adm-a'].headers });
    }
  });

  test('quem não tem conta se cadastra; só a liderança da igreja lê, e ela recebe o aviso', async () => {
    const res = await register({});
    expect(res.ok(), await res.text()).toBe(true);
    const [v] = await get('lider-a', mine);
    expect(v).toMatchObject({ name: tag, status: 'novo' });
    for (const who of ['membro-a', 'adm-b', 'sem-igreja']) expect(await get(who, mine), who).toEqual([]);
    const outside = await api.get(rest(mine), { headers: anon });
    if (outside.ok()) expect(await outside.json()).toEqual([]);
    const [n] = await get('lider-a', `notifications?select=title,body,url&dedupe_key=eq.visitante:${v.id}`);
    expect(n).toMatchObject({ title: `Novo visitante: ${tag.split(' ')[0]}`, url: `#/visitantes/${v.id}` });
    expect(n.body).not.toContain('Oração');
    expect(await get('membro-a', `notifications?select=id&dedupe_key=eq.visitante:${v.id}`)).toEqual([]);
  });

  test('sem autorização não grava; o robô (campo escondido) não grava; ninguém grava direto na tabela', async () => {
    expect((await register({ p_consent: false })).ok()).toBe(false);
    expect((await register({ p_website: 'http://spam' })).ok()).toBe(true);
    expect((await register({ p_name: 'x' })).ok()).toBe(false);
    expect(await get('lider-a', mine)).toEqual([]);
    const direct = await api.post(rest('visitors'), {
      headers: as['lider-a'].headers,
      data: { church_id: church.a, name: tag, consent_at: new Date().toISOString() },
    });
    expect(direct.ok()).toBe(false);
  });

  test('a liderança acompanha e cadastra como membro; o membro comum e a outra igreja, não', async () => {
    await register({ p_email: `${Date.now().toString(36)}@visitante.invalid` });
    const [v] = await get('lider-a', mine);
    const patch = (who, data) => api.patch(rest(`visitors?id=eq.${v.id}`), { headers: returning(as[who].headers), data });
    expect(await (await patch('membro-a', { status: 'contatado' })).text()).not.toContain(v.id);
    expect(await (await patch('adm-b', { status: 'contatado' })).text()).not.toContain(v.id);
    expect((await patch('lider-a', { name: 'Outro nome' })).ok()).toBe(false); // só situação e anotações
    const ok = await patch('lider-a', { status: 'acompanhando', notes: 'Liguei, vem domingo' });
    expect(ok.ok(), await ok.text()).toBe(true);
    expect((await rpc('membro-a', 'visitor_to_member', { p_visitor: v.id })).ok()).toBe(false);
    expect((await rpc('adm-b', 'visitor_to_member', { p_visitor: v.id })).ok()).toBe(false);
    const made = await rpc('lider-a', 'visitor_to_member', { p_visitor: v.id });
    expect(made.ok(), await made.text()).toBe(true);
    const memberId = await made.json();
    expect(await get('lider-a', `members?select=name,role,phone&id=eq.${memberId}`)).toEqual([{ name: tag, role: 'membro', phone: '5561999990009' }]);
    expect((await get('lider-a', mine))[0]).toMatchObject({ status: 'membro', member_id: memberId });
  });

  test('com a funcionalidade desligada, o cadastro não abre; a limpeza pede a senha', async () => {
    const res = await api.post(rest('rpc/register_visitor'), {
      headers: anon,
      data: { p_church: church.b, p_name: tag, p_phone: null, p_email: null, p_first_time: true, p_source: null, p_wants_contact: true, p_message: null, p_consent: true },
    });
    // A Teste B tem a funcionalidade ligada: desliga só para este teste.
    expect(res.ok(), await res.text()).toBe(true);
    await api.delete(rest(`visitors?name=eq.${encodeURIComponent(tag)}`), { headers: as['adm-b'].headers });
    const [b] = await get('adm-b', `churches?select=features&id=eq.${church.b}`);
    const setFeatures = (features) => api.patch(rest(`churches?id=eq.${church.b}`), { headers: as['adm-b'].headers, data: { features } });
    expect((await setFeatures({ ...b.features, visitantes: false })).ok()).toBe(true);
    try {
      expect((await api.post(rest('rpc/register_visitor'), { headers: anon, data: { p_church: church.b, p_name: tag, p_phone: null, p_email: null, p_first_time: true, p_source: null, p_wants_contact: true, p_message: null, p_consent: true } })).ok()).toBe(false);
    } finally {
      await setFeatures(b.features);
    }
    expect((await rpc('adm-a', 'clean_visitors', { p_secret: 'errada' })).ok()).toBe(false);
  });
});

test.describe('Devocional e plano de leitura (014)', () => {
  const tag = `Devocional ${Date.now().toString(36)}`;
  // Dias longe de hoje, diferentes a cada rodada (um devocional por dia em cada igreja).
  const offset = Date.now() % 3000;
  const dayFrom = (base, n) => new Date(Date.parse(base) + n * 864e5).toISOString().slice(0, 10);
  const past = dayFrom('2001-01-01', offset);
  const future = dayFrom('2091-01-01', offset);
  const planStart = dayFrom('1995-01-01', offset);
  const mine = `devotionals?select=id,publish_date&title=like.${encodeURIComponent(tag)}*`;
  const write = (who, data) => api.post(rest('devotionals'), { headers: returning(as[who].headers), data });

  test.afterAll(async () => {
    if (!api) return;
    await api.delete(rest(`devotionals?title=like.${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
    await api.delete(rest(`reading_plans?church_id=eq.${church.a}&start_date=eq.${planStart}`), { headers: as['lider-a'].headers });
  });

  test('o pastor e os líderes escrevem; o membro só vê a partir do dia; a outra igreja não vê nada', async () => {
    const base = { church_id: church.a, body: 'Mensagem de teste', verse_book: 'JHN', verse_chapter: 3, verse_from: 16 };
    const old = await write('lider-a', { ...base, title: `${tag} passado`, publish_date: past });
    expect(old.ok(), await old.text()).toBe(true);
    const [p] = await old.json();
    const later = await write('lider-a', { ...base, title: `${tag} futuro`, publish_date: future });
    expect(later.ok(), await later.text()).toBe(true);
    const [f] = await later.json();
    // Um por dia na igreja.
    expect((await write('adm-a', { ...base, title: `${tag} repetido`, publish_date: past })).ok()).toBe(false);
    // O membro comum e a outra igreja não escrevem.
    expect((await write('membro-a', { ...base, title: `${tag} membro`, publish_date: dayFrom(past, 1) })).ok()).toBe(false);
    expect((await write('adm-b', { ...base, title: `${tag} outra`, publish_date: dayFrom(past, 2) })).ok()).toBe(false);
    // Imagem só na pasta da própria igreja.
    const img = { ...base, title: `${tag} imagem`, publish_date: dayFrom(past, 3), image_path: `${church.b}/devocionais/x.jpg` };
    expect((await write('lider-a', img)).ok()).toBe(false);

    expect((await get('lider-a', mine)).map((d) => d.id).sort()).toEqual([p.id, f.id].sort());
    expect((await get('membro-a', mine)).map((d) => d.id)).toEqual([p.id]);
    for (const who of ['adm-b', 'sem-igreja']) expect(await get(who, mine), who).toEqual([]);
    const listed = async (who) => (await (await rpc(who, 'devotional_list', { p_church: church.a })).json()).map((d) => d.id);
    expect(await listed('lider-a')).toEqual(expect.arrayContaining([p.id, f.id]));
    expect(await listed('membro-a')).not.toContain(f.id);
    expect(await listed('adm-b')).toEqual([]);
    const one = async (who, id) => (await rpc(who, 'devotional_list', { p_church: church.a, p_id: id })).json();
    expect((await one('membro-a', p.id)).map((d) => d.id)).toEqual([p.id]);
    expect(await one('membro-a', f.id)).toEqual([]);

    // Ninguém de fora muda ou apaga.
    const patch = (who) => api.patch(rest(`devotionals?id=eq.${p.id}`), { headers: returning(as[who].headers), data: { title: `${tag} mudado` } });
    for (const who of ['membro-a', 'adm-b']) expect(await (await patch(who)).text(), who).not.toContain(p.id);
    const removed = await api.delete(rest(`devotionals?id=eq.${p.id}`), { headers: returning(as['adm-b'].headers) });
    expect(await removed.text()).not.toContain(p.id);
  });

  test('"Amém": só quem é da igreja, só no devocional já publicado; ninguém lê quem marcou', async () => {
    const rows = await get('lider-a', mine);
    const p = rows.find((d) => d.publish_date === past);
    const f = rows.find((d) => d.publish_date === future);
    const amen = await rpc('membro-a', 'devotional_amen', { p_devotional: p.id });
    expect(amen.ok(), await amen.text()).toBe(true);
    expect(await amen.json()).toEqual([{ amens: 1, i_amen: true }]);
    expect((await rpc('membro-a', 'devotional_amen', { p_devotional: f.id })).ok()).toBe(false);
    expect((await rpc('adm-b', 'devotional_amen', { p_devotional: p.id })).ok()).toBe(false);
    const [row] = await (await rpc('lider-a', 'devotional_list', { p_church: church.a, p_id: p.id })).json();
    expect(row).toMatchObject({ amens: 1, i_amen: false });
    const who = await api.get(rest('devotional_amens?select=*'), { headers: as['lider-a'].headers });
    if (who.ok()) expect(await who.json()).toEqual([]);
    expect((await rpc('membro-a', 'devotional_amen', { p_devotional: p.id })).ok()).toBe(true); // desmarca
  });

  test('imagem do devocional: o líder grava na pasta da igreja; o membro e a outra igreja, não', async () => {
    const path = `${church.a}/devocionais/teste-${Date.now()}.png`;
    await expectDenied(await upload('membro-a', 'igrejas', path), 'membro-a');
    await expectDenied(await upload('adm-b', 'igrejas', path), 'adm-b');
    await expectDenied(await upload('lider-a', 'igrejas', `${church.a}/aniversario/teste-${Date.now()}.png`), 'lider-a fora da pasta');
    const ok = await upload('lider-a', 'igrejas', path);
    expect(ok.ok(), await ok.text()).toBe(true);
    await removeFile('lider-a', 'igrejas', path);
  });

  test('plano de leitura: a liderança cria; cada um vê e marca só o próprio progresso', async () => {
    const plan = { church_id: church.a, plan_key: 'evangelhos-30', start_date: planStart, active: false };
    expect((await api.post(rest('reading_plans'), { headers: as['membro-a'].headers, data: plan })).ok()).toBe(false);
    expect((await api.post(rest('reading_plans'), { headers: as['adm-b'].headers, data: plan })).ok()).toBe(false);
    const made = await api.post(rest('reading_plans'), { headers: returning(as['lider-a'].headers), data: plan });
    expect(made.ok(), await made.text()).toBe(true);
    const [{ id }] = await made.json();
    expect(await get('adm-b', `reading_plans?select=id&id=eq.${id}`)).toEqual([]);

    const join = (who, data = {}) => api.post(rest('reading_plan_members'), { headers: as[who].headers, data: { plan_id: id, ...data } });
    const mark = (who, day, data = {}) => api.post(rest('reading_progress'), { headers: as[who].headers, data: { plan_id: id, day, ...data } });
    expect((await join('adm-b')).ok()).toBe(false);
    expect((await join('membro-a', { user_id: as['lider-a'].id })).ok()).toBe(false); // não põe outra pessoa
    for (const who of ['membro-a', 'lider-a']) {
      const res = await join(who);
      expect(res.ok(), `${who}: ${await res.text()}`).toBe(true);
    }
    const first = await mark('membro-a', 1);
    expect(first.ok(), await first.text()).toBe(true);
    expect((await mark('membro-a', 31)).ok()).toBe(false); // o plano tem 30 dias
    expect((await mark('membro-a', 2, { user_id: as['lider-a'].id })).ok()).toBe(false);
    expect((await mark('lider-a', 2)).ok()).toBe(true);
    expect((await mark('adm-b', 3)).ok()).toBe(false);

    expect(await get('membro-a', `reading_progress?select=day&plan_id=eq.${id}`)).toEqual([{ day: 1 }]);
    expect(await get('lider-a', `reading_progress?select=day&plan_id=eq.${id}`)).toEqual([{ day: 2 }]);
    expect(await get('lider-a', `reading_plan_members?select=user_id&plan_id=eq.${id}`)).toEqual([{ user_id: as['lider-a'].id }]);
    expect(await get('adm-b', `reading_progress?select=day&plan_id=eq.${id}`)).toEqual([]);

    // Números: quantos leem para todos; a média só para a liderança; nada para a outra igreja.
    const stats = async (who) => (await (await rpc(who, 'reading_plan_stats', { p_church: church.a })).json()).find((s) => s.plan_id === id);
    expect(await stats('membro-a')).toEqual({ plan_id: id, readers: 2, avg_percent: null });
    expect(await stats('lider-a')).toEqual({ plan_id: id, readers: 2, avg_percent: 3 });
    expect(await stats('adm-b')).toBeUndefined();

    // O membro não muda o plano; vê o próprio progresso no arquivo dos seus dados.
    const changed = await api.patch(rest(`reading_plans?id=eq.${id}`), { headers: returning(as['membro-a'].headers), data: { active: true } });
    expect(await changed.text()).not.toContain(id);
    const data = await (await rpc('membro-a', 'export_my_data')).json();
    const exported = data.planos_de_leitura.find((x) => x.plano === 'Evangelhos em 30 dias' && x.inicio === planStart);
    expect(exported.dias_lidos.map((d) => d.dia)).toEqual([1]);

    expect((await rpc('adm-a', 'deliver_devotional_notifications', { p_secret: 'errada' })).ok()).toBe(false);
  });
});

test.describe('Ministérios e escalas (015)', () => {
  const tag = `Ministerio ${Date.now().toString(36)}`;
  const louvor = `${tag} Louvor`;
  const day = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const date = day(40);
  const ids = {};
  const notes = (who, title) => get(who, `notifications?select=title,body,url&title=eq.${encodeURIComponent(title)}`);

  test.beforeAll(async () => {
    const people = await get('lider-a', 'members?select=id,name&name=in.("Membro da A","Fulano da A")');
    ids.membro = people.find((p) => p.name === 'Membro da A').id;
    ids.fulano = people.find((p) => p.name === 'Fulano da A').id;
    ids.fulanoB = (await get('adm-b', 'members?select=id&name=eq.Fulano%20da%20B'))[0].id;
  });

  test.afterAll(async () => {
    if (!api) return;
    await api.delete(rest(`ministries?name=like.${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
    await api.delete(rest(`visitors?name=like.${encodeURIComponent(tag)}*`), { headers: as['adm-a'].headers });
  });

  test('a liderança cria os ministérios; o membro vê só o nome; a outra igreja não vê nada', async () => {
    const make = (who, data) => api.post(rest('ministries'), { headers: returning(as[who].headers), data: { church_id: church.a, ...data } });
    expect((await make('membro-a', { name: `${tag} membro` })).ok()).toBe(false);
    expect((await make('adm-b', { name: `${tag} outra` })).ok()).toBe(false);
    const made = await make('lider-a', { name: louvor, description: 'Música' });
    expect(made.ok(), await made.text()).toBe(true);
    ids.ministry = (await made.json())[0].id;

    expect(await get('membro-a', `ministries?select=name&id=eq.${ids.ministry}`)).toEqual([{ name: louvor }]);
    for (const who of ['adm-b', 'sem-igreja']) expect(await get(who, `ministries?select=id&id=eq.${ids.ministry}`), who).toEqual([]);
    const overview = async (who) => (await (await rpc(who, 'ministry_overview', { p_church: church.a })).json()).find((m) => m.id === ids.ministry);
    // Quem não é da equipe não vê os líderes nem o tamanho da equipe.
    expect(await overview('membro-a')).toMatchObject({ name: louvor, my_role: null, manage: false, leaders: null, team: null });
    expect(await overview('lider-a')).toMatchObject({ manage: true, team: 0 });
    expect(await overview('adm-b')).toBeUndefined();
    const changed = await api.patch(rest(`ministries?id=eq.${ids.ministry}`), { headers: returning(as['membro-a'].headers), data: { name: `${tag} mudado` } });
    expect(await changed.text()).not.toContain(ids.ministry);
  });

  test('equipe: o líder do ministério (membro comum) põe pessoas, mas não escolhe líderes', async () => {
    const add = (who, member_id, role) => api.post(rest('ministry_members'), { headers: as[who].headers, data: { ministry_id: ids.ministry, member_id, ...(role ? { role } : {}) } });
    expect((await add('membro-a', ids.membro)).ok()).toBe(false); // ainda não lidera
    expect((await add('adm-b', ids.fulanoB)).ok()).toBe(false);
    expect((await add('lider-a', ids.fulanoB)).ok()).toBe(false); // pessoa de outra igreja
    const lead = await add('lider-a', ids.membro, 'lider');
    expect(lead.ok(), await lead.text()).toBe(true);
    expect((await add('membro-a', ids.fulano, 'lider')).ok()).toBe(false);
    const ok = await add('membro-a', ids.fulano);
    expect(ok.ok(), await ok.text()).toBe(true);
    const promote = await api.patch(rest(`ministry_members?ministry_id=eq.${ids.ministry}&member_id=eq.${ids.fulano}`), {
      headers: returning(as['membro-a'].headers),
      data: { role: 'lider' },
    });
    expect(await promote.text()).not.toContain('lider');

    const roster = async (who) => (await (await rpc(who, 'ministry_roster', { p_ministry: ids.ministry })).json()).map((p) => p.name);
    expect(await roster('membro-a')).toEqual(['Membro da A', 'Fulano da A']);
    expect(await roster('adm-b')).toEqual([]);
    expect(await get('adm-b', `ministry_members?select=member_id&ministry_id=eq.${ids.ministry}`)).toEqual([]);
    const found = await (await rpc('membro-a', 'ministry_candidates', { p_ministry: ids.ministry, p_search: 'Líder da' })).json();
    expect(found.map((p) => p.name)).toContain('Líder da A');
    expect(await (await rpc('adm-b', 'ministry_candidates', { p_ministry: ids.ministry, p_search: 'Líder da' })).json()).toEqual([]);
  });

  test('escalas: só quem cuida monta, só com a equipe; o voluntário responde só a própria', async () => {
    const save = (who, data) =>
      rpc(who, 'save_schedule', { p_ministry: ids.ministry, p_id: null, p_date: date, p_time: '19:00', p_title: 'Culto', p_notes: null, ...data });
    const slots = [{ member_id: ids.membro, task: 'Vocal' }, { member_id: ids.fulano, task: 'Teclado' }];
    expect((await save('adm-b', { p_slots: slots })).ok()).toBe(false);
    expect((await save('lider-a', { p_slots: [{ member_id: ids.fulanoB, task: 'x' }] })).ok()).toBe(false);
    expect((await api.post(rest('schedules'), { headers: as['lider-a'].headers, data: { ministry_id: ids.ministry, service_date: date } })).ok()).toBe(false);
    const made = await save('lider-a', { p_slots: slots });
    expect(made.ok(), await made.text()).toBe(true);
    ids.schedule = await made.json();
    expect((await api.post(rest('schedule_slots'), { headers: as['lider-a'].headers, data: { schedule_id: ids.schedule, member_id: ids.fulano } })).ok()).toBe(false);

    // O escalado recebe o aviso; a outra igreja não vê a escala.
    expect(await notes('membro-a', `Você foi escalado: ${louvor}`)).toHaveLength(1);
    const listed = async (who) => (await (await rpc(who, 'ministry_schedules', { p_ministry: ids.ministry })).json()).map((s) => s.id);
    expect(await listed('membro-a')).toEqual([ids.schedule]);
    for (const who of ['adm-b', 'sem-igreja']) {
      expect(await listed(who), who).toEqual([]);
      expect(await get(who, `schedule_slots?select=id&schedule_id=eq.${ids.schedule}`), who).toEqual([]);
    }

    const [mine] = (await (await rpc('membro-a', 'my_schedules', { p_church: church.a })).json()).filter((s) => s.schedule_id === ids.schedule);
    expect(mine).toMatchObject({ ministry_name: louvor, task: 'Vocal', status: 'pendente' });
    const answer = (who, confirm, reason) => rpc(who, 'schedule_answer', { p_slot: mine.slot_id, p_confirm: confirm, p_reason: reason });
    for (const who of ['lider-a', 'adm-b']) expect((await answer(who, true)).ok(), who).toBe(false);
    expect(await (await answer('membro-a', true)).json()).toBe('confirmado');
    expect(await (await answer('membro-a', false, 'Viagem')).json()).toBe('troca');
    // A única líder do ministério pediu a troca: o aviso vai para a liderança da igreja.
    const [swap] = await notes('lider-a', `Pedido de troca: ${louvor}`);
    expect(swap).toMatchObject({ url: `#/ministerios/${ids.ministry}` });
    expect(await notes('membro-a', `Pedido de troca: ${louvor}`)).toEqual([]);
    const slot = (await (await rpc('lider-a', 'ministry_schedules', { p_ministry: ids.ministry })).json())[0].slots.find((p) => p.member_id === ids.membro);
    expect(slot).toMatchObject({ status: 'troca', swap_reason: 'Viagem' });
    expect(await get('lider-a', `schedule_slots?select=status&id=eq.${mine.slot_id}`)).toEqual([{ status: 'troca' }]);
    const direct = await api.patch(rest(`schedule_slots?id=eq.${mine.slot_id}`), { headers: returning(as['membro-a'].headers), data: { status: 'confirmado' } });
    expect(direct.ok()).toBe(false);

    // Mudou o horário: todos voltam a confirmar e recebem o aviso.
    const moved = await save('lider-a', { p_id: ids.schedule, p_time: '18:30', p_slots: slots });
    expect(moved.ok(), await moved.text()).toBe(true);
    expect(await get('lider-a', `schedule_slots?select=status&id=eq.${mine.slot_id}`)).toEqual([{ status: 'pendente' }]);
    expect(await notes('membro-a', `Escala mudou: ${louvor}`)).toHaveLength(1);
    expect((await rpc('adm-a', 'deliver_schedule_reminders', { p_secret: 'errada' })).ok()).toBe(false);
  });

  test('as escalas entram nos próprios dados; quem sai da equipe sai das próximas escalas', async () => {
    const data = await (await rpc('membro-a', 'export_my_data')).json();
    const here = data.igrejas.find((c) => c.ministerios.some((m) => m.ministerio === louvor));
    expect(here.ministerios.find((m) => m.ministerio === louvor).papel).toBe('lider');
    expect(here.escalas.find((e) => e.ministerio === louvor)).toMatchObject({ data: date, funcao: 'Vocal' });

    const out = await api.delete(rest(`ministry_members?ministry_id=eq.${ids.ministry}&member_id=eq.${ids.membro}`), { headers: returning(as['lider-a'].headers) });
    expect(out.ok(), await out.text()).toBe(true);
    const mine = await (await rpc('membro-a', 'my_schedules', { p_church: church.a })).json();
    expect(mine.filter((s) => s.schedule_id === ids.schedule)).toEqual([]);
    const removed = await api.delete(rest(`schedules?id=eq.${ids.schedule}`), { headers: returning(as['adm-b'].headers) });
    expect(await removed.text()).not.toContain(ids.schedule);
  });

  test('visitantes: a equipe do ministério marcado recebe o aviso e acompanha; apagar continua com a liderança', async () => {
    const made = await api.post(rest('ministries'), {
      headers: returning(as['lider-a'].headers),
      data: { church_id: church.a, name: `${tag} Acolhimento`, receives_visitors: true },
    });
    expect(made.ok(), await made.text()).toBe(true);
    const [acolhimento] = await made.json();
    // Só um ministério por igreja recebe os visitantes.
    const second = await api.post(rest('ministries'), { headers: as['lider-a'].headers, data: { church_id: church.a, name: `${tag} Outro`, receives_visitors: true } });
    expect(second.ok()).toBe(false);
    const team = await api.post(rest('ministry_members'), { headers: as['lider-a'].headers, data: { ministry_id: acolhimento.id, member_id: ids.membro } });
    expect(team.ok(), await team.text()).toBe(true);
    expect(await get('membro-a', `members?select=visitor_team&user_id=eq.${as['membro-a'].id}`)).toEqual([{ visitor_team: true }]);

    const anon = { apikey: ANON_KEY, 'Content-Type': 'application/json' };
    const reg = await api.post(rest('rpc/register_visitor'), {
      headers: anon,
      data: { p_church: church.a, p_name: `${tag} Visitante`, p_phone: null, p_email: null, p_first_time: true, p_source: null, p_wants_contact: true, p_message: null, p_consent: true },
    });
    expect(reg.ok(), await reg.text()).toBe(true);
    const [v] = await get('membro-a', `visitors?select=id,status&name=eq.${encodeURIComponent(`${tag} Visitante`)}`);
    expect(v).toMatchObject({ status: 'novo' });
    expect(await get('membro-a', `notifications?select=id&dedupe_key=eq.visitante:${v.id}`)).toHaveLength(1);
    expect(await get('lider-a', `notifications?select=id&dedupe_key=eq.visitante:${v.id}`)).toEqual([]);
    expect(await get('lider-a', `visitors?select=id&id=eq.${v.id}`)).toHaveLength(1); // a liderança continua vendo
    expect(await get('adm-b', `visitors?select=id&id=eq.${v.id}`)).toEqual([]);

    const patch = await api.patch(rest(`visitors?id=eq.${v.id}`), { headers: returning(as['membro-a'].headers), data: { status: 'contatado', notes: 'Liguei' } });
    expect(await patch.text()).toContain('contatado');
    const del = await api.delete(rest(`visitors?id=eq.${v.id}`), { headers: returning(as['membro-a'].headers) });
    expect(await del.text()).not.toContain(v.id);
    expect((await rpc('membro-a', 'visitor_to_member', { p_visitor: v.id })).ok()).toBe(false);

    // Fora da equipe, não vê mais.
    await api.delete(rest(`ministries?id=eq.${acolhimento.id}`), { headers: as['lider-a'].headers });
    expect(await get('membro-a', `visitors?select=id&id=eq.${v.id}`)).toEqual([]);
    expect(await get('membro-a', `members?select=visitor_team&user_id=eq.${as['membro-a'].id}`)).toEqual([{ visitor_team: false }]);
  });
});

test.describe('Inscrição em eventos (016)', () => {
  const title = `Retiro ${Date.now().toString(36)}`;
  const starts = new Date(Date.now() + 30 * 864e5).toISOString();
  let id;
  const summary = async (who) => (await (await rpc(who, 'event_registration_summary', { p_church: church.a })).json()).find((r) => r.event_id === id);
  const register = (who) => rpc(who, 'event_register', { p_event: id });
  const setEvent = (data) => api.patch(rest(`events?id=eq.${id}`), { headers: returning(as['lider-a'].headers), data });
  const notes = (who, t) => get(who, `notifications?select=title,body&title=eq.${encodeURIComponent(t)}`);

  test.afterAll(async () => {
    if (api) await api.delete(rest(`events?title=like.${encodeURIComponent(title)}*`), { headers: as['lider-a'].headers });
  });

  test('a liderança abre inscrições só em evento que não se repete', async () => {
    const make = (data) => api.post(rest('events'), { headers: returning(as['lider-a'].headers), data: { church_id: church.a, starts_at: starts, ...data } });
    expect((await make({ title: `${title} semanal`, repeat_weekly: true, registration: true })).ok()).toBe(false);
    const made = await make({ title, registration: true, capacity: 1 });
    expect(made.ok(), await made.text()).toBe(true);
    id = (await made.json())[0].id;
    const changed = await api.patch(rest(`events?id=eq.${id}`), { headers: returning(as['membro-a'].headers), data: { capacity: 99 } });
    expect(await changed.text()).not.toContain(id);
  });

  test('vaga garantida pelo banco: o primeiro confirma, os outros vão para a fila; a outra igreja não entra', async () => {
    expect(await (await register('membro-a')).json()).toBe('confirmada');
    expect(await (await register('membro-a')).json()).toBe('confirmada'); // de novo: nada muda
    expect(await (await register('lider-a')).json()).toBe('espera');
    expect(await (await register('adm-a')).json()).toBe('espera');
    for (const who of ['adm-b', 'sem-igreja']) {
      expect((await register(who)).ok(), who).toBe(false);
      expect(await summary(who), who).toBeUndefined();
    }
    const direct = await api.post(rest('event_registrations'), { headers: as['lider-a'].headers, data: { event_id: id, member_id: '00000000-0000-0000-0000-000000000000', status: 'confirmada' } });
    expect(direct.ok()).toBe(false);

    expect(await summary('membro-a')).toMatchObject({ capacity: 1, confirmed: 1, waiting: 2, my_status: 'confirmada', my_position: null, open: true });
    expect(await summary('adm-a')).toMatchObject({ my_status: 'espera', my_position: 2 });
    expect(await notes('membro-a', `Inscrição confirmada: ${title}`)).toHaveLength(1);
    expect((await notes('lider-a', `Lista de espera: ${title}`))[0].body).toContain('número 1');
  });

  test('só a liderança vê a lista de inscritos; cada um lê só a própria inscrição', async () => {
    const names = async (who) => (await (await rpc(who, 'event_registrants', { p_event: id })).json()).map((r) => `${r.name}:${r.status}`);
    expect(await names('lider-a')).toEqual(['Membro da A:confirmada', 'Líder da A:espera', 'Admin da A:espera']);
    for (const who of ['membro-a', 'adm-b']) expect(await names(who), who).toEqual([]);
    expect(await get('membro-a', `event_registrations?select=status&event_id=eq.${id}`)).toEqual([{ status: 'confirmada' }]);
    expect(await get('lider-a', `event_registrations?select=id&event_id=eq.${id}`)).toHaveLength(3);
    expect(await get('adm-b', `event_registrations?select=id&event_id=eq.${id}`)).toEqual([]);
    const data = await (await rpc('membro-a', 'export_my_data')).json();
    expect(data.inscricoes_em_eventos.find((r) => r.evento === title)).toMatchObject({ situacao: 'confirmada' });
  });

  test('a fila anda sozinha: alguém cancela, a liderança aumenta as vagas ou tira alguém', async () => {
    const out = await rpc('membro-a', 'event_unregister', { p_event: id });
    expect(out.ok(), await out.text()).toBe(true);
    expect(await summary('lider-a')).toMatchObject({ my_status: 'confirmada', confirmed: 1, waiting: 1 });
    expect(await summary('adm-a')).toMatchObject({ my_status: 'espera', my_position: 1 });
    expect(await notes('lider-a', `Abriu uma vaga: ${title}`)).toHaveLength(1);

    expect((await setEvent({ capacity: 3 })).ok()).toBe(true);
    expect(await summary('adm-a')).toMatchObject({ my_status: 'confirmada' });

    const [adm] = (await (await rpc('lider-a', 'event_registrants', { p_event: id })).json()).filter((r) => r.name === 'Admin da A');
    for (const who of ['membro-a', 'adm-b']) expect((await rpc(who, 'event_registration_remove', { p_registration: adm.id })).ok(), who).toBe(false);
    const removed = await rpc('lider-a', 'event_registration_remove', { p_registration: adm.id });
    expect(removed.ok(), await removed.text()).toBe(true);
    expect((await summary('adm-a')).my_status).toBeNull();
    expect(await notes('adm-a', `Inscrição cancelada: ${title}`)).toHaveLength(1);
  });

  test('sem lista de espera, esgotou; depois do prazo, encerrou; o e-mail pede a senha', async () => {
    expect((await setEvent({ capacity: 1, waitlist: false })).ok()).toBe(true);
    const full = await register('membro-a');
    expect(full.ok()).toBe(false);
    expect(await full.text()).toContain('As vagas acabaram');
    expect((await setEvent({ capacity: null, registration_until: new Date(Date.now() - 3600e3).toISOString() })).ok()).toBe(true);
    const closed = await register('membro-a');
    expect(closed.ok()).toBe(false);
    expect(await closed.text()).toContain('encerradas');
    expect((await summary('membro-a')).open).toBe(false);
    expect((await rpc('adm-a', 'claim_registration_emails', { p_secret: 'errada' })).ok()).toBe(false);
  });
});

test.describe('Check-in do ministério infantil (017)', () => {
  const tag = `Crianca ${Date.now().toString(36)}`;
  const ids = {};
  const child = (who, data) => api.post(rest('children'), { headers: returning(as[who].headers), data: { church_id: church.a, ...data } });
  const roster = async (who) => (await (await rpc(who, 'kids_roster', { p_church: church.a })).json()).filter((k) => k.name.startsWith(tag));

  test.beforeAll(async () => {
    const people = await get('lider-a', 'members?select=id,name&name=in.("Membro da A","Fulano da A")');
    ids.membro = people.find((p) => p.name === 'Membro da A').id;
    ids.fulano = people.find((p) => p.name === 'Fulano da A').id;
  });

  test.afterAll(async () => {
    if (!api) return;
    await api.delete(rest(`children?name=like.${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
    await api.delete(rest(`ministries?name=like.${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  });

  test('o responsável cadastra o filho; só ele, a equipe e a liderança veem; a outra igreja, não', async () => {
    const made = await child('membro-a', { name: `${tag} Ana`, birth_date: '2019-03-10', care_notes: 'Alergia a amendoim', guardian_member_id: ids.membro });
    expect(made.ok(), await made.text()).toBe(true);
    ids.ana = (await made.json())[0].id;
    // Não cadastra filho em nome de outra pessoa, nem criança "de recepção" sem ser da equipe.
    expect((await child('membro-a', { name: `${tag} Outro`, guardian_member_id: ids.fulano })).ok()).toBe(false);
    expect((await child('membro-a', { name: `${tag} Recepção`, guardian_name: 'Maria' })).ok()).toBe(false);
    expect((await child('adm-b', { name: `${tag} B`, guardian_name: 'Maria' })).ok()).toBe(false);

    const sees = async (who) => (await get(who, `children?select=name&id=eq.${ids.ana}`)).length;
    expect(await sees('membro-a')).toBe(1);
    expect(await sees('lider-a')).toBe(1);
    for (const who of ['adm-b', 'sem-igreja']) expect(await sees(who), who).toBe(0);
    expect((await roster('lider-a')).map((k) => k.guardian)).toEqual(['Membro da A']);
    for (const who of ['membro-a', 'adm-b']) expect(await roster(who), who).toEqual([]);
    // Ninguém troca o responsável.
    const moved = await api.patch(rest(`children?id=eq.${ids.ana}`), { headers: as['lider-a'].headers, data: { guardian_member_id: ids.fulano } });
    expect(moved.ok()).toBe(false);
  });

  test('só a equipe faz a entrada; a retirada só sai com o código certo', async () => {
    const checkin = (who) => rpc(who, 'kids_checkin', { p_child: ids.ana, p_room: 'Kids' });
    for (const who of ['membro-a', 'adm-b']) expect((await checkin(who)).ok(), who).toBe(false);
    const res = await checkin('lider-a');
    expect(res.ok(), await res.text()).toBe(true);
    const [{ checkin_id, code, room_name }] = await res.json();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(room_name).toBe('Kids');
    expect((await checkin('lider-a')).ok()).toBe(false); // já está no infantil
    expect((await api.post(rest('kids_checkins'), { headers: as['lider-a'].headers, data: { church_id: church.a, child_id: ids.ana, code: 'AAAA' } })).ok()).toBe(false);

    // O responsável vê a entrada com o código e recebe o aviso; a outra igreja não vê nada.
    expect(await get('membro-a', `kids_checkins?select=code&child_id=eq.${ids.ana}`)).toEqual([{ code }]);
    expect(await get('adm-b', `kids_checkins?select=code&child_id=eq.${ids.ana}`)).toEqual([]);
    const [n] = await get('membro-a', `notifications?select=body&dedupe_key=eq.infantil:${checkin_id}:entrada`);
    expect(n.body).toContain(code);

    const lookup = async (who, c) => (await (await rpc(who, 'kids_lookup_code', { p_church: church.a, p_code: c })).json()).map((x) => x.checkin_id);
    expect(await lookup('lider-a', code.toLowerCase())).toEqual([checkin_id]);
    for (const who of ['membro-a', 'adm-b']) expect(await lookup(who, code), who).toEqual([]);

    const out = (who, c) => rpc(who, 'kids_checkout', { p_checkin: checkin_id, p_code: c });
    const wrong = await out('lider-a', code === 'ZZZZ' ? 'YYYY' : 'ZZZZ');
    expect(wrong.ok()).toBe(false);
    expect(await wrong.text()).toContain('não confere');
    expect((await out('membro-a', code)).ok()).toBe(false);
    const ok = await out('lider-a', code);
    expect(ok.ok(), await ok.text()).toBe(true);
    expect((await out('lider-a', code)).ok()).toBe(false); // já foi retirado
    expect(await get('membro-a', `notifications?select=id&dedupe_key=eq.infantil:${checkin_id}:saida`)).toHaveLength(1);
  });

  test('a equipe do ministério marcado faz o check-in e cadastra na recepção; desmarcado, não faz mais', async () => {
    const made = await api.post(rest('ministries'), { headers: returning(as['lider-a'].headers), data: { church_id: church.a, name: `${tag} Infantil`, kids_checkin: true } });
    expect(made.ok(), await made.text()).toBe(true);
    const [mi] = await made.json();
    const second = await api.post(rest('ministries'), { headers: as['lider-a'].headers, data: { church_id: church.a, name: `${tag} Outro`, kids_checkin: true } });
    expect(second.ok()).toBe(false); // só um por igreja
    const team = await api.post(rest('ministry_members'), { headers: as['lider-a'].headers, data: { ministry_id: mi.id, member_id: ids.membro } });
    expect(team.ok(), await team.text()).toBe(true);
    expect(await get('membro-a', `members?select=kids_team&user_id=eq.${as['membro-a'].id}`)).toEqual([{ kids_team: true }]);

    const desk = await child('membro-a', { name: `${tag} Recepção`, guardian_name: 'Maria Visitante', guardian_phone: '5561999990007' });
    expect(desk.ok(), await desk.text()).toBe(true);
    const [{ id: deskId }] = await desk.json();
    expect((await roster('membro-a')).map((k) => k.name).sort()).toEqual([`${tag} Ana`, `${tag} Recepção`]);
    const res = await rpc('membro-a', 'kids_checkin', { p_child: deskId, p_room: null });
    expect(res.ok(), await res.text()).toBe(true);
    // Apagar a criança: só o responsável ou a liderança.
    const del = await api.delete(rest(`children?id=eq.${deskId}`), { headers: returning(as['membro-a'].headers) });
    expect(await del.text()).not.toContain(deskId);

    await api.delete(rest(`ministries?id=eq.${mi.id}`), { headers: as['lider-a'].headers });
    expect(await roster('membro-a')).toEqual([]);
    expect((await rpc('membro-a', 'kids_checkin', { p_child: deskId, p_room: null })).ok()).toBe(false);
  });

  test('os filhos entram nos próprios dados; as salas são da liderança; a limpeza pede a senha', async () => {
    const data = await (await rpc('membro-a', 'export_my_data')).json();
    const ana = data.filhos.find((k) => k.nome === `${tag} Ana`);
    expect(ana).toMatchObject({ alergias_e_cuidados: 'Alergia a amendoim' });
    expect(ana.entradas_no_infantil).toHaveLength(1);

    const roomName = `${tag} Sala`;
    expect((await api.post(rest('kids_rooms'), { headers: as['membro-a'].headers, data: { church_id: church.a, name: roomName } })).ok()).toBe(false);
    expect((await api.post(rest('kids_rooms'), { headers: as['adm-b'].headers, data: { church_id: church.a, name: roomName } })).ok()).toBe(false);
    const room = await api.post(rest('kids_rooms'), { headers: returning(as['lider-a'].headers), data: { church_id: church.a, name: roomName, min_age: 3, max_age: 5 } });
    expect(room.ok(), await room.text()).toBe(true);
    const [{ id: roomId }] = await room.json();
    expect(await get('membro-a', `kids_rooms?select=name&id=eq.${roomId}`)).toEqual([{ name: roomName }]);
    expect(await get('adm-b', `kids_rooms?select=name&id=eq.${roomId}`)).toEqual([]);
    await api.delete(rest(`kids_rooms?id=eq.${roomId}`), { headers: as['lider-a'].headers });
    expect((await rpc('adm-a', 'clean_kids', { p_secret: 'errada' })).ok()).toBe(false);
  });
});

test.describe('Carteirinha digital (018)', () => {
  const anon = { apikey: ANON_KEY, 'Content-Type': 'application/json' };
  const verify = async (token) => {
    const res = await api.post(rest('rpc/verify_member_card'), { headers: anon, data: { p_token: token } });
    expect(res.ok(), await res.text()).toBe(true);
    return res.json();
  };
  const own = async (who) => (await get(who, `members?select=id,card_token,member_since&user_id=eq.${as[who].id}`))[0];

  test.afterAll(async () => {
    if (!api) return;
    const adm = await own('adm-a');
    await api.patch(rest(`members?id=eq.${adm.id}`), { headers: as['lider-a'].headers, data: { member_since: null } });
  });

  test('cada um lê só o próprio código; "membro desde" é da liderança; o código só muda pela função', async () => {
    const me = await own('membro-a');
    expect(me.card_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await get('membro-a', 'members?select=card_token')).toHaveLength(1); // só o próprio cadastro
    expect(await get('adm-b', `members?select=card_token&id=eq.${me.id}`)).toEqual([]);

    const patch = (who, data) => api.patch(rest(`members?id=eq.${me.id}`), { headers: returning(as[who].headers), data });
    expect((await patch('membro-a', { member_since: '2000-01-01' })).ok()).toBe(false);
    expect((await patch('membro-a', { card_token: '00000000-0000-4000-8000-000000000000' })).ok()).toBe(false);
    const adm = await own('adm-a');
    const ok = await api.patch(rest(`members?id=eq.${adm.id}`), { headers: returning(as['lider-a'].headers), data: { member_since: '2015-04-12' } });
    expect(ok.ok(), await ok.text()).toBe(true);
    expect((await own('adm-a')).member_since).toBe('2015-04-12');
    const data = await (await rpc('adm-a', 'export_my_data')).json();
    const here = data.igrejas.find((c) => c.endereco_no_app === '/i/teste-a/');
    expect(here.cadastro.membro_desde).toBe('2015-04-12');
  });

  test('a conferência pública só responde pelo código exato e mostra só o que está na carteirinha', async () => {
    const me = await own('adm-a');
    const [r] = await verify(me.card_token);
    // Só o que está na carteirinha: nada de e-mail, telefone, aniversário ou foto.
    expect(Object.keys(r).sort()).toEqual(['active', 'church_name', 'church_slug', 'logo_url', 'member_since', 'name', 'primary_color', 'role']);
    expect(r).toMatchObject({ church_slug: 'teste-a', name: 'Admin da A', role: 'admin', member_since: '2015-04-12', active: true });
    expect(await verify('00000000-0000-4000-8000-000000000000')).toEqual([]);
    // Quem não aceitou participar (sem conta no app) não aparece como ativo.
    const [fulano] = await get('lider-a', 'members?select=card_token&name=eq.Fulano%20da%20A');
    expect((await verify(fulano.card_token))[0].active).toBe(false);
  });

  test('gerar um QR novo invalida o anterior; a outra igreja não troca o código de ninguém', async () => {
    const before = (await own('adm-a')).card_token;
    expect((await rpc('adm-b', 'rotate_card_token', { p_church: church.a })).ok()).toBe(false);
    const res = await rpc('adm-a', 'rotate_card_token', { p_church: church.a });
    expect(res.ok(), await res.text()).toBe(true);
    const after = await res.json();
    expect(after).not.toBe(before);
    expect(await verify(before)).toEqual([]);
    expect((await verify(after))[0].active).toBe(true);
  });

  test('com a carteirinha desligada, nenhuma da igreja é reconhecida', async () => {
    const me = await own('adm-b');
    expect((await verify(me.card_token)).length).toBe(1);
    const [b] = await get('adm-b', `churches?select=features&id=eq.${church.b}`);
    const setFeatures = (features) => api.patch(rest(`churches?id=eq.${church.b}`), { headers: as['adm-b'].headers, data: { features } });
    expect((await setFeatures({ ...b.features, carteirinha: false })).ok()).toBe(true);
    try {
      expect(await verify(me.card_token)).toEqual([]);
      expect((await rpc('adm-b', 'rotate_card_token', { p_church: church.b })).ok()).toBe(false);
    } finally {
      await setFeatures(b.features);
    }
  });
});

test.describe('Relatórios (019)', () => {
  const report = (who, data = {}) => rpc(who, 'church_report', { p_church: church.a, p_from: '2026-01-01', p_to: '2026-03-31', ...data });
  const tag = `Relatorio ${Date.now().toString(36)}`;

  test.afterAll(async () => {
    if (api) await api.delete(rest(`members?name=eq.${encodeURIComponent(tag)}`), { headers: as['adm-a'].headers });
  });

  test('só a liderança da própria igreja vê; período de até 400 dias', async () => {
    for (const who of ['membro-a', 'adm-b', 'sem-igreja']) expect((await report(who)).ok(), who).toBe(false);
    const ok = await report('lider-a');
    expect(ok.ok(), await ok.text()).toBe(true);
    const r = await ok.json();
    for (const key of ['membros', 'visitantes', 'celulas', 'infantil', 'escalas', 'inscricoes', 'participacao']) expect(r, key).toHaveProperty(key);
    expect((await report('lider-a', { p_from: '2024-01-01', p_to: '2026-01-01' })).ok()).toBe(false);
    // Só totais: nenhum e-mail ou telefone no relatório.
    expect(JSON.stringify(r)).not.toMatch(/@|5561999990001/);
  });

  test('os números conferem com o cadastro', async () => {
    const made = await api.post(rest('members'), { headers: as['lider-a'].headers, data: { church_id: church.a, name: tag, member_since: '2001-05-10' } });
    expect(made.ok(), await made.text()).toBe(true);
    const r = await (await report('lider-a', { p_from: '2001-05-01', p_to: '2001-06-30' })).json();
    expect(r.membros.novos).toBe(1);
    expect(r.membros.novos_por_mes).toEqual([{ mes: '2001-05', total: 1 }, { mes: '2001-06', total: 0 }]);
    expect(r.membros.ativos).toBeGreaterThanOrEqual(4); // as contas de teste e os cadastros sem conta
  });

  test('com os relatórios desligados, ninguém calcula', async () => {
    const [b] = await get('adm-b', `churches?select=features&id=eq.${church.b}`);
    const setFeatures = (features) => api.patch(rest(`churches?id=eq.${church.b}`), { headers: as['adm-b'].headers, data: { features } });
    expect((await rpc('adm-b', 'church_report', { p_church: church.b, p_from: '2026-01-01', p_to: '2026-01-31' })).ok()).toBe(true);
    expect((await setFeatures({ ...b.features, relatorios: false })).ok()).toBe(true);
    try {
      expect((await rpc('adm-b', 'church_report', { p_church: church.b, p_from: '2026-01-01', p_to: '2026-01-31' })).ok()).toBe(false);
    } finally {
      await setFeatures(b.features);
    }
  });
});

test.describe('Galeria de fotos (020)', () => {
  const tag = `Galeria ${Date.now().toString(36)}`;
  const ids = {};
  const webp = (bytes) =>
    Buffer.concat([Buffer.from('52494646', 'hex'), Buffer.alloc(4), Buffer.from('57454250', 'hex'), Buffer.alloc(Math.max(0, bytes - 12))]);
  const put = (who, path, bytes = 2000) =>
    api.post(`${SUPABASE_URL}/storage/v1/object/galeria/${path}`, { headers: { ...as[who].headers, 'Content-Type': 'image/webp' }, data: webp(bytes) });
  const sign = (who, path) => api.post(`${SUPABASE_URL}/storage/v1/object/sign/galeria/${path}`, { headers: as[who].headers, data: { expiresIn: 60 } });
  const album = (who, church_id, title) => api.post(rest('gallery_albums'), { headers: returning(as[who].headers), data: { church_id, title } });

  test.afterAll(async () => {
    if (!api) return;
    for (const [who, c] of [['lider-a', church.a], ['adm-b', church.b]]) {
      const rows = await get(who, `gallery_photos?select=path,mini_path&church_id=eq.${c}&album_id=in.(${[ids.album, ids.other, ids.full].filter(Boolean).join(',') || '00000000-0000-0000-0000-000000000000'})`);
      const prefixes = rows.flatMap((p) => [p.path, p.mini_path]);
      for (let i = 0; i < prefixes.length; i += 100)
        await api.delete(`${SUPABASE_URL}/storage/v1/object/galeria`, { headers: as[who].headers, data: { prefixes: prefixes.slice(i, i + 100) } });
      await api.delete(rest(`gallery_albums?title=like.${encodeURIComponent(tag)}*`), { headers: as[who].headers });
    }
  });

  test('só quem publica cria álbuns e registra fotos; a outra igreja não', async () => {
    expect((await album('membro-a', church.a, `${tag} membro`)).ok()).toBe(false);
    expect((await album('adm-b', church.a, `${tag} outra`)).ok()).toBe(false);
    const made = await album('lider-a', church.a, tag);
    expect(made.ok(), await made.text()).toBe(true);
    ids.album = (await made.json())[0].id;
    ids.other = (await (await album('lider-a', church.a, `${tag} outro`)).json())[0].id;

    for (const who of ['membro-a', 'adm-b']) expect((await rpc(who, 'gallery_add_photo', { p_album: ids.album, p_ext: 'webp' })).ok(), who).toBe(false);
    const res = await rpc('lider-a', 'gallery_add_photo', { p_album: ids.album, p_ext: 'webp' });
    expect(res.ok(), await res.text()).toBe(true);
    const [p] = await res.json();
    Object.assign(ids, { photo: p.photo_id, path: p.path, mini: p.mini_path });
    expect(p.path).toBe(`${church.a}/${ids.album}/${p.photo_id}.webp`);
    expect(p.mini_path).toBe(`${church.a}/${ids.album}/${p.photo_id}-mini.webp`);
    const direct = await api.post(rest('gallery_photos'), { headers: as['lider-a'].headers, data: { church_id: church.a, album_id: ids.album, path: 'x', mini_path: 'y' } });
    expect(direct.ok()).toBe(false);
  });

  test('arquivos: só o caminho registrado, só por quem publica, até 400 KB; só a igreja vê', async () => {
    await expectDenied(await put('membro-a', ids.path), 'membro-a');
    await expectDenied(await put('lider-a', `${church.a}/${ids.album}/qualquer.webp`), 'caminho não registrado');
    expect((await put('lider-a', ids.mini, 500 * 1024)).ok()).toBe(false); // grande demais
    for (const path of [ids.path, ids.mini]) {
      const ok = await put('lider-a', path);
      expect(ok.ok(), await ok.text()).toBe(true);
    }
    expect((await sign('membro-a', ids.path)).ok()).toBe(true);
    for (const who of ['adm-b', 'sem-igreja']) expect((await sign(who, ids.path)).ok(), who).toBe(false);
    expect(await get('adm-b', `gallery_photos?select=id&id=eq.${ids.photo}`)).toEqual([]);
    const listed = async (who) => (await (await rpc(who, 'gallery_album_list', { p_church: church.a })).json()).map((a) => a.id);
    expect(await listed('membro-a')).toContain(ids.album);
    expect(await listed('adm-b')).toEqual([]);
    // A capa precisa ser uma foto do próprio álbum.
    const cover = (album_id) => api.patch(rest(`gallery_albums?id=eq.${album_id}`), { headers: returning(as['lider-a'].headers), data: { cover_photo_id: ids.photo } });
    expect((await cover(ids.other)).ok()).toBe(false);
    expect((await cover(ids.album)).ok()).toBe(true);
    // O membro não apaga fotos.
    const del = await api.delete(rest(`gallery_photos?id=eq.${ids.photo}`), { headers: returning(as['membro-a'].headers) });
    expect(await del.text()).not.toContain(ids.photo);
  });

  test('pedir para tirar a foto avisa quem publica, uma vez por pessoa', async () => {
    const ask = (who) => rpc(who, 'gallery_request_removal', { p_photo: ids.photo, p_reason: 'Apareço nela' });
    expect(await (await ask('membro-a')).json()).toBe(true);
    expect(await (await ask('membro-a')).json()).toBe(false);
    expect((await ask('adm-b')).ok()).toBe(false);
    const n = await get('lider-a', `notifications?select=url&dedupe_key=eq.galeria-retirada:${ids.photo}:${as['membro-a'].id}`);
    expect(n).toEqual([{ url: `#/galeria/${ids.album}/foto/${ids.photo}` }]);
    expect(await get('membro-a', `notifications?select=id&dedupe_key=like.galeria-retirada:${ids.photo}*`)).toEqual([]);
    const data = await (await rpc('lider-a', 'export_my_data')).json();
    expect(data.publicado_por_voce.albuns_da_galeria.map((a) => a.album)).toContain(tag);
    const mine = await (await rpc('membro-a', 'export_my_data')).json();
    expect(mine.pedidos_para_tirar_fotos_da_galeria.map((r) => r.motivo)).toContain('Apareço nela');
  });

  // Pesado (cerca de 300 pedidos ao banco): só roda quando pedido, com TESTES_PESADOS=1.
  test('o limite de 300 fotos por igreja é conferido no banco', async () => {
    test.skip(!process.env.TESTES_PESADOS, 'Teste pesado: rode com TESTES_PESADOS=1');
    test.setTimeout(180_000);
    const made = await album('adm-b', church.b, `${tag} limite`);
    expect(made.ok(), await made.text()).toBe(true);
    ids.full = (await made.json())[0].id;
    const [{ count }] = await get('adm-b', `gallery_photos?select=count&church_id=eq.${church.b}`);
    const add = () => rpc('adm-b', 'gallery_add_photo', { p_album: ids.full, p_ext: 'webp' });
    for (let left = 300 - count; left > 0; left -= 10) {
      const batch = await Promise.all(Array.from({ length: Math.min(10, left) }, add));
      for (const r of batch) expect(r.ok(), await r.text()).toBe(true);
    }
    const over = await add();
    expect(over.ok()).toBe(false);
    expect(await over.text()).toContain('limite de 300 fotos');
    // Apagar o álbum libera o espaço (as fotos registradas saem junto).
    await api.delete(rest(`gallery_albums?id=eq.${ids.full}`), { headers: as['adm-b'].headers });
    ids.full = null;
    expect(await get('adm-b', `gallery_photos?select=count&church_id=eq.${church.b}`)).toEqual([{ count }]);
  });
});

test.describe('Chat (021)', () => {
  // Um segundo membro comum na Teste A (conta "sem-igreja", só durante estes testes).
  const tag = `chat ${Date.now().toString(36)}`;
  const ids = {};
  const start = (who, member, c = church.a) => rpc(who, 'start_conversation', { p_church: c, p_member: member });
  const send = (who, conv, body, extra = {}) =>
    api.post(rest('messages'), { headers: returning(as[who].headers), data: { conversation_id: conv, body, ...extra } });
  const msgs = (who, conv) => get(who, `messages?select=body,church_id,sender_id&conversation_id=eq.${conv}&body=like.*${encodeURIComponent(tag)}*`);
  const setFeatures = async (patch) => {
    const [a] = await get('adm-a', `churches?select=features&id=eq.${church.a}`);
    return api.patch(rest(`churches?id=eq.${church.a}`), { headers: as['adm-a'].headers, data: { features: { ...a.features, ...patch } } });
  };

  test.beforeAll(async () => {
    const people = await get('adm-a', 'members?select=id,name&name=in.("Membro da A","Líder da A","Admin da A")');
    for (const p of people) ids[p.name] = p.id;
    const created = await api.post(rest('members'), {
      headers: returning(as['adm-a'].headers),
      data: { church_id: church.a, name: `Membro temporário ${tag}`, email: 'sem-igreja@teste.igrejaconecta.invalid' },
    });
    expect(created.ok(), await created.text()).toBe(true);
    ids.temp = (await created.json())[0].id;
    await rpc('sem-igreja', 'link_my_account');
    expect((await rpc('sem-igreja', 'respond_to_church', { p_church: church.a, p_accept: true })).ok()).toBe(true);
  });

  test.afterAll(async () => {
    if (!api) return;
    await setFeatures({ chat_membros: false });
    await api.patch(rest(`members?id=eq.${ids['Admin da A']}`), { headers: as['adm-a'].headers, data: { chat_enabled: true } });
    // Sair da igreja apaga o cadastro temporário e as conversas dele.
    await rpc('sem-igreja', 'leave_church', { p_church: church.a });
    if (ids.temp) await api.delete(rest(`members?id=eq.${ids.temp}`), { headers: as['adm-a'].headers });
  });

  test('o membro fala com a liderança; só as duas pessoas leem; ninguém finge ser outra pessoa', async () => {
    const res = await start('membro-a', ids['Líder da A']);
    expect(res.ok(), await res.text()).toBe(true);
    ids.conv = await res.json();
    expect(await (await start('membro-a', ids['Líder da A'])).json()).toBe(ids.conv); // a mesma conversa
    expect(await (await start('lider-a', ids['Membro da A'])).json()).toBe(ids.conv);
    // A outra igreja não abre conversa com quem é da Teste A (nem dizendo que é da própria igreja).
    expect((await start('adm-b', ids['Líder da A'], church.a)).ok()).toBe(false);
    expect((await start('adm-b', ids['Líder da A'], church.b)).ok()).toBe(false);

    const sent = await send('membro-a', ids.conv, `Olá ${tag}`, { church_id: church.b });
    expect(sent.ok(), await sent.text()).toBe(true);
    expect((await sent.json())[0].church_id).toBe(church.a); // a igreja vem sempre da conversa
    expect((await msgs('lider-a', ids.conv)).map((m) => m.body)).toEqual([`Olá ${tag}`]);
    for (const who of ['adm-a', 'adm-b', 'sem-igreja']) {
      expect(await msgs(who, ids.conv), who).toEqual([]);
      expect(await get(who, `conversations?select=id&id=eq.${ids.conv}`), who).toEqual([]);
    }
    // Ninguém escreve na conversa dos outros nem com o nome de outra pessoa.
    expect((await send('adm-a', ids.conv, `intruso ${tag}`)).ok()).toBe(false);
    expect((await send('membro-a', ids.conv, `falso ${tag}`, { sender_id: as['lider-a'].id })).ok()).toBe(false);
    expect((await api.post(rest('conversations'), { headers: as['membro-a'].headers, data: { church_id: church.a, user_a: as['membro-a'].id, user_b: as['adm-a'].id, name_a: 'x', name_b: 'y' } })).ok()).toBe(false);
    expect((await send('membro-a', ids.conv, 'x'.repeat(2001))).ok()).toBe(false);
    const edit = await api.patch(rest(`messages?conversation_id=eq.${ids.conv}`), { headers: returning(as['membro-a'].headers), data: { body: 'editado' } });
    expect(await edit.text()).not.toContain('editado');

    // Não lidas: aparece para a líder; ao abrir, some.
    const row = async () => (await (await rpc('lider-a', 'my_conversations', { p_church: church.a, p_conv: ids.conv })).json())[0];
    expect(await row()).toMatchObject({ unread: true, other_name: 'Membro da A', last_mine: false, can_send: true });
    expect(await (await rpc('lider-a', 'chat_unread_count', { p_church: church.a })).json()).toBeGreaterThanOrEqual(1);
    await rpc('lider-a', 'mark_conversation_read', { p_conv: ids.conv });
    expect((await row()).unread).toBe(false);
    expect(await (await rpc('adm-b', 'my_conversations', { p_church: church.a })).json()).toEqual([]);
  });

  test('membro com membro, só se a igreja liberar', async () => {
    expect((await start('membro-a', ids.temp)).ok()).toBe(false);
    const search = async (who) => (await (await rpc(who, 'chat_contacts', { p_church: church.a, p_search: 'temporário' })).json()).map((p) => p.member_id);
    expect(await search('membro-a')).toEqual([]);
    expect(await search('lider-a')).toContain(ids.temp); // a liderança acha qualquer membro
    expect((await (await rpc('membro-a', 'chat_contacts', { p_church: church.a })).json()).map((p) => p.role)).not.toContain('membro');

    expect((await setFeatures({ chat_membros: true })).ok()).toBe(true);
    try {
      expect(await search('membro-a')).toContain(ids.temp);
      const res = await start('membro-a', ids.temp);
      expect(res.ok(), await res.text()).toBe(true);
      ids.members = await res.json();
      expect((await send('sem-igreja', ids.members, `entre membros ${tag}`)).ok()).toBe(true);
    } finally {
      await setFeatures({ chat_membros: false });
    }
    // Desligado de novo: a conversa entre membros não recebe mais mensagens.
    const blocked = await send('membro-a', ids.members, `depois ${tag}`);
    expect(blocked.ok()).toBe(false);
    expect(await blocked.text()).toContain('só com a liderança');
  });

  test('quem desliga "receber mensagens" não recebe conversa nova nem mensagem, mas responde', async () => {
    const conv = await (await start('membro-a', ids['Admin da A'])).json();
    const off = await api.patch(rest(`members?id=eq.${ids['Admin da A']}`), { headers: as['adm-a'].headers, data: { chat_enabled: false } });
    expect(off.ok(), await off.text()).toBe(true);
    try {
      expect((await start('sem-igreja', ids['Admin da A'])).ok()).toBe(false);
      expect((await (await rpc('membro-a', 'chat_contacts', { p_church: church.a })).json()).map((p) => p.member_id)).not.toContain(ids['Admin da A']);
      const refused = await send('membro-a', conv, `para quem desligou ${tag}`);
      expect(refused.ok()).toBe(false);
      expect(await refused.text()).toContain('desligou o chat');
      expect((await send('adm-a', conv, `resposta ${tag}`)).ok()).toBe(true);
    } finally {
      await api.patch(rest(`members?id=eq.${ids['Admin da A']}`), { headers: as['adm-a'].headers, data: { chat_enabled: true } });
    }
  });

  test('bloquear e denunciar; a denúncia avisa o administrador sem as mensagens', async () => {
    const conv = await (await start('sem-igreja', ids['Líder da A'])).json();
    expect((await send('sem-igreja', conv, `mensagem secreta ${tag}`)).ok()).toBe(true);
    expect((await rpc('lider-a', 'chat_block', { p_conv: conv, p_block: true })).ok()).toBe(true);
    for (const who of ['lider-a', 'sem-igreja']) expect((await send(who, conv, `bloqueada ${tag}`)).ok(), who).toBe(false);
    expect((await rpc('sem-igreja', 'chat_block', { p_conv: conv, p_block: false })).ok()).toBe(false); // só quem bloqueou
    expect((await rpc('adm-a', 'chat_block', { p_conv: conv, p_block: false })).ok()).toBe(false);
    expect((await rpc('lider-a', 'chat_block', { p_conv: conv, p_block: false })).ok()).toBe(true);
    expect((await send('sem-igreja', conv, `de novo ${tag}`)).ok()).toBe(true);

    expect((await rpc('adm-b', 'chat_report', { p_conv: conv, p_reason: 'x' })).ok()).toBe(false);
    const rep = await rpc('sem-igreja', 'chat_report', { p_conv: conv, p_reason: `Motivo ${tag}` });
    expect(rep.ok(), await rep.text()).toBe(true);
    const [n] = await get('adm-a', `notifications?select=title,body&body=like.*${encodeURIComponent(`Motivo ${tag}`)}*`);
    expect(n.title).toBe('Denúncia no chat');
    expect(n.body).toContain('Líder da A');
    expect(n.body).not.toContain('mensagem secreta');
    expect(await msgs('adm-a', conv)).toEqual([]); // o administrador continua sem ler a conversa
    expect((await (await rpc('lider-a', 'my_conversations', { p_church: church.a, p_conv: conv })).json())[0]).toMatchObject({ blocked: true, blocked_by_me: false, can_send: false });
  });

  test('as conversas entram nos próprios dados; quem sai da igreja leva as conversas dela', async () => {
    const data = await (await rpc('membro-a', 'export_my_data')).json();
    const conv = data.conversas_do_chat.find((c) => c.com === 'Líder da A');
    expect(conv.mensagens.map((m) => m.texto)).toContain(`Olá ${tag}`);
    expect(conv.mensagens.find((m) => m.texto === `Olá ${tag}`).de).toBe('você');

    const before = await get('sem-igreja', 'conversations?select=id');
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect((await rpc('sem-igreja', 'leave_church', { p_church: church.a })).ok()).toBe(true);
    ids.temp = null;
    for (const c of before) expect(await get('lider-a', `conversations?select=id&id=eq.${c.id}`)).toEqual([]);
  });
});

test.describe('Notificação do chat (022)', () => {
  // Senha de envio: segredo ENVIO_SECRET no GitHub; no computador, tests/envio-segredo.local.
  const envioSecret = () => {
    if (process.env.ENVIO_SECRET) return process.env.ENVIO_SECRET;
    try {
      return readFileSync(new URL('./envio-segredo.local', import.meta.url), 'utf8').trim();
    } catch {
      return null;
    }
  };
  const tag = `aviso ${Date.now().toString(36)}`;
  const targets = (who, secret, message) => rpc(who, 'message_push_targets', { p_secret: secret, p_message: message });

  test('os aparelhos só saem com a senha de envio; cada mensagem é avisada uma vez; o texto não vai junto', async () => {
    const [lider] = await get('lider-a', `members?select=id&user_id=eq.${as['lider-a'].id}`);
    const conv = await (await rpc('membro-a', 'start_conversation', { p_church: church.a, p_member: lider.id })).json();
    const sent = await api.post(rest('messages'), { headers: returning(as['membro-a'].headers), data: { conversation_id: conv, body: `Texto ${tag}` } });
    expect(sent.ok(), await sent.text()).toBe(true);
    const [msg] = await sent.json();
    // Sem a senha, nem quem está logado nem quem não está consegue.
    for (const who of ['membro-a', 'lider-a']) expect((await targets(who, 'errada', msg.id)).ok(), who).toBe(false);
    const anon = await api.post(rest('rpc/message_push_targets'), {
      headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
      data: { p_secret: 'errada', p_message: msg.id },
    });
    expect(anon.ok()).toBe(false);

    const secret = envioSecret();
    test.skip(!secret, 'Sem a senha de envio neste computador (tests/envio-segredo.local).');
    const first = await targets('membro-a', secret, msg.id);
    expect(first.ok(), await first.text()).toBe(true);
    const rows = await first.json();
    expect(rows).toEqual([]); // igrejas de teste não mandam push
    const [after] = await get('membro-a', `messages?select=pushed_at&id=eq.${msg.id}`);
    expect(after.pushed_at).not.toBeNull(); // já avisada: chamar de novo não gera outro aviso
    expect(await (await targets('membro-a', secret, msg.id)).json()).toEqual([]);
  });
});

test.describe('Chat: lista de contatos (024)', () => {
  test('a lista toda respeita as regras: a liderança vê os membros; o membro, só a liderança; a outra igreja, nada', async () => {
    const all = async (who) => (await (await rpc(who, 'chat_contacts', { p_church: church.a, p_all: true })).json()).map((p) => p.name);
    expect(await all('lider-a')).toContain('Membro da A');
    const member = await all('membro-a');
    expect(member).toContain('Líder da A');
    expect(member).not.toContain('Fulano da A'); // sem conta no app
    const roles = (await (await rpc('membro-a', 'chat_contacts', { p_church: church.a, p_all: true })).json()).map((p) => p.role);
    expect(roles.every((r) => ['admin', 'secretaria', 'lider'].includes(r))).toBe(true);
    for (const who of ['adm-b', 'sem-igreja']) expect(await all(who), who).toEqual([]);
    // A busca antiga (sem p_all) continua igual.
    const search = await (await rpc('lider-a', 'chat_contacts', { p_church: church.a, p_search: 'membro' })).json();
    expect(search.map((p) => p.name)).toContain('Membro da A');
  });
});

test.describe('Apagar conversa (025)', () => {
  const tag = `apagar ${Date.now().toString(36)}`;
  let conv;
  const send = (who, body) => api.post(rest('messages'), { headers: returning(as[who].headers), data: { conversation_id: conv, body } });
  const bodies = async (who) => (await get(who, `messages?select=body&conversation_id=eq.${conv}&body=like.*${encodeURIComponent(tag)}*&order=created_at`)).map((m) => m.body);
  const listed = async (who) => (await (await rpc(who, 'my_conversations', { p_church: church.a })).json()).map((c) => c.id);
  const hide = (who, p_hide = true) => rpc(who, 'hide_conversation', { p_conv: conv, p_hide });

  test.beforeAll(async () => {
    const [admin] = await get('adm-a', 'members?select=id&name=eq.Admin da A');
    conv = await (await rpc('lider-a', 'start_conversation', { p_church: church.a, p_member: admin.id })).json();
  });

  // Conversa da líder com o administrador (a do membro com a líder fica para os testes de tela). No fim, volta para os dois.
  test.afterAll(async () => {
    if (!api || !conv) return;
    for (const who of ['lider-a', 'adm-a']) await hide(who, false);
  });

  test('some só para quem apagou, volta com mensagem nova só com o que é novo, e ninguém apaga a dos outros', async () => {
    expect((await send('adm-a', `antes ${tag}`)).ok()).toBe(true);
    // Quem não está na conversa não apaga nada.
    for (const who of ['membro-a', 'adm-b', 'sem-igreja']) expect((await hide(who)).ok(), who).toBe(true);
    expect(await listed('lider-a')).toContain(conv);
    expect(await bodies('lider-a')).toEqual([`antes ${tag}`]);

    // A líder apaga: some da lista dela, as mensagens antigas também, e conta como lida.
    expect((await hide('lider-a')).ok()).toBe(true);
    expect(await listed('lider-a')).not.toContain(conv);
    expect(await bodies('lider-a')).toEqual([]);
    const [opened] = await (await rpc('lider-a', 'my_conversations', { p_church: church.a, p_conv: conv })).json();
    expect(opened).toMatchObject({ id: conv, last_message: null, unread: false });
    // O administrador continua vendo tudo.
    expect(await listed('adm-a')).toContain(conv);
    expect(await bodies('adm-a')).toEqual([`antes ${tag}`]);

    // Desfazer traz tudo de volta.
    expect((await hide('lider-a', false)).ok()).toBe(true);
    expect(await listed('lider-a')).toContain(conv);
    expect(await bodies('lider-a')).toEqual([`antes ${tag}`]);

    // Apagou de novo e chegou mensagem nova: volta, só com a nova.
    await hide('lider-a');
    await new Promise((r) => setTimeout(r, 50));
    expect((await send('adm-a', `depois ${tag}`)).ok()).toBe(true);
    expect(await listed('lider-a')).toContain(conv);
    expect(await bodies('lider-a')).toEqual([`depois ${tag}`]);
    expect(await bodies('adm-a')).toEqual([`antes ${tag}`, `depois ${tag}`]);
  });
});
