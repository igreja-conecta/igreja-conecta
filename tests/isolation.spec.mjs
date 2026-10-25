// Separação entre igrejas, testada com contas de verdade nas igrejas Teste A e Teste B.
// Cada tentativa de ler ou mexer na outra igreja (ou de passar do próprio papel) precisa falhar.
// Contas: supabase/002_igrejas_de_teste.sql + supabase/usuarios-de-teste.local.sql.
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, rest, configured, testPassword, loginAs, assertCleanTestChurches } from './helpers.mjs';

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
    const me = await memberOf('membro-a');
    for (const who of ['lider-a', 'adm-b', 'membro-a']) {
      expect((await rpc(who, 'unlink_member_account', { p_member: me.id })).ok(), who).toBe(false);
    }
    expect((await rpc('adm-a', 'unlink_member_account', { p_member: me.id })).ok()).toBe(true);
    try {
      expect(await (await rpc('membro-a', 'my_church_ids')).json()).toEqual([]);
    } finally {
      // Entrar de novo liga a conta; aceitar o convite devolve o acesso.
      expect(await (await rpc('membro-a', 'link_my_account')).json()).toBe(1);
      expect((await rpc('membro-a', 'respond_to_church', { p_church: church.a, p_accept: true })).ok()).toBe(true);
    }
    expect(await (await rpc('membro-a', 'my_church_ids')).json()).toEqual([church.a]);
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
    expect(mine.map((r) => r.kind).sort()).toEqual(['aniversario', 'resumo_lideres']);
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
    const endpoint = `https://push.exemplo.invalid/teste-${Date.now()}`;
    const saved = await rpc('membro-a', 'save_push_subscription', { p_endpoint: endpoint, p_p256dh: 'chave', p_auth: 'auth' });
    expect(saved.ok()).toBe(true);
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
    const text = JSON.stringify(data);
    for (const other of ['Fulano', 'Bissexto', 'Admin da A', 'Teste B', '5561999990001']) expect(text, other).not.toContain(other);
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
