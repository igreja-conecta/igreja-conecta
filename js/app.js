import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { CONFIG } from './config.js';
import {
  esc, slugify, isValidSlug, churchSlugFromPath, inkOn, readableOnWhite, normalizePhone, fmtPhone,
  ROLES, isLeaderRole, FEATURES, fold, fmtDate, EMAIL_RE, parseMembersCsv, MEMBERS_CSV_TEMPLATE,
  renderMessage, MESSAGE_FIELDS,
} from './util.js';
import { resizeImage, resizeLogo, makeIconSet } from './images.js';
import { maybeSuggestInstall } from './install.js';
import { pushSupport, pushActive, enablePush, disablePush, syncPush } from './push.js';

const $view = document.getElementById('view');
const configured = !CONFIG.SUPABASE_ANON_KEY.includes('COLE-AQUI');
const sb = configured
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true },
    })
  : null;

// Página atual (a raiz do site ou .../i/<igreja>/), para onde o login volta.
const PAGE_URL = location.origin + location.pathname.replace(/index\.html$/, '');
// Raiz do site: em .../i/<igreja>/ o <base> aponta para ela.
const ROOT_URL = new URL('./', document.baseURI).href;
const SLUG = churchSlugFromPath(location.pathname);
const churchUrl = (slug) => `${ROOT_URL}i/${slug}/`;

const state = {
  user: null,
  platformAdmin: false,
  memberships: [], // { id, role, consent_at, church: {...} } de todas as igrejas da pessoa
  church: null, // igreja desta página
};

// Cadastro da pessoa na igreja desta página (pode estar esperando o aceite).
const myMember = () => state.memberships.find((m) => m.church.id === state.church?.id) ?? null;
const isActiveMember = () => !!myMember()?.consent_at;
const myRole = () => (isActiveMember() ? myMember().role : null);
const featureOn = (key) => !!state.church?.features?.[key];

// ---------------------------------------------------------------------
// Utilidades da tela
// ---------------------------------------------------------------------
let toastTimer;
function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 6000 : 3500);
}

const navigate = (path) => {
  if (location.hash === `#${path}`) render();
  else location.hash = path;
};

function requireLogin(next) {
  if (state.user) return true;
  sessionStorage.setItem('next', next);
  navigate('/entrar');
  return false;
}

// Mensagens do banco em português; o resto vira uma frase genérica.
function errorText(err) {
  const msg = err?.message || String(err);
  if (/rate limit|too many|only request this after/i.test(msg))
    return 'Muitos pedidos de link de acesso em pouco tempo. Espere alguns minutos e tente de novo (ou entre com o Google).';
  if (/provider is not enabled/i.test(msg)) return 'O login com Google ainda não está ligado. Use o link pelo e-mail.';
  if (/duplicate key.*slug/i.test(msg)) return 'Já existe uma igreja com esse endereço.';
  if (/duplicate key.*email/i.test(msg)) return 'Esse e-mail já está no cadastro desta igreja.';
  if (/row-level security|permission denied/i.test(msg)) return 'Você não tem permissão para isso.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Sem conexão. Confira sua internet e tente de novo.';
  return msg;
}

const icon = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>',
  church: '<svg viewBox="0 0 24 24"><path d="M12 2v5M9.5 4.5h5M5 21V11l7-4 7 4v10z"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/></svg>',
  cake: '<svg viewBox="0 0 24 24"><path d="M4 21h16v-7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2z"/><path d="M4 16c2 1.3 4 1.3 5.3 0 1.4 1.3 3.4 1.3 5.4 0 1.3 1.3 3.3 1.3 5.3 0M12 12V8M12 5.5c-.8-.8-.8-1.9 0-3 .8 1.1.8 2.2 0 3"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  megaphone: '<svg viewBox="0 0 24 24"><path d="M3 10v4h3l7 4V6L6 10z"/><path d="M16.5 9a4 4 0 0 1 0 6"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  swap: '<svg viewBox="0 0 24 24"><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v6c0 4.4 3.2 7.8 7.5 9 4.3-1.2 7.5-4.6 7.5-9V6z"/></svg>',
  logout: '<svg viewBox="0 0 24 24"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3a6.5 6.5 0 0 1 3.5 5.7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M7 9V3.5h10V9M7 17H4.5V9h15v8H17"/><path d="M7 14h10v6.5H7z"/></svg>',
};

const SOCIAL = [
  ['instagram', 'Instagram', 'https://instagram.com/suaigreja'],
  ['youtube', 'YouTube', 'https://youtube.com/@suaigreja'],
  ['facebook', 'Facebook', 'https://facebook.com/suaigreja'],
  ['site', 'Site', 'https://suaigreja.com.br'],
];

// ---------------------------------------------------------------------
// Aparência da igreja (cor, nome, logo)
// ---------------------------------------------------------------------
const DEFAULT_COLOR = '#3b5bdb';

function applyBranding() {
  const c = state.church;
  const color = c?.primary_color || DEFAULT_COLOR;
  const root = document.documentElement.style;
  root.setProperty('--brand', color);
  root.setProperty('--brand-ink', inkOn(color));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  document.getElementById('app-name').textContent = c ? c.name : CONFIG.APP_NAME;
  document.getElementById('brand-logo').src = c?.logo_url || 'icons/icon-192.png';
  document.title = c ? c.name : CONFIG.APP_NAME;
}

function renderTabbar(path) {
  const bar = document.getElementById('tabbar');
  if (!state.church || !isActiveMember()) {
    bar.hidden = true;
    document.body.classList.remove('has-tabbar');
    return;
  }
  const tabs = [
    ['/', icon.home, 'Início'],
    ...(isLeaderRole(myRole()) ? [['/membros', icon.users, 'Membros']] : []),
    ['/menu', icon.menu, 'Menu'],
  ];
  const active = ['/', ''].includes(path) ? '/' : path.startsWith('/membros') ? '/membros' : '/menu';
  bar.innerHTML = tabs
    .map(([href, ic, label]) => `<a href="#${href}" class="${href === active ? 'active' : ''}">${ic}${label}</a>`)
    .join('');
  bar.hidden = false;
  document.body.classList.add('has-tabbar');
}

function renderAccountLink() {
  const a = document.getElementById('account-link');
  if (state.user) {
    a.textContent = state.church ? 'Menu' : 'Conta';
    a.href = state.church ? '#/menu' : '#/conta';
    a.hidden = !!state.church && isActiveMember();
  } else {
    a.textContent = 'Entrar';
    a.href = '#/entrar';
    a.hidden = false;
  }
}

// ---------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------
async function loadMemberships() {
  if (!state.user) {
    state.memberships = [];
    state.platformAdmin = false;
    return;
  }
  // Primeiro liga a conta aos cadastros com o mesmo e-mail (convites novos).
  await sb.rpc('link_my_account');
  const [mem, pa] = await Promise.all([
    sb
      .from('members')
      .select('id, role, consent_at, name, church:churches(id, slug, name, logo_url, primary_color)')
      .eq('user_id', state.user.id)
      .eq('status', 'ativo'),
    sb.rpc('is_platform_admin'),
  ]);
  if (mem.error) throw mem.error;
  state.memberships = (mem.data || []).filter((m) => m.church).sort((a, b) => a.church.name.localeCompare(b.church.name));
  state.platformAdmin = !!pa.data;
}

// Pergunta ao Supabase (endereço público) se o login com Google está ligado; guarda a resposta.
let googleCheck;
function googleEnabled() {
  googleCheck ??= fetch(`${CONFIG.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: CONFIG.SUPABASE_ANON_KEY } })
    .then((r) => (r.ok ? r.json() : {}))
    .then((s) => !!s.external?.google)
    .catch(() => false);
  return googleCheck;
}

async function setUser(user) {
  state.user = user;
  await loadMemberships();
  renderAccountLink();
  // Aparelho que já aceitou notificações: garante que a inscrição está nesta conta.
  if (user) syncPush(sb).catch(() => {});
}

// ---------------------------------------------------------------------
// Roteador
// ---------------------------------------------------------------------
const rootRoutes = [
  [/^\/$/, viewRootHome],
  [/^\/entrar$/, viewLogin],
  [/^\/conta$/, viewAccount],
  [/^\/plataforma$/, viewPlatform],
];

const churchRoutes = [
  [/^\/$/, viewChurchHome],
  [/^\/entrar$/, viewLogin],
  [/^\/menu$/, viewMenu],
  [/^\/perfil$/, viewProfile],
  [/^\/config$/, viewSettings],
  [/^\/membros$/, viewMembers],
  [/^\/membros\/novo$/, viewMemberForm],
  [/^\/membros\/importar$/, viewImport],
  [/^\/membros\/([0-9a-f-]{36})$/, viewMemberForm],
  [/^\/privacidade$/, viewChurchPrivacy],
  [/^\/aniversariantes$/, viewBirthdays],
  [/^\/config\/aniversario$/, viewBirthdaySettings],
  [/^\/notificacoes$/, viewNotifications],
];

let renderId = 0;
async function render() {
  const id = ++renderId;
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  const ctx = { params: new URLSearchParams(qs || ''), path, alive: () => id === renderId };
  renderTabbar(path);
  const routes = state.church ? churchRoutes : rootRoutes;
  for (const [re, view] of routes) {
    const m = path.match(re);
    if (!m) continue;
    window.scrollTo(0, 0);
    try {
      await view(ctx, ...m.slice(1));
    } catch (e) {
      if (!ctx.alive()) return;
      console.error(e);
      $view.innerHTML = `
        <div class="empty">
          <h2>Algo deu errado</h2>
          <p>${esc(errorText(e))}</p>
          <button class="btn primary" id="retry">Tentar de novo</button>
        </div>`;
      document.getElementById('retry').onclick = render;
    }
    return;
  }
  $view.innerHTML = `<div class="empty"><h2>Página não encontrada</h2><a class="btn" href="#/">Voltar ao início</a></div>`;
}

// ---------------------------------------------------------------------
// Login (Google ou link mágico no e-mail)
// ---------------------------------------------------------------------
async function viewLogin(ctx) {
  if (state.user) {
    const next = sessionStorage.getItem('next') || '/';
    sessionStorage.removeItem('next');
    return navigate(next);
  }
  $view.innerHTML = `
    <div class="auth">
      <h1>Entrar</h1>
      <p class="hint">Use o mesmo e-mail que você deu à secretaria da sua igreja. Assim o app encontra o seu cadastro.</p>
      <button class="btn google big" id="google" hidden>
        <svg viewBox="0 0 24 24" class="g"><path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.5-2.7c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2.1v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.7 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.1a11 11 0 0 0 0 9.8z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.1-3.1A11 11 0 0 0 2.1 7.1l3.6 2.8C6.6 7.3 9.1 5.4 12 5.4z"/></svg>
        Entrar com Google
      </button>
      <div class="or" id="google-or" hidden><span>ou</span></div>
      <form id="email-form">
        <label>Seu e-mail<input type="email" name="email" required autocomplete="email" placeholder="voce@exemplo.com"></label>
        <button class="btn primary big">Receber link de acesso</button>
      </form>
      <p class="legal">Ao entrar, você concorda com a <a href="privacidade.html">Política de Privacidade</a>.</p>
    </div>`;

  // O botão do Google só aparece quando o login com Google está ligado no Supabase.
  googleEnabled().then((on) => {
    if (!on || !ctx.alive()) return;
    document.getElementById('google').hidden = false;
    document.getElementById('google-or').hidden = false;
  });
  document.getElementById('google').onclick = async () => {
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: PAGE_URL } });
    if (error) toast(errorText(error), 'error');
  };
  document.getElementById('email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = e.target.email.value.trim();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: PAGE_URL } });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    e.target.innerHTML = `<div class="notice"><strong>Confira seu e-mail.</strong><p>Enviamos um link de acesso para ${esc(email)}. Abra-o neste mesmo aparelho e navegador.</p></div>`;
  });
}

async function signOut() {
  await sb.auth.signOut({ scope: 'local' });
  await setUser(null);
  navigate('/');
  render();
}

// ---------------------------------------------------------------------
// Raiz do site: escolher a igreja
// ---------------------------------------------------------------------
function churchRow(c, extra = '') {
  return `
    <a class="church-row" href="${esc(churchUrl(c.slug))}">
      <img src="${esc(c.logo_url || 'icons/icon-192.png')}" alt="" width="44" height="44" style="--c:${esc(c.primary_color || DEFAULT_COLOR)}">
      <span><strong>${esc(c.name)}</strong>${extra}</span>
      ${icon.chevron}
    </a>`;
}

async function viewRootHome() {
  if (!state.user) {
    $view.innerHTML = `
      <section class="hero">
        <img src="icons/icon-192.png" alt="" width="72" height="72">
        <h1>${esc(CONFIG.APP_NAME)}</h1>
        <p>Agenda, avisos e aniversariantes da sua igreja, no celular.</p>
        <a class="btn primary big" href="#/entrar">Entrar</a>
        <p class="hint">Sua igreja ainda não usa? Fale com a liderança dela.</p>
      </section>`;
    return;
  }
  const list = state.memberships;
  // Uma igreja só: vai direto para ela.
  if (list.length === 1 && !state.platformAdmin) {
    location.replace(churchUrl(list[0].church.slug));
    return;
  }
  $view.innerHTML = `
    <div class="page">
      <h1>Suas igrejas</h1>
      ${
        list.length
          ? `<div class="list">${list.map((m) => churchRow(m.church, `<small>${m.consent_at ? esc(ROLES[m.role]) : 'Convite para aceitar'}</small>`)).join('')}</div>`
          : `<div class="notice"><strong>Ainda não encontramos seu cadastro.</strong>
               <p>O e-mail ${esc(state.user.email)} não está no cadastro de nenhuma igreja. Peça à secretaria da sua igreja para cadastrar você com este e-mail e entre de novo.</p></div>`
      }
      ${state.platformAdmin ? `<a class="btn" href="#/plataforma">${icon.shield} Administração da plataforma</a>` : ''}
    </div>`;
}

async function viewAccount() {
  if (!requireLogin('/conta')) return;
  $view.innerHTML = `
    <div class="page">
      <h1>Sua conta</h1>
      <p class="hint">${esc(state.user.email)}</p>
      <div class="list">
        <a class="menu-row" href="#/">${icon.church}<span>Suas igrejas</span>${icon.chevron}</a>
        ${state.platformAdmin ? `<a class="menu-row" href="#/plataforma">${icon.shield}<span>Administração da plataforma</span>${icon.chevron}</a>` : ''}
        <a class="menu-row" href="privacidade.html">${icon.shield}<span>Política de privacidade</span>${icon.chevron}</a>
        <button class="menu-row" id="logout">${icon.logout}<span>Sair</span></button>
      </div>
    </div>`;
  document.getElementById('logout').onclick = signOut;
}

// ---------------------------------------------------------------------
// Administração da plataforma: criar igrejas e definir o administrador de cada uma
// ---------------------------------------------------------------------
async function viewPlatform(ctx) {
  if (!requireLogin('/plataforma')) return;
  if (!state.platformAdmin) {
    $view.innerHTML = `<div class="empty"><h2>Área restrita</h2><p>Só o administrador da plataforma acessa esta página.</p><a class="btn" href="#/">Voltar</a></div>`;
    return;
  }
  const { data: churches, error } = await sb.from('churches').select('id, slug, name, logo_url, primary_color, active, created_at').order('name');
  if (error) throw error;
  if (!ctx.alive()) return;

  $view.innerHTML = `
    <div class="page">
      <h1>Plataforma</h1>
      <h2>Igrejas (${churches.length})</h2>
      <div class="list">
        ${churches
          .map(
            (c) => `
          <div class="platform-church ${c.active ? '' : 'inactive'}" data-id="${c.id}">
            ${churchRow(c, `<small>/i/${esc(c.slug)}/${c.active ? '' : ' · desativada'}</small>`)}
            <div class="row-actions">
              <button class="btn small" data-admin>Definir administrador</button>
              <button class="btn small ${c.active ? 'danger-outline' : ''}" data-active="${c.active ? 'false' : 'true'}">${c.active ? 'Desativar' : 'Reativar'}</button>
            </div>
          </div>`,
          )
          .join('')}
      </div>

      <form id="new-church" class="form card">
        <h2>Nova igreja</h2>
        <label>Nome da igreja<input name="name" required maxlength="80" placeholder="Igreja Batista Central"></label>
        <label>Endereço no app
          <span class="prefix-input"><span>/i/</span><input name="slug" required maxlength="40" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="batista-central"></span>
          <small class="hint">Letras minúsculas, números e hífens. Não dá para mudar depois.</small>
        </label>
        <label>E-mail do administrador da igreja<input name="email" type="email" required placeholder="pastor@exemplo.com"></label>
        <label>Nome do administrador<input name="admin_name" maxlength="120"></label>
        <button class="btn primary">Criar igreja</button>
        <p class="hint">O administrador entra no app com esse e-mail, aceita o convite e configura a igreja. O ícone próprio da igreja aparece na próxima publicação do site.</p>
      </form>
    </div>`;

  const form = document.getElementById('new-church');
  let slugTouched = false;
  form.slug.addEventListener('input', () => (slugTouched = true));
  form.name.addEventListener('input', () => {
    if (!slugTouched) form.slug.value = slugify(form.name.value);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const slug = form.slug.value.trim();
    if (!isValidSlug(slug)) return toast('Endereço inválido: use de 3 a 40 letras minúsculas, números e hífens.', 'error');
    const btn = form.querySelector('button');
    btn.disabled = true;
    const { error } = await sb.rpc('create_church', {
      p_slug: slug,
      p_name: form.name.value.trim(),
      p_admin_email: form.email.value.trim(),
      p_admin_name: form.admin_name.value.trim() || null,
    });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    toast('Igreja criada.');
    await loadMemberships();
    render();
  });

  $view.querySelectorAll('.platform-church').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-admin]').onclick = async () => {
      const email = prompt('E-mail do administrador desta igreja:');
      if (!email) return;
      const { error } = await sb.rpc('set_church_admin', { p_church: id, p_email: email.trim(), p_name: null });
      if (error) return toast(errorText(error), 'error');
      toast(`Pronto. ${email.trim()} já pode entrar e aceitar o convite.`);
      await loadMemberships();
    };
    row.querySelector('[data-active]').onclick = async (e) => {
      const active = e.currentTarget.dataset.active === 'true';
      if (!active && !confirm('Desativar esta igreja? Ninguém mais acessa o app dela até você reativar.')) return;
      const { error } = await sb.rpc('set_church_active', { p_church: id, p_active: active });
      if (error) return toast(errorText(error), 'error');
      render();
    };
  });
}

// ---------------------------------------------------------------------
// Página da igreja
// ---------------------------------------------------------------------
function socialLinks(c) {
  const links = SOCIAL.filter(([k]) => c.social?.[k]).map(
    ([k, label]) => `<a class="chip" href="${esc(c.social[k])}" target="_blank" rel="noopener">${icon.link}${label}</a>`,
  );
  return links.length ? `<div class="chips">${links.join('')}</div>` : '';
}

function aboutCard(c) {
  if (!c.about_text && !c.address && !Object.keys(c.social || {}).length) return '';
  return `
    <section class="card">
      <h2>Sobre a igreja</h2>
      ${c.about_text ? `<p class="pre">${esc(c.about_text)}</p>` : ''}
      ${c.address ? `<p class="meta">${icon.pin}${esc(c.address)}${c.city ? ` · ${esc(c.city)}` : ''}</p>` : ''}
      ${socialLinks(c)}
    </section>`;
}

// Convite: a secretaria cadastrou a pessoa; ela aceita participar pelo app (LGPD).
function viewInvite(m) {
  const c = state.church;
  $view.innerHTML = `
    <div class="page">
      <h1>Bem-vindo, ${esc(m.name.split(' ')[0])}!</h1>
      <div class="card">
        <p><strong>${esc(c.name)}</strong> cadastrou você no app da igreja.</p>
        <p>Para participar, a igreja guarda o seu nome, e-mail e, se você informou, telefone, data de nascimento e foto. Isso serve para os avisos, a agenda e as mensagens de aniversário.</p>
        <ul class="bullets">
          <li>A data de nascimento e o telefone ficam visíveis só para a liderança, a não ser que você autorize no seu cadastro.</li>
          <li>Você pode ver, corrigir, exportar e excluir os seus dados quando quiser.</li>
        </ul>
        <p class="hint">Leia a <a href="privacidade.html" target="_blank">Política de Privacidade</a>${c.privacy_text ? ` e o <a href="#/privacidade">complemento da igreja</a>` : ''}.</p>
        <button class="btn primary big" id="accept">Aceito participar</button>
        <button class="btn link" id="decline">Não sou desta igreja</button>
      </div>
    </div>`;
  document.getElementById('accept').onclick = async () => {
    const { error } = await sb.rpc('respond_to_church', { p_church: c.id, p_accept: true });
    if (error) return toast(errorText(error), 'error');
    await loadMemberships();
    renderAccountLink();
    render();
    maybeSuggestInstall(c);
  };
  document.getElementById('decline').onclick = async () => {
    if (!confirm(`Tirar o seu e-mail do cadastro de ${c.name}?`)) return;
    const { error } = await sb.rpc('respond_to_church', { p_church: c.id, p_accept: false });
    if (error) return toast(errorText(error), 'error');
    toast('Pronto. Seu e-mail saiu do cadastro desta igreja.');
    await loadMemberships();
    location.href = ROOT_URL;
  };
}

async function viewChurchHome() {
  const c = state.church;
  const m = myMember();
  if (m && !m.consent_at) return viewInvite(m);

  const head = `
    <section class="church-hero">
      <img src="${esc(c.logo_url || 'icons/icon-192.png')}" alt="" width="84" height="84">
      <h1>${esc(c.name)}</h1>
      ${c.welcome_text ? `<p>${esc(c.welcome_text)}</p>` : ''}
    </section>`;

  if (!state.user) {
    $view.innerHTML = `
      <div class="page">
        ${head}
        <a class="btn primary big" href="#/entrar">Entrar</a>
        <p class="hint center">Entre com o e-mail que você deu à secretaria da igreja.</p>
        ${aboutCard(c)}
      </div>`;
    return;
  }
  if (!m) {
    $view.innerHTML = `
      <div class="page">
        ${head}
        <div class="notice"><strong>Você ainda não está no cadastro desta igreja.</strong>
          <p>O e-mail ${esc(state.user.email)} não foi encontrado. Peça à secretaria para cadastrar você com este e-mail e entre de novo.</p></div>
        <button class="btn" id="logout">Entrar com outro e-mail</button>
        ${aboutCard(c)}
      </div>`;
    document.getElementById('logout').onclick = signOut;
    return;
  }

  // As telas destes atalhos chegam nas próximas entregas da Fase 1.
  // Agenda e avisos chegam na próxima entrega da Fase 1.
  const shortcuts = [
    ['aniversarios', icon.cake, 'Aniversariantes', '#/aniversariantes'],
    ['agenda', icon.calendar, 'Agenda', null],
    ['avisos', icon.megaphone, 'Avisos', null],
  ].filter(([k]) => featureOn(k));
  $view.innerHTML = `
    <div class="page">
      ${head}
      <div id="week-birthdays"></div>
      ${
        shortcuts.length
          ? `<div class="shortcuts">${shortcuts
              .map(([, ic, label, href]) =>
                href
                  ? `<a class="shortcut" href="${href}">${ic}<span>${label}</span></a>`
                  : `<div class="shortcut soon">${ic}<span>${label}</span><small>Em breve</small></div>`,
              )
              .join('')}</div>`
          : ''
      }
      <div id="push-invite"></div>
      ${aboutCard(c)}
    </div>`;
  if (featureOn('aniversarios')) weekBirthdaysCard(document.getElementById('week-birthdays')).catch(() => {});
  pushInvite(document.getElementById('push-invite')).catch(() => {});
  maybeSuggestInstall(c);
}

async function viewMenu() {
  if (!requireLogin('/menu')) return;
  const m = myMember();
  if (!m?.consent_at) return navigate('/');
  const admin = m.role === 'admin';
  $view.innerHTML = `
    <div class="page">
      <h1>Menu</h1>
      <p class="hint">${esc(state.user.email)} · ${esc(ROLES[m.role])}</p>
      <div class="list">
        <a class="menu-row" href="#/perfil">${icon.user}<span>Meu cadastro</span>${icon.chevron}</a>
        ${isLeaderRole(m.role) ? `<a class="menu-row" href="#/membros">${icon.users}<span>Membros</span>${icon.chevron}</a>` : ''}
        ${admin ? `<a class="menu-row" href="#/config">${icon.gear}<span>Configurar a igreja</span>${icon.chevron}</a>` : ''}
        ${state.memberships.length > 1 || state.platformAdmin ? `<a class="menu-row" href="${esc(ROOT_URL)}">${icon.swap}<span>Trocar de igreja</span>${icon.chevron}</a>` : ''}
        ${featureOn('aniversarios') ? `<a class="menu-row" href="#/aniversariantes">${icon.cake}<span>Aniversariantes do mês</span>${icon.chevron}</a>` : ''}
        <a class="menu-row" href="#/notificacoes">${icon.bell}<span>Notificações neste aparelho</span>${icon.chevron}</a>
        ${admin && featureOn('aniversarios') ? `<a class="menu-row" href="#/config/aniversario">${icon.cake}<span>Mensagem de aniversário</span>${icon.chevron}</a>` : ''}
        <a class="menu-row" href="#/privacidade">${icon.shield}<span>Privacidade</span>${icon.chevron}</a>
        <button class="menu-row" id="logout">${icon.logout}<span>Sair</span></button>
      </div>
    </div>`;
  document.getElementById('logout').onclick = signOut;
}

async function viewChurchPrivacy() {
  const c = state.church;
  $view.innerHTML = `
    <div class="page">
      <h1>Privacidade</h1>
      <p>O app segue a <a href="privacidade.html">Política de Privacidade</a> do ${esc(CONFIG.APP_NAME)}.</p>
      ${c.privacy_text ? `<section class="card"><h2>Complemento de ${esc(c.name)}</h2><p class="pre">${esc(c.privacy_text)}</p></section>` : ''}
      ${c.privacy_email ? `<p>Pedidos sobre os seus dados nesta igreja: <a href="mailto:${esc(c.privacy_email)}">${esc(c.privacy_email)}</a>.</p>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------
// Meu cadastro: o membro edita os próprios dados e as autorizações
// ---------------------------------------------------------------------
async function viewProfile(ctx) {
  if (!requireLogin('/perfil')) return;
  const me = myMember();
  if (!me?.consent_at) return navigate('/');
  const { data: m, error } = await sb.from('members').select('*').eq('id', me.id).single();
  if (error) throw error;
  const photoUrl = m.photo_path ? (await signedPhotos([m.photo_path]))[m.photo_path] : null;
  if (!ctx.alive()) return;
  $view.innerHTML = `
    <form id="profile" class="form page">
      <h1>Meu cadastro</h1>
      <p class="hint">${esc(m.email || state.user.email)} · ${esc(ROLES[m.role])}</p>
      ${photoField(m.name, photoUrl)}
      <label>Nome<input name="name" required minlength="2" maxlength="120" value="${esc(m.name)}"></label>
      <label>Telefone com DDD<input name="phone" type="tel" inputmode="tel" placeholder="(61) 99999-9999" value="${esc(fmtPhone(m.phone))}"></label>
      <label>Data de nascimento<input name="birth_date" type="date" min="1900-01-01" value="${esc(m.birth_date || '')}"></label>
      <fieldset class="card">
        <legend>O que os outros membros veem</legend>
        <p class="hint">A liderança da igreja sempre vê os seus dados. Os outros membros veem só o seu nome, a não ser que você autorize:</p>
        <label class="check"><input type="checkbox" name="show_birthday" ${m.show_birthday ? 'checked' : ''}> Meu aniversário (dia e mês, nunca o ano)</label>
        <label class="check"><input type="checkbox" name="show_phone" ${m.show_phone ? 'checked' : ''}> Meu telefone</label>
      </fieldset>
      <button class="btn primary big">Salvar</button>
      <p class="hint">Para trocar o e-mail, fale com a secretaria da igreja.</p>
    </form>`;
  const form = document.getElementById('profile');
  const photo = bindPhotoField(form, m.name);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phoneRaw = form.phone.value.trim();
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) return toast('Telefone inválido. Use o DDD e o número, como (61) 99999-9999.', 'error');
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    try {
      const patch = {
        name: form.name.value.trim(),
        phone,
        birth_date: form.birth_date.value || null,
        show_birthday: form.show_birthday.checked,
        show_phone: form.show_phone.checked,
      };
      if (photo.file) patch.photo_path = await uploadMemberPhoto(m.church_id, m.id, photo.file);
      else if (photo.removed && m.photo_path) {
        await removeMemberPhotos(m.church_id, m.id);
        patch.photo_path = null;
      }
      const { error: err } = await sb.from('members').update(patch).eq('id', m.id);
      if (err) throw err;
      m.photo_path = patch.photo_path === undefined ? m.photo_path : patch.photo_path;
      photo.reset();
      toast('Cadastro salvo.');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------
// Fotos dos membros: pasta privada <igreja>/<membro>/ com foto.* (1080 px) e mini.* (400 px).
// A tela usa links temporários (1 hora), porque a pasta não é pública.
// ---------------------------------------------------------------------
const miniOf = (path) => path.replace(/\/foto\.(\w+)$/, '/mini.$1');

async function signedPhotos(paths) {
  if (!paths.length) return {};
  const { data, error } = await sb.storage.from('membros').createSignedUrls(paths, 3600);
  if (error) return {};
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

async function removeMemberPhotos(churchId, memberId) {
  const bucket = sb.storage.from('membros');
  const dir = `${churchId}/${memberId}`;
  const { data } = await bucket.list(dir);
  if (data?.length) {
    const { error } = await bucket.remove(data.map((f) => `${dir}/${f.name}`));
    if (error) throw error;
  }
}

async function uploadMemberPhoto(churchId, memberId, file) {
  const [big, small] = await Promise.all([resizeImage(file, 1080, 0.8), resizeImage(file, 400, 0.75)]);
  const ext = big.type === 'image/webp' ? 'webp' : 'jpg';
  await removeMemberPhotos(churchId, memberId);
  const bucket = sb.storage.from('membros');
  const dir = `${churchId}/${memberId}`;
  for (const [name, blob] of [['foto', big], ['mini', small]]) {
    const { error } = await bucket.upload(`${dir}/${name}.${ext}`, blob, { contentType: blob.type, cacheControl: '300', upsert: true });
    if (error) throw error;
  }
  return `${dir}/foto.${ext}`;
}

const initials = (name) =>
  esc(
    String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );

const avatar = (name, url, size = '') =>
  `<span class="avatar ${size}">${url ? `<img src="${esc(url)}" alt="">` : initials(name)}</span>`;

function photoField(name, url) {
  return `
    <div class="photo-field">
      <span id="photo-preview">${avatar(name, url, 'big')}</span>
      <div>
        <label class="btn small">${url ? 'Trocar a foto' : 'Escolher foto'}<input type="file" name="photo" accept="image/*" hidden></label>
        <button type="button" class="btn link small" id="photo-remove" ${url ? '' : 'hidden'}>Remover foto</button>
        <p class="hint">Opcional. A foto é reduzida no celular antes do envio.</p>
      </div>
    </div>`;
}

// Liga o campo de foto: guarda o arquivo escolhido ou o pedido de remoção, e mostra a prévia.
function bindPhotoField(form, name) {
  const state = { file: null, removed: false, reset() {
    this.file = null;
    this.removed = false;
  } };
  const preview = form.querySelector('#photo-preview');
  const removeBtn = form.querySelector('#photo-remove');
  form.photo.addEventListener('change', () => {
    const file = form.photo.files[0];
    if (!file) return;
    state.file = file;
    state.removed = false;
    preview.innerHTML = avatar(name, URL.createObjectURL(file), 'big');
    removeBtn.hidden = false;
  });
  removeBtn.onclick = () => {
    state.file = null;
    state.removed = true;
    form.photo.value = '';
    preview.innerHTML = avatar(name, null, 'big');
    removeBtn.hidden = true;
  };
  return state;
}

// ---------------------------------------------------------------------
// Membros (liderança): lista, ficha, importação por planilha
// ---------------------------------------------------------------------
function requireLeader(next) {
  if (!requireLogin(next)) return false;
  if (isLeaderRole(myRole())) return true;
  $view.innerHTML = `<div class="empty"><h2>Só para a liderança</h2><p>A lista de membros fica com a secretaria, os líderes e o administrador da igreja.</p><a class="btn" href="#/">Voltar</a></div>`;
  return false;
}

// Situação da conta no app: o que a secretaria precisa saber para ajudar a pessoa a entrar.
function accountStatus(m) {
  if (m.consent_at) return { cls: 'ok', label: 'No app' };
  if (m.user_id) return { cls: 'wait', label: 'Convite pendente' };
  if (m.email) return { cls: '', label: 'Ainda não entrou' };
  return { cls: '', label: 'Sem e-mail' };
}

const MEMBER_COLUMNS = 'id, church_id, name, email, phone, birth_date, role, status, user_id, consent_at, photo_path, show_birthday, show_phone';

async function viewMembers(ctx) {
  if (!requireLeader('/membros')) return;
  const { data: members, error } = await sb.from('members').select(MEMBER_COLUMNS).eq('church_id', state.church.id).order('name');
  if (error) throw error;
  const minis = await signedPhotos(members.filter((m) => m.photo_path).map((m) => miniOf(m.photo_path)));
  if (!ctx.alive()) return;

  const filter = ctx.params.get('ver') || 'ativo';
  $view.innerHTML = `
    <div class="page">
      <h1>Membros</h1>
      <div class="actions-row">
        <a class="btn primary" href="#/membros/novo">${icon.plus} Novo membro</a>
        <a class="btn" href="#/membros/importar">${icon.upload} Importar planilha</a>
      </div>
      <label class="search">${icon.search}<input type="search" id="q" placeholder="Buscar por nome, e-mail ou telefone" aria-label="Buscar membros"></label>
      <div class="chips filters">
        ${[['ativo', 'Ativos'], ['inativo', 'Inativos'], ['todos', 'Todos']]
          .map(([k, label]) => `<a class="chip ${filter === k ? 'active' : ''}" href="#/membros?ver=${k}">${label}</a>`)
          .join('')}
      </div>
      <p class="hint" id="count"></p>
      <div class="list" id="members"></div>
    </div>`;

  const list = document.getElementById('members');
  const q = document.getElementById('q');
  const draw = () => {
    const term = fold(q.value);
    const digits = q.value.replace(/\D/g, '');
    const rows = members.filter(
      (m) =>
        (filter === 'todos' || m.status === filter) &&
        (!term || fold(m.name).includes(term) || fold(m.email).includes(term) || (digits.length >= 3 && (m.phone || '').includes(digits))),
    );
    const total = members.filter((m) => filter === 'todos' || m.status === filter).length;
    document.getElementById('count').textContent =
      rows.length === total ? `${total} ${total === 1 ? 'pessoa' : 'pessoas'}` : `${rows.length} de ${total}`;
    list.innerHTML = rows.length
      ? rows
          .map((m) => {
            const st = accountStatus(m);
            return `
          <a class="member-row ${m.status === 'inativo' ? 'inactive' : ''}" href="#/membros/${m.id}">
            ${avatar(m.name, m.photo_path && minis[miniOf(m.photo_path)])}
            <span><strong>${esc(m.name)}</strong><small>${esc(m.email || fmtPhone(m.phone) || '')}</small></span>
            <span class="tags">
              ${m.role !== 'membro' ? `<span class="tag role">${esc(ROLES[m.role])}</span>` : ''}
              <span class="tag ${st.cls}">${st.label}</span>
            </span>
          </a>`;
          })
          .join('')
      : `<div class="empty"><p>${members.length ? 'Ninguém encontrado.' : 'Nenhum membro cadastrado ainda.'}</p></div>`;
  };
  q.addEventListener('input', draw);
  draw();
}

async function viewMemberForm(ctx, id) {
  if (!requireLeader(id ? `/membros/${id}` : '/membros/novo')) return;
  const isNew = !id;
  let m = { name: '', email: '', phone: '', birth_date: '', role: 'membro', status: 'ativo' };
  let photoUrl = null;
  if (!isNew) {
    const { data, error } = await sb.from('members').select(MEMBER_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) {
      $view.innerHTML = `<div class="empty"><h2>Cadastro não encontrado</h2><a class="btn" href="#/membros">Voltar aos membros</a></div>`;
      return;
    }
    m = data;
    if (m.photo_path) photoUrl = (await signedPhotos([m.photo_path]))[m.photo_path];
  }
  if (!ctx.alive()) return;

  const role = myRole();
  const admin = role === 'admin';
  const canDelete = !isNew && ['admin', 'secretaria'].includes(role) && m.user_id !== state.user.id;
  const linked = !!m.user_id;
  const st = isNew ? null : accountStatus(m);

  $view.innerHTML = `
    <form id="member" class="form page">
      <a href="#/membros" class="back">← Membros</a>
      <h1>${isNew ? 'Novo membro' : esc(m.name)}</h1>
      ${st ? `<p><span class="tag ${st.cls}">${st.label}</span></p>` : ''}
      ${photoField(m.name, photoUrl)}
      <label>Nome<input name="name" required minlength="2" maxlength="120" value="${esc(m.name)}"></label>
      <label>E-mail
        <input name="email" type="email" maxlength="160" value="${esc(m.email || '')}" ${linked ? 'disabled' : ''}>
        <small class="hint">${
          linked
            ? 'A pessoa já entrou no app com este e-mail. Para trocar, o administrador desliga a conta primeiro.'
            : 'Com o e-mail, a pessoa entra no app e a conta é ligada a este cadastro.'
        }</small>
      </label>
      <label>Telefone com DDD<input name="phone" type="tel" inputmode="tel" placeholder="(61) 99999-9999" value="${esc(fmtPhone(m.phone))}"></label>
      <label>Data de nascimento<input name="birth_date" type="date" min="1900-01-01" value="${esc(m.birth_date || '')}"></label>
      <label>Papel na igreja
        <select name="role" ${admin ? '' : 'disabled'}>
          ${Object.entries(ROLES).map(([k, label]) => `<option value="${k}" ${m.role === k ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        ${admin ? '' : '<small class="hint">Só o administrador muda o papel.</small>'}
      </label>
      ${
        isNew
          ? `<label class="check"><input type="checkbox" name="consent" required> A pessoa concordou em ter estes dados no app da igreja.</label>`
          : `<label>Situação
              <select name="status">
                <option value="ativo" ${m.status === 'ativo' ? 'selected' : ''}>Ativo</option>
                <option value="inativo" ${m.status === 'inativo' ? 'selected' : ''}>Inativo (não acessa o app)</option>
              </select>
            </label>
            <p class="hint">Autorizações do membro: aniversário ${m.show_birthday ? 'visível' : 'oculto'} e telefone ${m.show_phone ? 'visível' : 'oculto'} para os outros membros.</p>`
      }
      <button class="btn primary big">${isNew ? 'Cadastrar' : 'Salvar'}</button>
      ${admin && linked ? '<button type="button" class="btn" id="unlink">Desligar a conta do app</button>' : ''}
      ${canDelete ? '<button type="button" class="btn danger-outline" id="delete">Excluir cadastro</button>' : ''}
    </form>`;

  const form = document.getElementById('member');
  const photo = bindPhotoField(form, m.name);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = linked ? m.email : form.email.value.trim().toLowerCase() || null;
    if (email && !EMAIL_RE.test(email)) return toast('E-mail inválido.', 'error');
    const phoneRaw = form.phone.value.trim();
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) return toast('Telefone inválido. Use o DDD e o número, como (61) 99999-9999.', 'error');

    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const memberId = isNew ? crypto.randomUUID() : m.id;
    let uploaded = false;
    try {
      const row = { name: form.name.value.trim(), phone, birth_date: form.birth_date.value || null };
      if (!linked) row.email = email;
      if (admin) row.role = form.role.value;
      if (!isNew) row.status = form.status.value;
      if (photo.file) {
        row.photo_path = await uploadMemberPhoto(state.church.id, memberId, photo.file);
        uploaded = true;
      } else if (photo.removed && m.photo_path) {
        await removeMemberPhotos(state.church.id, memberId);
        row.photo_path = null;
      }
      const { error } = isNew
        ? await sb.from('members').insert({ ...row, id: memberId, church_id: state.church.id })
        : await sb.from('members').update(row).eq('id', m.id);
      if (error) throw error;
      toast(isNew ? 'Membro cadastrado.' : 'Cadastro salvo.');
      // Mudou o próprio papel ou a própria situação: recarrega o que a pessoa pode ver.
      if (m.user_id === state.user.id) await loadMemberships();
      navigate('/membros');
    } catch (err) {
      if (isNew && uploaded) await removeMemberPhotos(state.church.id, memberId).catch(() => {});
      toast(errorText(err), 'error');
      btn.disabled = false;
    }
  });

  document.getElementById('unlink')?.addEventListener('click', async () => {
    if (!confirm(`Desligar a conta de ${m.name} do app? O cadastro continua, mas a pessoa perde o acesso até entrar de novo e aceitar o convite.`)) return;
    const { error } = await sb.rpc('unlink_member_account', { p_member: m.id });
    if (error) return toast(errorText(error), 'error');
    toast('Conta desligada.');
    render();
  });

  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!confirm(`Excluir o cadastro de ${m.name}? Os dados e a foto são apagados e não dá para desfazer.`)) return;
    try {
      await removeMemberPhotos(state.church.id, m.id);
      const { data, error } = await sb.from('members').delete().eq('id', m.id).select('id');
      if (error) throw error;
      if (!data.length) throw new Error('Você não tem permissão para excluir este cadastro.');
      toast('Cadastro excluído.');
      navigate('/membros');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
}

// Planilhas do Excel em português costumam vir em Windows-1252; as do Google, em UTF-8.
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const IMPORT_MAX = 1000;

async function viewImport(ctx) {
  if (!requireLeader('/membros/importar')) return;
  const { data: existing, error } = await sb.from('members').select('email').eq('church_id', state.church.id);
  if (error) throw error;
  if (!ctx.alive()) return;
  const emails = new Set(existing.map((r) => r.email).filter(Boolean));
  const room = (state.church.max_members ?? IMPORT_MAX) - existing.length;

  $view.innerHTML = `
    <div class="page">
      <a href="#/membros" class="back">← Membros</a>
      <h1>Importar planilha</h1>
      <div class="card">
        <p>Use uma planilha com as colunas <strong>nome</strong>, <strong>email</strong>, <strong>telefone</strong> e <strong>nascimento</strong> na primeira linha. Só o nome é obrigatório.</p>
        <p class="hint">No Excel ou no Google Planilhas, salve como <strong>CSV</strong>. Datas como 15/03/1980. Quem já tem o e-mail cadastrado é pulado.</p>
        <div class="actions-row">
          <button class="btn small" id="template">Baixar modelo</button>
          <label class="btn primary small">Escolher arquivo CSV<input type="file" id="file" accept=".csv,text/csv,text/plain" hidden></label>
        </div>
      </div>
      <div id="preview"></div>
    </div>`;

  document.getElementById('template').onclick = () => downloadFile('modelo-membros.csv', MEMBERS_CSV_TEMPLATE, 'text/csv;charset=utf-8');

  document.getElementById('file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const box = document.getElementById('preview');
    const { rows, error: parseError } = parseMembersCsv(await readTextFile(file), emails);
    if (parseError) {
      box.innerHTML = `<div class="notice warn-box">${esc(parseError)}</div>`;
      return;
    }
    const ok = rows.filter((r) => !r.errors.length && !r.skip);
    const bad = rows.filter((r) => r.errors.length);
    const skipped = rows.filter((r) => !r.errors.length && r.skip);
    const tooMany = ok.length > Math.min(room, IMPORT_MAX);

    box.innerHTML = `
      <div class="card">
        <h2>${ok.length} ${ok.length === 1 ? 'pessoa pronta' : 'pessoas prontas'} para importar</h2>
        ${skipped.length ? `<p class="hint">${skipped.length} pulada(s): já cadastrada(s) ou com e-mail repetido.</p>` : ''}
        ${bad.length ? `<p class="hint warn">${bad.length} linha(s) com erro não serão importadas. Corrija na planilha e importe de novo, se quiser.</p>` : ''}
        ${tooMany ? `<p class="hint warn">A igreja pode cadastrar mais ${Math.max(room, 0)} pessoa(s) no plano atual (e até ${IMPORT_MAX} por planilha).</p>` : ''}
        <div class="table-wrap">
          <table class="preview-table">
            <thead><tr><th>Linha</th><th>Situação</th><th>Nome</th><th>E-mail</th><th>Telefone</th><th>Nascimento</th></tr></thead>
            <tbody>
              ${rows
                .slice(0, 300)
                .map(
                  (r) => `
                <tr class="${r.errors.length ? 'bad' : r.skip ? 'skip' : ''}">
                  <td>${r.line}</td><td>${esc(r.errors.join(', ') || r.skip || 'ok')}</td>
                  <td>${esc(r.name)}</td><td>${esc(r.email || '')}</td>
                  <td>${esc(fmtPhone(r.phone))}</td><td>${esc(fmtDate(r.birth_date))}</td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
          ${rows.length > 300 ? `<p class="hint">Mostrando as primeiras 300 linhas.</p>` : ''}
        </div>
        ${
          ok.length && !tooMany
            ? `<form id="do-import" class="form">
                <label class="check"><input type="checkbox" name="consent" required> As pessoas da planilha concordaram em ter os dados no app da igreja.</label>
                <button class="btn primary big">Importar ${ok.length} ${ok.length === 1 ? 'pessoa' : 'pessoas'}</button>
              </form>`
            : ''
        }
      </div>`;

    document.getElementById('do-import')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = ev.target.querySelector('button');
      btn.disabled = true;
      let done = 0;
      try {
        for (let i = 0; i < ok.length; i += 100) {
          const batch = ok.slice(i, i + 100).map((r) => ({
            church_id: state.church.id,
            name: r.name,
            email: r.email,
            phone: r.phone,
            birth_date: r.birth_date,
          }));
          const { error: err } = await sb.from('members').insert(batch);
          if (err) throw err;
          done += batch.length;
          btn.textContent = `Importando… ${done} de ${ok.length}`;
        }
        toast(`${done} ${done === 1 ? 'pessoa importada' : 'pessoas importadas'}.`);
        navigate('/membros');
      } catch (err) {
        // Não oferece "tentar de novo" com a mesma lista: quem já entrou seria cadastrado duas vezes.
        ev.target.outerHTML = `<div class="notice"><strong>A importação parou${done ? ` depois de ${done} pessoa(s)` : ''}.</strong>
          <p>${esc(errorText(err))}</p><p>Confira a lista de membros antes de importar o restante.</p>
          <a class="btn" href="#/membros">Ver membros</a></div>`;
      }
    });
  });
}

// ---------------------------------------------------------------------
// Configurar a igreja (só o administrador): aparência, textos, funcionalidades, privacidade
// ---------------------------------------------------------------------
async function viewSettings(ctx) {
  if (!requireLogin('/config')) return;
  if (myRole() !== 'admin') {
    $view.innerHTML = `<div class="empty"><h2>Só para o administrador</h2><p>Peça ao administrador da igreja para mudar a configuração.</p><a class="btn" href="#/">Voltar</a></div>`;
    return;
  }
  const { data: c, error } = await sb.from('churches').select('*').eq('id', state.church.id).single();
  if (error) throw error;
  if (!ctx.alive()) return;
  const social = c.social || {};

  $view.innerHTML = `
    <form id="settings" class="form page">
      <h1>Configurar a igreja</h1>
      ${featureOn('aniversarios') ? `<a class="menu-row" href="#/config/aniversario">${icon.cake}<span>Mensagem de aniversário</span>${icon.chevron}</a>` : ''}

      <fieldset class="card">
        <legend>Aparência</legend>
        <label>Nome da igreja<input name="name" required minlength="2" maxlength="80" value="${esc(c.name)}"></label>
        <label>Nome curto (embaixo do ícone no celular)<input name="short_name" maxlength="20" value="${esc(c.short_name || '')}" placeholder="${esc(c.name.slice(0, 20))}"></label>
        <div class="logo-picker">
          <div class="icon-preview" id="icon-preview" style="background:${esc(c.icon_background)}">
            <img id="logo-preview" src="${esc(c.logo_url || 'icons/icon-192.png')}" alt="">
          </div>
          <div>
            <label class="btn small">Trocar a logo<input type="file" name="logo" accept="image/png,image/jpeg,image/webp" hidden></label>
            <p class="hint">PNG com fundo transparente fica melhor. É assim que o ícone aparece no celular.</p>
          </div>
        </div>
        <div class="colors">
          <label>Cor principal<input type="color" name="primary_color" value="${esc(c.primary_color)}"></label>
          <label>Fundo do ícone<input type="color" name="icon_background" value="${esc(c.icon_background)}"></label>
        </div>
        <p class="hint warn" id="color-warn" hidden>Essa cor é clara demais para botões e links sobre fundo branco. Prefira uma cor mais escura.</p>
      </fieldset>

      <fieldset class="card">
        <legend>Textos</legend>
        <label>Mensagem de boas-vindas<textarea name="welcome_text" rows="2" maxlength="500">${esc(c.welcome_text || '')}</textarea></label>
        <label>Sobre a igreja<textarea name="about_text" rows="4" maxlength="2000" placeholder="Horários dos cultos, história, pastores…">${esc(c.about_text || '')}</textarea></label>
        <label>Endereço<input name="address" maxlength="200" value="${esc(c.address || '')}"></label>
        <label>Cidade<input name="city" maxlength="80" value="${esc(c.city || '')}"></label>
      </fieldset>

      <fieldset class="card">
        <legend>Redes sociais</legend>
        ${SOCIAL.map(([k, label, ph]) => `<label>${label}<input name="social_${k}" type="url" maxlength="300" placeholder="${ph}" value="${esc(social[k] || '')}"></label>`).join('')}
      </fieldset>

      <fieldset class="card">
        <legend>Funcionalidades</legend>
        ${FEATURES.map(
          (f) => `
          <label class="check ${f.phase > 1 ? 'disabled' : ''}">
            <input type="checkbox" name="feature_${f.key}" ${c.features?.[f.key] ? 'checked' : ''} ${f.phase > 1 ? 'disabled' : ''}>
            ${esc(f.label)}${f.phase > 1 ? ` <small>(em breve)</small>` : ''}
          </label>`,
        ).join('')}
      </fieldset>

      <fieldset class="card">
        <legend>Privacidade</legend>
        <label>E-mail para pedidos sobre dados pessoais<input name="privacy_email" type="email" maxlength="160" value="${esc(c.privacy_email || '')}"></label>
        <label>Complemento da política de privacidade (opcional)<textarea name="privacy_text" rows="4" maxlength="8000" placeholder="Quem cuida dos dados na igreja, por quanto tempo eles ficam guardados…">${esc(c.privacy_text || '')}</textarea></label>
      </fieldset>

      <button class="btn primary big">Salvar</button>
      <p class="hint">O nome e o ícone do app instalado na tela inicial mudam na próxima publicação do site (em até uma hora). Quem já instalou pode precisar reinstalar para ver o ícone novo.</p>
    </form>`;

  const form = document.getElementById('settings');
  let logoFile = null;
  const colorWarn = () => (document.getElementById('color-warn').hidden = readableOnWhite(form.primary_color.value));
  colorWarn();
  form.primary_color.addEventListener('input', colorWarn);
  form.icon_background.addEventListener('input', () => (document.getElementById('icon-preview').style.background = form.icon_background.value));
  form.logo.addEventListener('change', () => {
    logoFile = form.logo.files[0] || null;
    if (logoFile) document.getElementById('logo-preview').src = URL.createObjectURL(logoFile);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    try {
      const newSocial = {};
      for (const [k] of SOCIAL) {
        const v = form[`social_${k}`].value.trim();
        if (v && !/^https:\/\//i.test(v)) throw new Error('Os links das redes sociais precisam começar com https://');
        if (v) newSocial[k] = v;
      }
      const features = { ...(c.features || {}) };
      for (const f of FEATURES) if (f.phase === 1) features[f.key] = form[`feature_${f.key}`].checked;

      const patch = {
        name: form.name.value.trim(),
        short_name: form.short_name.value.trim() || null,
        primary_color: form.primary_color.value.toLowerCase(),
        icon_background: form.icon_background.value.toLowerCase(),
        welcome_text: form.welcome_text.value.trim() || null,
        about_text: form.about_text.value.trim() || null,
        address: form.address.value.trim() || null,
        city: form.city.value.trim() || null,
        social: newSocial,
        features,
        privacy_email: form.privacy_email.value.trim() || null,
        privacy_text: form.privacy_text.value.trim() || null,
      };

      // Logo nova ou fundo do ícone diferente: gera os ícones do app de novo.
      let source = logoFile;
      if (!source && c.logo_url && patch.icon_background !== c.icon_background) {
        const res = await fetch(c.logo_url);
        if (res.ok) source = await res.blob();
      }
      if (source) {
        const bucket = sb.storage.from('igrejas');
        if (logoFile) {
          const logo = await resizeLogo(logoFile);
          const ext = logo.type === 'image/png' ? 'png' : 'webp';
          const path = `${c.id}/logo-${Date.now()}.${ext}`;
          const up = await bucket.upload(path, logo, { contentType: logo.type, cacheControl: '31536000' });
          if (up.error) throw up.error;
          patch.logo_url = bucket.getPublicUrl(path).data.publicUrl;
        }
        const icons = await makeIconSet(source, patch.icon_background);
        for (const [name, blob] of Object.entries(icons)) {
          const up = await bucket.upload(`${c.id}/icons/${name}`, blob, { contentType: 'image/png', cacheControl: '300', upsert: true });
          if (up.error) throw up.error;
        }
      }

      const { data: saved, error: err } = await sb.from('churches').update(patch).eq('id', c.id).select().single();
      if (err) throw err;

      // A logo antiga não é mais usada.
      const oldPath = c.logo_url?.split('/object/public/igrejas/')[1];
      if (logoFile && oldPath) await sb.storage.from('igrejas').remove([decodeURIComponent(oldPath)]);

      state.church = saved;
      applyBranding();
      toast('Configuração salva.');
      render();
    } catch (err) {
      toast(errorText(err), 'error');
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
}

// ---------------------------------------------------------------------
// Aniversários: cartão da semana, aniversariantes do mês, mensagem da igreja, notificações
// ---------------------------------------------------------------------
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const parseIso = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

function dayLabel(iso) {
  const today = new Date();
  if (iso === isoLocal(today)) return 'Hoje';
  if (iso === isoLocal(addDays(today, 1))) return 'Amanhã';
  return parseIso(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'numeric' }).replace('.', '');
}

// A regra de quem aparece fica no banco: liderança vê todos (com a idade); membros, só quem autorizou.
async function fetchBirthdays(from, to) {
  const { data, error } = await sb.rpc('birthdays_between', { p_church: state.church.id, p_from: from, p_to: to });
  if (error) throw error;
  return data;
}

async function weekBirthdaysCard(el) {
  if (!isActiveMember()) return;
  const today = new Date();
  const todayIso = isoLocal(today);
  const rows = await fetchBirthdays(todayIso, isoLocal(addDays(today, 6)));
  if (!rows.length || !el.isConnected) return;
  const minis = await signedPhotos(rows.filter((r) => r.photo_path).map((r) => miniOf(r.photo_path)));
  const anyToday = rows.some((r) => r.on_date === todayIso);
  el.innerHTML = `
    <section class="card birthday-card">
      <h2>${icon.cake} ${anyToday ? 'Aniversariantes de hoje e da semana' : 'Aniversariantes da semana'}</h2>
      <ul class="bday-list">
        ${rows
          .slice(0, 8)
          .map(
            (r) => `
          <li class="${r.on_date === todayIso ? 'today' : ''}">
            ${avatar(r.name, r.photo_path && minis[miniOf(r.photo_path)])}
            <span><strong>${esc(r.name)}</strong><small>${esc(dayLabel(r.on_date))}${r.age ? ` · ${r.age} anos` : ''}</small></span>
          </li>`,
          )
          .join('')}
      </ul>
      <a href="#/aniversariantes">Ver os aniversariantes do mês</a>
    </section>`;
}

async function viewBirthdays(ctx) {
  if (!requireLogin('/aniversariantes')) return;
  if (!isActiveMember()) return navigate('/');
  const now = new Date();
  const [y, m] = (ctx.params.get('mes') || '').match(/^\d{4}-\d{2}$/)
    ? ctx.params.get('mes').split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1];
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  const rows = await fetchBirthdays(isoLocal(first), isoLocal(last));
  const minis = await signedPhotos(rows.filter((r) => r.photo_path).map((r) => miniOf(r.photo_path)));
  if (!ctx.alive()) return;

  const month = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const leader = isLeaderRole(myRole());
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.on_date)) byDay.set(r.on_date, []);
    byDay.get(r.on_date).push(r);
  }
  const todayIso = isoLocal(now);

  $view.innerHTML = `
    <div class="page birthdays-page">
      <div class="month-nav no-print">
        <a class="btn small" href="#/aniversariantes?mes=${month(new Date(y, m - 2, 1))}" aria-label="Mês anterior">‹</a>
        <h1>Aniversariantes de ${MONTHS[m - 1]}</h1>
        <a class="btn small" href="#/aniversariantes?mes=${month(new Date(y, m, 1))}" aria-label="Próximo mês">›</a>
      </div>
      <h1 class="print-only">${esc(state.church.name)}: aniversariantes de ${MONTHS[m - 1]} de ${y}</h1>
      <p class="hint">${
        leader
          ? `${rows.length} ${rows.length === 1 ? 'aniversariante' : 'aniversariantes'}. Como liderança, você vê todos os membros ativos.`
          : 'Aparecem só os membros que autorizaram mostrar o aniversário.'
      }</p>
      ${
        rows.length
          ? `<div class="bday-month">${[...byDay]
              .map(
                ([iso, list]) => `
            <section class="bday-day ${iso === todayIso ? 'today' : ''}">
              <div class="bday-date"><strong>${parseIso(iso).getDate()}</strong><small>${parseIso(iso).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</small></div>
              <ul class="bday-list">
                ${list
                  .map(
                    (r) => `
                  <li>${avatar(r.name, r.photo_path && minis[miniOf(r.photo_path)])}
                    <span><strong>${esc(r.name)}</strong>${r.age ? `<small>faz ${r.age} anos</small>` : ''}</span></li>`,
                  )
                  .join('')}
              </ul>
            </section>`,
              )
              .join('')}</div>`
          : `<div class="empty"><p>Nenhum aniversariante em ${MONTHS[m - 1]}.</p></div>`
      }
      <button class="btn no-print" id="print">${icon.print} Imprimir</button>
    </div>`;
  document.getElementById('print').onclick = () => window.print();
}

async function viewNotifications() {
  if (!requireLogin('/notificacoes')) return;
  const support = pushSupport();
  const active = await pushActive();
  const blocked = support === 'ok' && Notification.permission === 'denied';
  $view.innerHTML = `
    <div class="page">
      <h1>Notificações</h1>
      <div class="card">
        <p>Receba no celular a mensagem de aniversário da igreja${isLeaderRole(myRole()) ? ' e o resumo dos aniversariantes para a liderança' : ''}.</p>
        ${
          support === 'ios-instalar'
            ? `<div class="notice"><strong>No iPhone, instale o app primeiro.</strong><p>Toque em Compartilhar e depois em "Adicionar à Tela de Início". Abra o app pelo ícone e volte aqui.</p></div>`
            : support !== 'ok'
              ? `<p class="hint warn">Este navegador não recebe notificações. Tente pelo Chrome (Android) ou pelo app instalado (iPhone).</p>`
              : blocked
                ? `<p class="hint warn">As notificações estão bloqueadas para este site. Libere nas configurações do navegador e volte aqui.</p>`
                : `<p><strong>${active ? 'Ativadas neste aparelho.' : 'Desativadas neste aparelho.'}</strong></p>
                   <button class="btn ${active ? '' : 'primary'} big" id="toggle">${active ? 'Desativar neste aparelho' : 'Ativar neste aparelho'}</button>`
        }
      </div>
    </div>`;
  document.getElementById('toggle')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      if (active) {
        await disablePush(sb);
        toast('Notificações desativadas neste aparelho.');
      } else {
        const res = await enablePush(sb, CONFIG.VAPID_PUBLIC_KEY);
        toast(res === 'ativo' ? 'Pronto! As notificações estão ativadas.' : 'Sem permissão para notificações.', res === 'ativo' ? '' : 'error');
      }
    } catch (err) {
      toast(errorText(err), 'error');
    }
    render();
  });
}

// Convite discreto na página inicial para ativar as notificações (some por 30 dias ao fechar).
async function pushInvite(el) {
  if (!isActiveMember() || pushSupport() !== 'ok' || Notification.permission !== 'default' || (await pushActive())) return;
  try {
    if (Date.now() - Number(localStorage.getItem('push-invite-dismissed') || 0) < 30 * 864e5) return;
  } catch {}
  if (!el.isConnected) return;
  el.innerHTML = `
    <div class="notice push-invite">
      ${icon.bell}
      <span><strong>Receba as mensagens da igreja no celular</strong><small>Como a mensagem no dia do seu aniversário.</small></span>
      <button class="btn primary small" id="push-yes">Ativar</button>
      <button class="close" aria-label="Agora não" id="push-no">&times;</button>
    </div>`;
  document.getElementById('push-no').onclick = () => {
    try {
      localStorage.setItem('push-invite-dismissed', String(Date.now()));
    } catch {}
    el.innerHTML = '';
  };
  document.getElementById('push-yes').onclick = async () => {
    try {
      const res = await enablePush(sb, CONFIG.VAPID_PUBLIC_KEY);
      toast(res === 'ativo' ? 'Pronto! As notificações estão ativadas.' : 'Sem permissão para notificações.', res === 'ativo' ? '' : 'error');
    } catch (err) {
      toast(errorText(err), 'error');
    }
    el.innerHTML = '';
  };
}

async function viewBirthdaySettings(ctx) {
  if (!requireLogin('/config/aniversario')) return;
  if (myRole() !== 'admin') {
    $view.innerHTML = `<div class="empty"><h2>Só para o administrador</h2><a class="btn" href="#/">Voltar</a></div>`;
    return;
  }
  const { data, error } = await sb.from('message_templates').select('*').eq('church_id', state.church.id).in('kind', ['aniversario', 'resumo_lideres']);
  if (error) throw error;
  if (!ctx.alive()) return;
  const t = data.find((r) => r.kind === 'aniversario');
  const summary = data.find((r) => r.kind === 'resumo_lideres');
  if (!t || !summary) throw new Error('Os modelos de mensagem não foram encontrados. Rode o supabase/004_aniversarios.sql.');
  const sample = { name: myMember()?.name || 'Maria da Silva', church: state.church.name, age: 30 };

  $view.innerHTML = `
    <form id="bday" class="form page">
      <a href="#/menu" class="back">← Menu</a>
      <h1>Mensagem de aniversário</h1>
      <p class="hint">Vai às 7h (horário de Brasília) para quem faz aniversário. Quem nasceu em 29/02 recebe em 28/02 nos anos que não são bissextos.</p>
      <label class="check"><input type="checkbox" name="enabled" ${t.enabled ? 'checked' : ''}> Enviar a mensagem de aniversário</label>

      <fieldset class="card">
        <legend>Texto</legend>
        <label>Título<input name="title" required maxlength="120" value="${esc(t.title)}"></label>
        <label>Mensagem<textarea name="body" required rows="5" maxlength="1000">${esc(t.body)}</textarea></label>
        <div class="chips" aria-label="Campos para a mensagem">
          ${MESSAGE_FIELDS.map((f) => `<button type="button" class="chip" data-field="${f}">{${f}}</button>`).join('')}
        </div>
        <p class="hint">Toque num campo para colocá-lo no texto. {idade} é a idade que a pessoa completa.</p>
      </fieldset>

      <fieldset class="card">
        <legend>Imagem (opcional)</legend>
        <div class="bday-image" id="image-box">${t.image_url ? `<img src="${esc(t.image_url)}" alt="">` : '<p class="hint">Sem imagem.</p>'}</div>
        <div class="actions-row">
          <label class="btn small">${t.image_url ? 'Trocar a imagem' : 'Escolher imagem'}<input type="file" name="image" accept="image/*" hidden></label>
          <button type="button" class="btn link small" id="image-remove" ${t.image_url ? '' : 'hidden'}>Remover imagem</button>
        </div>
      </fieldset>

      <fieldset class="card">
        <legend>Como enviar</legend>
        <label class="check"><input type="checkbox" name="send_push" ${t.send_push ? 'checked' : ''}> Notificação no celular (para quem ativou)</label>
        <label class="check"><input type="checkbox" name="send_email" ${t.send_email ? 'checked' : ''}> E-mail</label>
        <p class="hint">O e-mail começa a sair quando a plataforma ligar o provedor de e-mail. Até lá, só a notificação.</p>
      </fieldset>

      <fieldset class="card">
        <legend>Liderança</legend>
        <label class="check"><input type="checkbox" name="summary" ${summary.enabled ? 'checked' : ''}> Resumo para a liderança às 7h: aniversariantes do dia e, às segundas, os da semana</label>
      </fieldset>

      <section class="card preview">
        <h2>Prévia</h2>
        <div class="push-preview">
          <img src="${esc(state.church.logo_url || 'icons/icon-192.png')}" alt="" width="36" height="36">
          <div><strong id="pv-title"></strong><p id="pv-body"></p></div>
        </div>
        <p class="hint">Assim chega para ${esc(sample.name.split(' ')[0])}, se fizesse ${sample.age} anos hoje.</p>
      </section>

      <button class="btn primary big">Salvar</button>
    </form>`;

  const form = document.getElementById('bday');
  let imageFile = null;
  let removeImage = false;
  let lastField = form.body;
  const preview = () => {
    document.getElementById('pv-title').textContent = renderMessage(form.title.value, sample);
    document.getElementById('pv-body').textContent = renderMessage(form.body.value, sample);
  };
  preview();
  form.title.addEventListener('input', preview);
  form.body.addEventListener('input', preview);
  form.title.addEventListener('focus', () => (lastField = form.title));
  form.body.addEventListener('focus', () => (lastField = form.body));
  form.querySelectorAll('[data-field]').forEach((b) => {
    b.onclick = () => {
      const el = lastField;
      const text = `{${b.dataset.field}}`;
      const [s, e] = [el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length];
      el.value = el.value.slice(0, s) + text + el.value.slice(e);
      el.focus();
      el.setSelectionRange(s + text.length, s + text.length);
      preview();
    };
  });
  form.image.addEventListener('change', () => {
    imageFile = form.image.files[0] || null;
    if (!imageFile) return;
    removeImage = false;
    document.getElementById('image-box').innerHTML = `<img src="${URL.createObjectURL(imageFile)}" alt="">`;
    document.getElementById('image-remove').hidden = false;
  });
  document.getElementById('image-remove').onclick = () => {
    imageFile = null;
    removeImage = true;
    form.image.value = '';
    document.getElementById('image-box').innerHTML = '<p class="hint">Sem imagem.</p>';
    document.getElementById('image-remove').hidden = true;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    try {
      const bucket = sb.storage.from('igrejas');
      const patch = {
        enabled: form.enabled.checked,
        title: form.title.value.trim(),
        body: form.body.value.trim(),
        send_push: form.send_push.checked,
        send_email: form.send_email.checked,
        updated_at: new Date().toISOString(),
      };
      if (imageFile) {
        const img = await resizeImage(imageFile, 1080, 0.82);
        const path = `${state.church.id}/aniversario/imagem-${Date.now()}.${img.type === 'image/webp' ? 'webp' : 'jpg'}`;
        const up = await bucket.upload(path, img, { contentType: img.type, cacheControl: '31536000' });
        if (up.error) throw up.error;
        patch.image_url = bucket.getPublicUrl(path).data.publicUrl;
      } else if (removeImage) patch.image_url = null;

      const save = (kind, p) => sb.from('message_templates').update(p).eq('church_id', state.church.id).eq('kind', kind).select('kind');
      const [a, b] = await Promise.all([save('aniversario', patch), save('resumo_lideres', { enabled: form.summary.checked, updated_at: patch.updated_at })]);
      for (const r of [a, b]) {
        if (r.error) throw r.error;
        if (!r.data.length) throw new Error('Você não tem permissão para mudar a mensagem.');
      }
      // A imagem antiga não é mais usada.
      const oldPath = (imageFile || removeImage) && t.image_url?.split('/object/public/igrejas/')[1];
      if (oldPath) await bucket.remove([decodeURIComponent(oldPath)]);
      toast('Mensagem salva.');
      render();
    } catch (err) {
      toast(errorText(err), 'error');
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------
async function loadChurch() {
  const { data, error } = await sb.from('churches').select('*').eq('slug', SLUG).maybeSingle();
  if (error) throw error;
  return data;
}

async function boot() {
  if (!configured) {
    $view.innerHTML = `
      <div class="empty">
        <h2>Falta configurar o Supabase</h2>
        <p>Edite <code>js/config.js</code> com a chave pública do projeto e rode <code>supabase/001_base.sql</code> no SQL Editor. Veja o README.</p>
      </div>`;
    return;
  }

  const authError = new URLSearchParams(location.search).get('error_description');
  const [{ data }, church] = await Promise.all([sb.auth.getSession(), SLUG ? loadChurch() : null]);
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  if (authError) toast(authError, 'error');

  if (SLUG && !church) {
    applyBranding();
    $view.innerHTML = `<div class="empty"><h2>Igreja não encontrada</h2><p>Confira o endereço com a liderança da sua igreja.</p><a class="btn" href="${esc(ROOT_URL)}">Ir para o início</a></div>`;
    return;
  }
  state.church = church;
  applyBranding();
  await setUser(data.session?.user ?? null);

  sb.auth.onAuthStateChange((event, session) => {
    if (!['SIGNED_IN', 'SIGNED_OUT'].includes(event)) return;
    if ((session?.user?.id ?? null) === (state.user?.id ?? null)) return;
    // Evita chamar o Supabase dentro do callback de autenticação.
    setTimeout(async () => {
      await setUser(session?.user ?? null);
      render();
    }, 0);
  });

  const next = sessionStorage.getItem('next');
  if (data.session && next && ['', '#/', '#/entrar'].includes(location.hash)) {
    sessionStorage.removeItem('next');
    history.replaceState(null, '', location.pathname + '#' + next);
  }

  window.addEventListener('hashchange', render);
  render();
}

// Nas páginas das igrejas o <base> aponta para a raiz do site, e o navegador resolveria
// href="#/..." contra ela (saindo da igreja). Os links internos trocam só o "#" da página atual.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  location.hash = a.getAttribute('href').slice(1);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot().catch((e) => {
  console.error(e);
  $view.innerHTML = `<div class="empty"><h2>Não foi possível abrir o app</h2><p>${esc(errorText(e))}</p><button class="btn primary" onclick="location.reload()">Tentar de novo</button></div>`;
});
