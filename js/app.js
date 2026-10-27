import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { CONFIG } from './config.js';
import {
  esc, slugify, isValidSlug, churchSlugFromPath, inkOn, readableOnWhite, normalizePhone, fmtPhone,
  ROLES, isLeaderRole, FEATURES, fold, fmtDate, EMAIL_RE, parseMembersCsv, MEMBERS_CSV_TEMPLATE,
  renderMessage, MESSAGE_FIELDS, SPECIAL_FIELDS, yearsText, MESSAGE_EMOJIS, icsForEvent, googleCalendarUrl, REMIND_OPTIONS,
} from './util.js';
import { resizeImage, resizeLogo, makeIconSet } from './images.js';
import { maybeSuggestInstall, installState, installNow, iconReady, ICON_PREPARING } from './install.js';
import { pushSupport, pushActive, enablePush, disablePush, syncPush } from './push.js';
import { PIX_TYPES, guessPixType, normalizePixKey, formatPixKey, parseAmount, pixPayload, qrSvg } from './pix.js';

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
// Pastor (administrador) e líderes: leem os pedidos de oração privados e moderam o mural.
const isPastoral = () => ['admin', 'lider'].includes(myRole());
// Datas comemoradas: aniversário (funcionalidade "aniversarios") e casamento e batismo ("datas_especiais").
const MESSAGE_KINDS = {
  aniversario: { feature: 'aniversarios', menu: 'Mensagem de aniversário', emoji: '🎂', label: 'Aniversário' },
  casamento: { feature: 'datas_especiais', menu: 'Mensagem de casamento', emoji: '💍', label: 'Casamento' },
  batismo: { feature: 'datas_especiais', menu: 'Mensagem de batismo', emoji: '🕊️', label: 'Batismo' },
};
const messageKindsOn = () => Object.keys(MESSAGE_KINDS).filter((k) => featureOn(MESSAGE_KINDS[k].feature));
const datesOn = () => featureOn('aniversarios') || featureOn('datas_especiais');
// Atalhos do administrador para as mensagens das datas ligadas.
const messageLinks = () =>
  messageKindsOn()
    .map((k) => `<a class="menu-row" href="#/config/${k}">${icon.cake}<span>${MESSAGE_KINDS[k].menu}</span>${icon.chevron}</a>`)
    .join('');
// Tela de ofertas: funcionalidade ligada e chave Pix preenchida.
const offerReady = () => featureOn('pix') && !!state.church?.pix_key;

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
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M7 9V3.5h10V9M7 17H4.5V9h15v8H17"/><path d="M7 14h10v6.5H7z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>',
  pix: '<svg viewBox="0 0 24 24"><path d="M12 3.5 20.5 12 12 20.5 3.5 12z"/><path d="M8 12h8"/></svg>',
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
    ...(featureOn('agenda') ? [['/agenda', icon.calendar, 'Agenda']] : []),
    ...(featureOn('avisos') ? [['/avisos', icon.megaphone, 'Avisos']] : []),
    ...(isLeaderRole(myRole()) ? [['/membros', icon.users, 'Membros']] : []),
    ['/menu', icon.menu, 'Menu'],
  ];
  const section = tabs.find(([href]) => href !== '/' && path.startsWith(href));
  const active = ['/', ''].includes(path) ? '/' : section ? section[0] : '/menu';
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
  document.getElementById('notif-link').hidden = !(state.church && isActiveMember());
}

// Número no sininho: notificações não lidas desta igreja.
async function refreshUnread() {
  const badge = document.getElementById('notif-badge');
  if (!state.church || !isActiveMember()) return (badge.hidden = true);
  const { count } = await sb
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('church_id', state.church.id)
    .is('read_at', null);
  badge.textContent = count > 9 ? '9+' : String(count || '');
  badge.hidden = !count;
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
  [/^\/meus-dados$/, viewMyData],
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
  [/^\/meus-dados$/, viewMyData],
  [/^\/ajuda$/, viewHelp],
  [/^\/aniversariantes$/, viewBirthdays],
  [/^\/config\/(aniversario|casamento|batismo)$/, viewMessageSettings],
  [/^\/notificacoes$/, viewNotifications],
  [/^\/agenda$/, viewAgenda],
  [/^\/agenda\/novo$/, viewEventForm],
  [/^\/agenda\/([0-9a-f-]{36})$/, viewEvent],
  [/^\/agenda\/([0-9a-f-]{36})\/editar$/, viewEventForm],
  [/^\/avisos$/, viewAnnouncements],
  [/^\/avisos\/novo$/, viewAnnouncementForm],
  [/^\/avisos\/([0-9a-f-]{36})\/editar$/, viewAnnouncementForm],
  [/^\/ofertar$/, viewOffer],
  [/^\/oracao$/, viewPrayers],
  [/^\/oracao\/novo$/, viewPrayerForm],
  [/^\/oracao\/meus$/, viewMyPrayers],
  [/^\/oracao\/moderar$/, viewPrayerModeration],
  [/^\/celulas$/, viewCells],
  [/^\/celulas\/nova$/, viewCellForm],
  [/^\/celulas\/([0-9a-f-]{36})$/, viewCell],
  [/^\/celulas\/([0-9a-f-]{36})\/editar$/, viewCellForm],
  [/^\/celulas\/([0-9a-f-]{36})\/encontro$/, viewCellMeeting],
];

let renderId = 0;
async function render() {
  const id = ++renderId;
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  const ctx = { params: new URLSearchParams(qs || ''), path, alive: () => id === renderId };
  renderTabbar(path);
  document.getElementById('notif-link').classList.toggle('active', path === '/notificacoes');
  if (path !== '/notificacoes') refreshUnread().catch(() => {});
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
      <p class="legal">Ao entrar, você concorda com os <a href="termos.html">Termos de uso</a> e a <a href="privacidade.html">Política de Privacidade</a>.</p>
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
  clearBootCache();
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
        <a class="menu-row" href="#/meus-dados">${icon.user}<span>Meus dados</span>${icon.chevron}</a>
        <a class="menu-row" href="privacidade.html">${icon.shield}<span>Política de privacidade</span>${icon.chevron}</a>
        <a class="menu-row" href="termos.html">${icon.shield}<span>Termos de uso</span>${icon.chevron}</a>
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
        <p>Para participar, a igreja guarda o seu nome, e-mail e, se você informou, telefone, data de nascimento${featureOn('datas_especiais') ? ', datas de casamento e de batismo' : ''} e foto. Isso serve para os avisos, a agenda e as mensagens de aniversário.</p>
        <ul class="bullets">
          <li>As datas e o telefone ficam visíveis só para a liderança, a não ser que você autorize no seu cadastro.</li>
          <li>Você pode ver, corrigir, exportar e excluir os seus dados quando quiser.</li>
        </ul>
        <p class="hint">Leia a <a href="privacidade.html" target="_blank">Política de Privacidade</a>, os <a href="termos.html" target="_blank">Termos de uso</a>${c.privacy_text ? ` e o <a href="#/privacidade">complemento da igreja</a>` : ''}.</p>
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
        ${offerReady() ? `<a class="btn" href="#/ofertar">${icon.pix} Dízimos e ofertas</a>` : ''}
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
  const shortcuts = [
    ['agenda', icon.calendar, 'Agenda', '#/agenda'],
    ['avisos', icon.megaphone, 'Avisos', '#/avisos'],
    ['aniversarios', icon.cake, 'Aniversariantes', '#/aniversariantes'],
    ['oracao', icon.heart, 'Oração', '#/oracao'],
    ['celulas', icon.users, isLeaderRole(m.role) ? 'Células' : 'Célula', '#/celulas'],
    ['pix', icon.pix, 'Ofertar', '#/ofertar'],
  ].filter(([k]) => (k === 'pix' ? offerReady() : k === 'aniversarios' ? datesOn() : featureOn(k)));
  $view.innerHTML = `
    <div class="page">
      ${head}
      <div id="home-notices"></div>
      <div id="home-events"></div>
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
      <div id="week-birthdays"></div>
      <div id="push-invite"></div>
      ${aboutCard(c)}
    </div>`;
  if (featureOn('avisos')) homeNoticesCard(document.getElementById('home-notices')).catch(() => {});
  if (featureOn('agenda')) homeEventsCard(document.getElementById('home-events')).catch(() => {});
  if (datesOn()) weekBirthdaysCard(document.getElementById('week-birthdays')).catch(() => {});
  pushInvite(document.getElementById('push-invite')).catch(() => {});
  maybeSuggestInstall(c);
  prefetchMembers();
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
        ${datesOn() ? `<a class="menu-row" href="#/aniversariantes">${icon.cake}<span>Aniversariantes do mês</span>${icon.chevron}</a>` : ''}
        ${featureOn('celulas') ? `<a class="menu-row" href="#/celulas">${icon.users}<span>${isLeaderRole(m.role) ? 'Células' : 'Minha célula'}</span>${icon.chevron}</a>` : ''}
        ${featureOn('oracao') ? `<a class="menu-row" href="#/oracao">${icon.heart}<span>Pedidos de oração</span>${icon.chevron}</a>` : ''}
        ${featureOn('oracao') && isPastoral() ? `<a class="menu-row" href="#/oracao/moderar">${icon.heart}<span>Moderar pedidos de oração</span>${icon.chevron}</a>` : ''}
        ${offerReady() ? `<a class="menu-row" href="#/ofertar">${icon.pix}<span>Dízimos e ofertas</span>${icon.chevron}</a>` : ''}
        <a class="menu-row" href="#/notificacoes">${icon.bell}<span>Notificações</span>${icon.chevron}</a>
        ${admin ? messageLinks() : ''}
        <a class="menu-row" href="#/meus-dados">${icon.user}<span>Meus dados: baixar ou excluir</span>${icon.chevron}</a>
        <a class="menu-row" href="#/ajuda">${icon.help}<span>Ajuda: como funciona</span>${icon.chevron}</a>
        <a class="menu-row" href="#/privacidade">${icon.shield}<span>Privacidade e termos</span>${icon.chevron}</a>
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
      <p>O app segue a <a href="privacidade.html">Política de Privacidade</a> e os <a href="termos.html">Termos de uso</a> do ${esc(CONFIG.APP_NAME)}.</p>
      ${c.privacy_text ? `<section class="card"><h2>Complemento de ${esc(c.name)}</h2><p class="pre">${esc(c.privacy_text)}</p></section>` : ''}
      ${c.privacy_email ? `<p>Pedidos sobre os seus dados nesta igreja: <a href="mailto:${esc(c.privacy_email)}">${esc(c.privacy_email)}</a>.</p>` : ''}
      ${state.user ? `<a class="btn" href="#/meus-dados">${icon.user} Baixar ou excluir os meus dados</a>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------
// Meus dados (LGPD): baixar, sair desta igreja, excluir a conta
// ---------------------------------------------------------------------
async function viewMyData() {
  if (!requireLogin('/meus-dados')) return;
  const here = state.church ? myMember() : null;
  $view.innerHTML = `
    <div class="page">
      <h1>Meus dados</h1>
      <p class="hint">${esc(state.user.email)}</p>

      <section class="card">
        <h2>${icon.upload} Baixar meus dados</h2>
        <p>Um arquivo com tudo o que o app guarda sobre você: os seus cadastros em cada igreja, as suas células e presenças, os seus pedidos de oração, as notificações, as mensagens enviadas, os aparelhos com notificação e o que você publicou.</p>
        <button class="btn" id="export">Baixar arquivo</button>
        <p class="hint">Para corrigir algum dado, use "Meu cadastro" ou fale com a secretaria da igreja.</p>
      </section>

      ${
        here
          ? `<section class="card">
              <h2>Sair da ${esc(state.church.name)}</h2>
              <p>O seu cadastro, a sua foto e os seus pedidos de oração nesta igreja são apagados, e você deixa de receber as mensagens dela. A sua conta e as outras igrejas continuam.</p>
              <button class="btn danger-outline" id="leave">Sair desta igreja</button>
            </section>`
          : ''
      }

      <section class="card danger-zone">
        <h2>Excluir minha conta</h2>
        <p>Apaga a sua conta e os seus cadastros em <strong>todas</strong> as igrejas, com fotos, pedidos de oração, notificações e aparelhos. Não dá para desfazer. Os eventos e avisos que você publicou continuam na igreja, sem o seu nome.</p>
        <label>Para confirmar, digite EXCLUIR<input id="confirm-delete" autocomplete="off" autocapitalize="characters"></label>
        <button class="btn danger-outline" id="delete" disabled>Excluir minha conta para sempre</button>
      </section>
    </div>`;

  // O botão fica numa variável: depois do "await", e.currentTarget já é null.
  const exportBtn = document.getElementById('export');
  exportBtn.onclick = async () => {
    exportBtn.disabled = true;
    const { data, error } = await sb.rpc('export_my_data');
    exportBtn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `meus-dados-${isoLocal(new Date())}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Arquivo baixado.');
  };

  const leaveBtn = document.getElementById('leave');
  leaveBtn?.addEventListener('click', async () => {
    if (!confirm(`Sair da ${state.church.name}? O seu cadastro nesta igreja será apagado.`)) return;
    leaveBtn.disabled = true;
    try {
      if (here.consent_at) await removeMemberPhotos(state.church.id, here.id);
      const { error } = await sb.rpc('leave_church', { p_church: state.church.id });
      if (error) throw error;
      await disablePushIfNoChurches();
      toast(`Você saiu da ${state.church.name}.`);
      location.href = ROOT_URL;
    } catch (err) {
      toast(errorText(err), 'error');
      leaveBtn.disabled = false;
    }
  });

  const confirmInput = document.getElementById('confirm-delete');
  const del = document.getElementById('delete');
  confirmInput.addEventListener('input', () => (del.disabled = confirmInput.value.trim().toUpperCase() !== 'EXCLUIR'));
  del.onclick = async () => {
    del.disabled = true;
    del.textContent = 'Excluindo…';
    try {
      for (const m of state.memberships.filter((x) => x.consent_at)) await removeMemberPhotos(m.church.id, m.id);
      await disablePush(sb).catch(() => {});
      const { error } = await sb.rpc('delete_my_account');
      if (error) throw error;
      clearBootCache();
      await sb.auth.signOut({ scope: 'local' });
      alert('Sua conta foi excluída.');
      location.href = ROOT_URL;
    } catch (err) {
      toast(errorText(err), 'error');
      del.disabled = false;
      del.textContent = 'Excluir minha conta para sempre';
    }
  };
}

// ---------------------------------------------------------------------
// Ajuda: como funciona e como configurar, conforme o papel de quem lê
// ---------------------------------------------------------------------
// Cada tópico: [título, texto em HTML]. Os textos não têm dados de ninguém, só explicações.
function helpTopics() {
  const c = state.church;
  const features = (k) => featureOn(k);
  const everyone = [
    [
      'Instalar o app no celular',
      `<p>Com o app na tela inicial, ele abre com um toque, com o nome e a logo da ${esc(c.name)}.</p>
       <ul class="bullets">
         <li><strong>Android (Chrome):</strong> toque nos três pontinhos ⋮ e em <em>Instalar app</em> ou <em>Adicionar à tela inicial</em>.</li>
         <li><strong>iPhone (Safari):</strong> toque em Compartilhar (o quadrado com a seta) e em <em>Adicionar à Tela de Início</em>.</li>
       </ul>
       <p>Depois, abra sempre pelo ícone.</p>
       <p>Se a igreja trocou o ícone depois que você instalou: no <strong>iPhone</strong>, o ícone não muda sozinho; apague o app da tela inicial e instale de novo. No <strong>Android</strong>, ele costuma se atualizar sozinho em alguns dias, ou na hora se você desinstalar e instalar de novo.</p>
       <div id="help-install"></div>`,
    ],
    [
      'Entrar no app',
      `<p>Use <strong>o mesmo e-mail que você deu à secretaria</strong>. É por ele que o app encontra o seu cadastro.</p>
       <ul class="bullets">
         <li><strong>Entrar com Google:</strong> o jeito mais rápido, se o seu e-mail for do Gmail.</li>
         <li><strong>Link pelo e-mail:</strong> você recebe um link; abra no mesmo aparelho e navegador em que pediu.</li>
       </ul>
       <p>Na primeira vez, aparece um convite: toque em <em>Aceito participar</em>. Se não for da igreja, toque em <em>Não sou desta igreja</em> e o seu e-mail sai do cadastro.</p>`,
    ],
    [
      'Notificações no celular',
      `<p>Em <a href="#/notificacoes">Menu &gt; Notificações</a>, toque em <em>Ativar neste aparelho</em>. Você recebe:</p>
       <ul class="bullets">
         ${features('aniversarios') ? '<li>a mensagem da igreja no dia do seu aniversário, às 7h;</li>' : ''}
         ${features('datas_especiais') ? '<li>a mensagem no aniversário do seu casamento e do seu batismo, às 7h;</li>' : ''}
         ${features('agenda') ? '<li>os lembretes dos eventos da agenda;</li>' : ''}
         ${features('avisos') ? '<li>os avisos que a liderança mandar com notificação (chegam em até uns 15 minutos);</li>' : ''}
         ${features('oracao') ? '<li>o aviso de quando o seu pedido de oração for para o mural.</li>' : ''}
       </ul>
       <p><strong>No iPhone</strong>, as notificações só funcionam com o app instalado na tela inicial. O sininho no topo guarda tudo, mesmo sem ativar no celular.</p>
       <p>Bloqueou sem querer? Libere as notificações deste site nas configurações do navegador e ative de novo.</p>`,
    ],
    ...(features('agenda')
      ? [[
          'Agenda',
          `<p>A aba <a href="#/agenda">Agenda</a> mostra os cultos e eventos dos próximos 3 meses. Toque num evento para ver os detalhes e o local (que abre no mapa).</p>
           <p><strong>Adicionar à agenda</strong> baixa um arquivo: abra-o para salvar na agenda do celular. Cultos que se repetem entram na agenda toda semana. Se preferir, use o botão <em>Google Agenda</em>.</p>`,
        ]]
      : []),
    ...(features('avisos')
      ? [['Avisos', '<p>A aba <a href="#/avisos">Avisos</a> traz os recados da igreja. Os mais importantes ficam fixados no topo, e alguns somem depois de uma data.</p>']]
      : []),
    ...(datesOn()
      ? [[
          'Aniversariantes',
          `<p>Em <a href="#/aniversariantes">Menu &gt; Aniversariantes do mês</a> você vê quem faz aniversário${features('datas_especiais') ? ' (de vida, de casamento e de batismo)' : ''}, mês a mês, e pode imprimir a lista.</p>
           <p>As suas datas só aparecem para os outros membros se você autorizar em <em>Meu cadastro</em>, e só o dia e o mês, nunca o ano. A liderança sempre vê.</p>`,
        ]]
      : []),
    ...(features('celulas')
      ? [[
          'Minha célula',
          `<p>Em <a href="#/celulas">Menu &gt; Minha célula</a> você vê o dia, o horário e o local da sua célula (o endereço abre no mapa), quem lidera e os outros participantes. O telefone de cada um só aparece se a pessoa autorizou em <em>Meu cadastro</em>.</p>
           <p><strong>Se você lidera a célula</strong> (líder ou auxiliar), toque em <em>Registrar encontro</em> depois de cada encontro: marque quem veio, quantos visitantes vieram e, se quiser, o tema. A lista mostra quem faltou nos últimos encontros, para você procurar. Você também coloca e tira participantes, buscando pelo nome no cadastro da igreja. A presença só é vista por você e pela liderança da igreja.</p>`,
        ]]
      : []),
    ...(features('oracao')
      ? [[
          'Pedidos de oração',
          `<p>Em <a href="#/oracao">Pedidos de oração</a>, toque em <em>Fazer um pedido</em> e escolha para quem vai:</p>
           <ul class="bullets">
             <li><strong>Só para os pastores:</strong> só o pastor (administrador) e os líderes leem. A secretaria não vê.</li>
             <li><strong>Para a igreja orar junto:</strong> vai para o mural depois da aprovação da liderança e fica lá por 30 dias. Se quiser, marque <em>Não mostrar meu nome</em> (a liderança continua vendo quem enviou).</li>
           </ul>
           <p>No mural, toque em <em>Vou orar</em> 🙏 nos pedidos pelos quais você vai orar. Ninguém vê quem tocou, só o total. Em <em>Meus pedidos</em> você acompanha os seus, marca <em>Deus respondeu</em> 🙌 ou apaga.</p>`,
        ]]
      : []),
    ...(offerReady()
      ? [[
          'Dízimos e ofertas',
          `<p>Em <a href="#/ofertar">Dízimos e ofertas</a>, aponte a câmera do app do seu banco para o QR Code, ou toque em <em>Copiar código Pix</em> e cole em <em>Pix &gt; Copia e cola</em>. Se quiser, digite o valor antes: ele já vem preenchido no banco.</p>
           <p>O dinheiro vai direto para a conta da igreja. O app não recebe, não processa e não guarda nada sobre a sua oferta. Confira o nome do recebedor no banco antes de confirmar.</p>`,
        ]]
      : []),
    [
      'Meu cadastro e privacidade',
      `<p>Em <a href="#/perfil">Menu &gt; Meu cadastro</a> você corrige o nome, o telefone, a data de nascimento${features('datas_especiais') ? ', as datas de casamento e de batismo' : ''} e a foto, e escolhe se os outros membros veem essas datas e o seu telefone. Para trocar o e-mail, fale com a secretaria.</p>
       <p>Em <a href="#/meus-dados">Menu &gt; Meus dados</a> você baixa tudo o que o app guarda sobre você, sai desta igreja ou exclui a sua conta.</p>`,
    ],
    [
      'Participo de mais de uma igreja',
      '<p>Cada igreja tem o seu endereço e o seu ícone no celular. Para ir de uma para outra, use <em>Menu &gt; Trocar de igreja</em>.</p>',
    ],
    [
      'Problemas comuns',
      `<ul class="bullets">
         <li><strong>O link de acesso não chegou:</strong> olhe a caixa de spam. Se pedir muitas vezes, o envio espera alguns minutos. Se o seu e-mail for do Gmail, prefira <em>Entrar com Google</em>.</li>
         <li><strong>"Ainda não encontramos seu cadastro":</strong> você entrou com um e-mail diferente do que a secretaria tem. Peça para conferir.</li>
         <li><strong>O app parece desatualizado:</strong> feche e abra de novo.</li>
         <li><strong>A notificação não chega:</strong> confira em <em>Menu &gt; Notificações</em> se está ativada neste aparelho e, no iPhone, se você abriu pelo ícone da tela inicial.</li>
       </ul>`,
    ],
  ];

  const leaders = [
    [
      'O que cada papel faz',
      `<table class="help-table">
         <tr><th>Administrador</th><td>Tudo da liderança, mais: configura a igreja, define os papéis, desliga contas e escreve a mensagem de aniversário.</td></tr>
         <tr><th>Secretaria</th><td>Cadastra, edita, inativa e exclui membros; publica eventos e avisos.</td></tr>
         <tr><th>Líder</th><td>Cadastra, edita e inativa membros (não exclui); publica eventos e avisos${features('oracao') ? '; lê os pedidos de oração só para os pastores e modera o mural' : ''}.</td></tr>
         <tr><th>Membro</th><td>Vê a agenda, os avisos e os aniversariantes que autorizaram; edita os próprios dados.</td></tr>
       </table>
       <p>Administrador, secretaria e líderes formam a liderança: veem o cadastro completo de todos e recebem o resumo dos aniversariantes. Use esse acesso só para cuidar da igreja.</p>`,
    ],
    [
      'Cadastrar membros',
      `<p>Na aba <a href="#/membros">Membros</a>, toque em <em>Novo membro</em>. Só o nome é obrigatório, mas <strong>sem e-mail a pessoa não consegue entrar no app</strong>. Marque que a pessoa concordou em ter os dados no app.</p>
       <p>A etiqueta de cada pessoa mostra a situação:</p>
       <ul class="bullets">
         <li><strong>Ainda não entrou:</strong> tem e-mail, mas ainda não abriu o app. Mande o endereço do app para ela.</li>
         <li><strong>Convite pendente:</strong> já entrou, falta tocar em <em>Aceito participar</em>.</li>
         <li><strong>No app:</strong> tudo certo.</li>
         <li><strong>Sem e-mail:</strong> não entra no app, mas aparece na lista de membros e nos aniversariantes.</li>
       </ul>
       <p>Quem saiu da igreja pode ficar <em>Inativo</em>: some das listas e não acessa o app, mas o cadastro fica guardado.</p>`,
    ],
    [
      'Importar uma planilha de membros',
      `<p>Em <a href="#/membros/importar">Membros &gt; Importar planilha</a>, toque em <em>Baixar modelo</em> e preencha no Excel ou no Google Planilhas, com as colunas <strong>nome</strong>, <strong>email</strong>, <strong>telefone</strong> e <strong>nascimento</strong> (datas como 15/03/1980)${features('datas_especiais') ? '. Se quiser, acrescente <strong>casamento</strong> e <strong>batismo</strong>' : ''}.</p>
       <p>Salve como <strong>CSV</strong> e escolha o arquivo. O app mostra uma prévia antes de gravar: as linhas com erro são explicadas, e quem já tem o e-mail cadastrado é pulado.</p>`,
    ],
    ...(features('agenda')
      ? [[
          'Criar eventos e cultos',
          `<p>Na <a href="#/agenda">Agenda</a>, toque em <em>Novo evento</em>. Para os cultos fixos, marque <strong>Repetir toda semana</strong> (e, se quiser, até quando).</p>
           <p>Escolha o <strong>lembrete</strong>: os membros com notificação ativada recebem 1 hora, 2 horas, 3 horas ou 1 dia antes. Editar ou excluir um evento que se repete vale para todas as semanas.</p>`,
        ]]
      : []),
    ...(features('avisos')
      ? [[
          'Publicar avisos',
          `<p>Em <a href="#/avisos">Avisos</a>, toque em <em>Novo aviso</em>. Você pode <strong>fixar no topo</strong> e escolher <strong>até quando</strong> ele aparece (depois some para os membros, mas a liderança continua vendo).</p>
           <p>Marque <strong>Mandar notificação para os membros</strong> só nos avisos importantes. Isso só pode ser escolhido ao publicar.</p>`,
        ]]
      : []),
    ...(features('celulas')
      ? [[
          'Organizar as células',
          `<p>Em <a href="#/celulas">Menu &gt; Células</a>, toque em <em>Nova célula</em> e preencha o nome, o dia, o horário e o local. Depois, abra a célula e coloque os participantes buscando pelo nome. Ao lado de cada pessoa, escolha quem é <strong>Líder</strong> ou <strong>Auxiliar</strong>: qualquer pessoa do cadastro pode liderar uma célula, mesmo sem outro papel na igreja.</p>
           <p>A lista de células mostra o número de participantes e a <strong>frequência</strong> (a média de presença nos 4 últimos encontros). Embaixo ficam os <strong>membros sem célula</strong>, para encaminhar. Quando uma célula encerrar, desmarque <em>Célula ativa</em> na edição: o histórico fica guardado.</p>`,
        ]]
      : []),
    ...(features('oracao') && isPastoral()
      ? [[
          'Moderar pedidos de oração',
          `<p>O administrador e os líderes recebem uma notificação a cada pedido novo. Em <a href="#/oracao/moderar">Menu &gt; Moderar pedidos de oração</a>:</p>
           <ul class="bullets">
             <li><strong>Para aprovar:</strong> os pedidos para a igreja. Corrija o texto se precisar (por exemplo, para tirar um dado pessoal) e toque em <em>Aprovar</em> ou <em>Não publicar</em>. Quem pediu recebe um aviso.</li>
             <li><strong>Só para os pastores:</strong> os pedidos privados. Marque <em>Já orei / já entrei em contato</em> para a liderança saber que alguém cuidou.</li>
             <li><strong>No mural:</strong> os aprovados dos últimos 30 dias. Dá para tirar um do mural.</li>
           </ul>
           <p>A secretaria não vê os pedidos só para os pastores nem modera o mural. Nos pedidos anônimos, você vê o nome, mas os membros não.</p>`,
        ]]
      : []),
  ];

  const admins = [
    [
      'Configurar a igreja',
      `<p>Em <a href="#/config">Menu &gt; Configurar a igreja</a>:</p>
       <ul class="bullets">
         <li><strong>Aparência:</strong> nome, nome curto (o que aparece embaixo do ícone), logo e cores. Logo em PNG com fundo transparente fica melhor; escolha o fundo do ícone. Se a cor for clara demais, o app avisa.</li>
         <li><strong>Textos e redes sociais:</strong> boas-vindas, sobre a igreja, endereço e links.</li>
         <li><strong>Dízimos e ofertas (Pix):</strong> o tipo e a chave Pix da igreja e o nome do recebedor. Prefira o CNPJ ou uma chave aleatória: a chave fica visível para qualquer pessoa.</li>
         <li><strong>Funcionalidades:</strong> ligue ou desligue a agenda, os avisos, os aniversariantes, as datas especiais, os pedidos de oração, as células e os dízimos e ofertas (este precisa da chave Pix).</li>
         <li><strong>Privacidade:</strong> o e-mail para pedidos sobre dados pessoais e, se quiser, um complemento da política.</li>
       </ul>
       <p>O nome e o ícone do app instalado mudam em até 15 minutos, quando o site é publicado de novo sozinho. Até lá, o botão de instalar avisa que o ícone está sendo preparado. Quem já instalou pode precisar reinstalar para ver o ícone novo.</p>`,
    ],
    ...(features('aniversarios')
      ? [[
          'Mensagem de aniversário',
          `<p>Em <a href="#/config/aniversario">Menu &gt; Mensagem de aniversário</a>, escreva o título e o texto. Toque nos campos para colocar no texto: <code>{nome}</code>, <code>{primeiro_nome}</code>, <code>{igreja}</code> e <code>{idade}</code>. A prévia mostra como fica. Para alegrar, toque nos emojis embaixo (🎂 🎉 🙏…) ou use os do teclado do celular.</p>
           <p>A mensagem sai às 7h (horário de Brasília). Quem nasceu em 29/02 recebe em 28/02 nos anos que não são bissextos. Você pode pôr uma imagem e ligar o <strong>resumo para a liderança</strong> (aniversariantes do dia e, às segundas, os da semana).</p>
           <p>Ela vai por notificação no celular (para quem ativou), fica na central do app e vai por e-mail para quem tem e-mail no cadastro.</p>`,
        ]]
      : []),
    ...(features('datas_especiais')
      ? [[
          'Aniversário de casamento e de batismo',
          `<p>A secretaria (ou o próprio membro, em <em>Meu cadastro</em>) preenche a <strong>data de casamento</strong> e a <strong>data de batismo</strong>. No aniversário dessas datas, às 7h, a pessoa recebe a mensagem da igreja, do mesmo jeito que no aniversário: notificação, central do app e e-mail.</p>
           <p>Os textos ficam em <a href="#/config/casamento">Menu &gt; Mensagem de casamento</a> e <a href="#/config/batismo">Menu &gt; Mensagem de batismo</a>. Use <code>{anos}</code> para o tempo que a pessoa completa (vira "1 ano", "10 anos"). No casamento, cada cônjuge recebe a sua mensagem.</p>
           <p>As datas também entram no resumo da liderança e na lista do mês. Os e-mails dividem o limite diário com os aniversários: o que passar sai no dia seguinte.</p>`,
        ]]
      : []),
    [
      'Papéis, contas e exclusões',
      `<ul class="bullets">
         <li>Para mudar o papel de alguém, abra a ficha em <em>Membros</em> e escolha o papel. A igreja precisa ter sempre pelo menos um administrador.</li>
         <li>Se a pessoa errada entrou com um e-mail, use <em>Desligar a conta do app</em> na ficha. Depois você pode corrigir o e-mail.</li>
         <li><em>Excluir cadastro</em> apaga os dados e a foto de vez (administrador e secretaria).</li>
       </ul>`,
    ],
    [
      'Divulgar o app para a igreja',
      `<p>Mande este endereço pelo WhatsApp ou mostre no telão. Cada pessoa entra com o e-mail que a secretaria cadastrou.</p>
       <div class="copy-row"><code id="app-url">${esc(PAGE_URL)}</code><button class="btn small" id="copy-url" type="button">Copiar</button></div>`,
    ],
  ];

  const role = myRole();
  return [
    { title: 'Para todos', items: everyone },
    ...(isLeaderRole(role) ? [{ title: 'Para a liderança', items: leaders }] : []),
    ...(role === 'admin' ? [{ title: 'Para o administrador', items: admins }] : []),
  ];
}

async function viewHelp() {
  if (!requireLogin('/ajuda')) return;
  if (!isActiveMember()) return navigate('/');
  const groups = helpTopics();
  $view.innerHTML = `
    <div class="page help-page">
      <h1>Ajuda</h1>
      <p class="hint">Como usar o app da ${esc(state.church.name)}. Toque num assunto para abrir.</p>
      ${groups
        .map(
          (g) => `
        <h2>${g.title}</h2>
        ${g.items.map(([title, body]) => `<details class="help-item"><summary>${esc(title)}</summary><div class="help-body">${body}</div></details>`).join('')}`,
        )
        .join('')}
      ${state.platformAdmin ? `<p class="hint">Administrador da plataforma: novas igrejas são criadas em <a href="${esc(ROOT_URL)}#/plataforma">Plataforma</a>.</p>` : ''}
      <p class="hint">Ainda com dúvida? Fale com a secretaria da igreja.</p>
    </div>`;

  const installBox = document.getElementById('help-install');
  const st = installState();
  installBox.innerHTML =
    st === 'instalado'
      ? '<p class="ok">✓ Você já está usando o app instalado.</p>'
      : !iconReady(state.church)
        ? `<p class="notice">${ICON_PREPARING}</p>`
        : st === 'android' || st === 'iphone'
        ? '<button class="btn primary small" id="install-now" type="button">Instalar agora</button>'
        : '';
  document.getElementById('install-now')?.addEventListener('click', async () => {
    if (await installNow()) toast('App instalado.');
  });
  document.getElementById('copy-url')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(PAGE_URL);
      toast('Endereço copiado.');
    } catch {
      toast('Não foi possível copiar. Selecione o endereço e copie.', 'error');
    }
  });
}

// Sem nenhuma igreja, este aparelho não tem por que continuar recebendo notificações.
async function disablePushIfNoChurches() {
  await loadMemberships();
  if (!state.memberships.length) await disablePush(sb).catch(() => {});
}

// Datas de casamento e batismo (com a funcionalidade "datas_especiais" ligada).
function specialDateFields(m) {
  if (!featureOn('datas_especiais')) return '';
  return `
      <label>Data de casamento<input name="wedding_date" type="date" min="1900-01-01" value="${esc(m.wedding_date || '')}"></label>
      <label>Data de batismo<input name="baptism_date" type="date" min="1900-01-01" value="${esc(m.baptism_date || '')}"></label>`;
}

function specialDatesPatch(form, withConsent = false) {
  if (!form.wedding_date) return {};
  return {
    wedding_date: form.wedding_date.value || null,
    baptism_date: form.baptism_date.value || null,
    ...(withConsent ? { show_wedding: form.show_wedding.checked, show_baptism: form.show_baptism.checked } : {}),
  };
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
      ${specialDateFields(m)}
      <fieldset class="card">
        <legend>O que os outros membros veem</legend>
        <p class="hint">A liderança da igreja sempre vê os seus dados. Os outros membros veem só o seu nome, a não ser que você autorize:</p>
        <label class="check"><input type="checkbox" name="show_birthday" ${m.show_birthday ? 'checked' : ''}> Meu aniversário (dia e mês, nunca o ano)</label>
        ${
          featureOn('datas_especiais')
            ? `<label class="check"><input type="checkbox" name="show_wedding" ${m.show_wedding ? 'checked' : ''}> Meu aniversário de casamento (dia e mês)</label>
               <label class="check"><input type="checkbox" name="show_baptism" ${m.show_baptism ? 'checked' : ''}> Meu aniversário de batismo (dia e mês)</label>`
            : ''
        }
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
        ...specialDatesPatch(form, true),
      };
      if (photo.file) patch.photo_path = await uploadMemberPhoto(m.church_id, m.id, photo.file);
      else if (photo.removed && m.photo_path) {
        await removeMemberPhotos(m.church_id, m.id);
        patch.photo_path = null;
      }
      const { error: err } = await sb.from('members').update(patch).eq('id', m.id);
      if (err) throw err;
      forgetMembers();
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

// Links das fotos (válidos por 1 hora) guardados em memória por 50 minutos: o mesmo link
// deixa o navegador reaproveitar a foto já baixada, em vez de baixar tudo de novo.
const photoLinks = new Map(); // caminho -> { url, until }

async function signedPhotos(paths) {
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const p of paths) {
    const hit = photoLinks.get(p);
    if (hit && hit.until > now) out[p] = hit.url;
    else missing.push(p);
  }
  if (!missing.length) return out;
  const { data, error } = await sb.storage.from('membros').createSignedUrls(missing, 3600);
  if (error) return out;
  for (const d of data) {
    if (!d.signedUrl) continue;
    photoLinks.set(d.path, { url: d.signedUrl, until: now + 50 * 60 * 1000 });
    out[d.path] = d.signedUrl;
  }
  return out;
}

// Lista de membros da última abertura da tela, em memória (some ao fechar o app).
// Mostra na hora ao voltar para a lista; o banco confirma em seguida.
const membersCache = new Map(); // igreja -> membros
const forgetMembers = () => {
  membersCache.delete(state.church?.id);
  membersLoading.delete(state.church?.id);
};

// Uma busca por vez: quem chega enquanto ela está a caminho aproveita a mesma resposta.
const membersLoading = new Map(); // igreja -> busca em andamento
function fetchMembers(churchId) {
  if (!membersLoading.has(churchId)) {
    const p = (async () => {
      const { data, error } = await sb.from('members').select(MEMBER_COLUMNS).eq('church_id', churchId).order('name');
      if (error) throw error;
      if (membersLoading.get(churchId) === p) membersCache.set(churchId, data); // não foi descartada por uma mudança
      return data;
    })().finally(() => {
      if (membersLoading.get(churchId) === p) membersLoading.delete(churchId);
    });
    membersLoading.set(churchId, p);
  }
  return membersLoading.get(churchId);
}

// No Início, a liderança já busca a lista em segundo plano: a tela Membros abre na hora.
function prefetchMembers() {
  const id = state.church?.id;
  if (!id || !isLeaderRole(myRole()) || membersCache.has(id)) return;
  setTimeout(
    () =>
      fetchMembers(id)
        .then((ms) => signedPhotos(ms.filter((m) => m.photo_path).map((m) => miniOf(m.photo_path))))
        .catch(() => {}),
    300,
  );
}

async function removeMemberPhotos(churchId, memberId) {
  const bucket = sb.storage.from('membros');
  const dir = `${churchId}/${memberId}`;
  for (const p of photoLinks.keys()) if (p.startsWith(`${dir}/`)) photoLinks.delete(p);
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

const MEMBER_COLUMNS = 'id, church_id, name, email, phone, birth_date, role, status, user_id, consent_at, photo_path, show_birthday, show_phone, wedding_date, baptism_date, show_wedding, show_baptism';

async function viewMembers(ctx) {
  if (!requireLeader('/membros')) return;
  const churchId = state.church.id;
  let members = membersCache.get(churchId);
  const fresh = fetchMembers(churchId);
  if (!members) {
    $view.innerHTML = '<div class="page"><h1>Membros</h1><div class="loading">Carregando…</div></div>';
    members = await fresh;
  } else {
    fresh.catch(() => {}); // a lista guardada já está na tela; a nova chega em seguida
  }
  if (!ctx.alive()) return;
  // As fotos chegam depois da lista: até lá, as iniciais.
  let minis = {};
  const loadPhotos = async () => {
    minis = await signedPhotos(members.filter((m) => m.photo_path).map((m) => miniOf(m.photo_path)));
    if (ctx.alive()) draw();
  };

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
  loadPhotos().catch(() => {});

  // Lista guardada na tela: confere com o banco e redesenha se mudou.
  const latest = await fresh.catch(() => null);
  if (latest && ctx.alive() && JSON.stringify(latest) !== JSON.stringify(members)) {
    members = latest;
    draw();
    loadPhotos().catch(() => {});
  }
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
      ${specialDateFields(m)}
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
            <p class="hint">Autorizações do membro: aniversário ${m.show_birthday ? 'visível' : 'oculto'}${featureOn('datas_especiais') ? `, casamento ${m.show_wedding ? 'visível' : 'oculto'}, batismo ${m.show_baptism ? 'visível' : 'oculto'}` : ''} e telefone ${m.show_phone ? 'visível' : 'oculto'} para os outros membros.</p>`
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
      const row = { name: form.name.value.trim(), phone, birth_date: form.birth_date.value || null, ...specialDatesPatch(form) };
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
      forgetMembers();
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
    forgetMembers();
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
      forgetMembers();
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
        <p>Use uma planilha com as colunas <strong>nome</strong>, <strong>email</strong>, <strong>telefone</strong> e <strong>nascimento</strong>${featureOn('datas_especiais') ? ' (e, se quiser, <strong>casamento</strong> e <strong>batismo</strong>)' : ''} na primeira linha. Só o nome é obrigatório.</p>
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
    const special = rows.some((r) => r.wedding_date || r.baptism_date);
    const tooMany = ok.length > Math.min(room, IMPORT_MAX);

    box.innerHTML = `
      <div class="card">
        <h2>${ok.length} ${ok.length === 1 ? 'pessoa pronta' : 'pessoas prontas'} para importar</h2>
        ${skipped.length ? `<p class="hint">${skipped.length} pulada(s): já cadastrada(s) ou com e-mail repetido.</p>` : ''}
        ${bad.length ? `<p class="hint warn">${bad.length} linha(s) com erro não serão importadas. Corrija na planilha e importe de novo, se quiser.</p>` : ''}
        ${tooMany ? `<p class="hint warn">A igreja pode cadastrar mais ${Math.max(room, 0)} pessoa(s) no plano atual (e até ${IMPORT_MAX} por planilha).</p>` : ''}
        <div class="table-wrap">
          <table class="preview-table">
            <thead><tr><th>Linha</th><th>Situação</th><th>Nome</th><th>E-mail</th><th>Telefone</th><th>Nascimento</th>${special ? '<th>Casamento</th><th>Batismo</th>' : ''}</tr></thead>
            <tbody>
              ${rows
                .slice(0, 300)
                .map(
                  (r) => `
                <tr class="${r.errors.length ? 'bad' : r.skip ? 'skip' : ''}">
                  <td>${r.line}</td><td>${esc(r.errors.join(', ') || r.skip || 'ok')}</td>
                  <td>${esc(r.name)}</td><td>${esc(r.email || '')}</td>
                  <td>${esc(fmtPhone(r.phone))}</td><td>${esc(fmtDate(r.birth_date))}</td>
                  ${special ? `<td>${esc(fmtDate(r.wedding_date))}</td><td>${esc(fmtDate(r.baptism_date))}</td>` : ''}
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
            ...(r.wedding_date ? { wedding_date: r.wedding_date } : {}),
            ...(r.baptism_date ? { baptism_date: r.baptism_date } : {}),
          }));
          const { error: err } = await sb.from('members').insert(batch);
          if (err) throw err;
          forgetMembers();
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
      ${messageLinks()}

      <fieldset class="card">
        <legend>Aparência</legend>
        <label>Nome da igreja<input name="name" required minlength="2" maxlength="80" value="${esc(c.name)}"></label>
        <label>Nome curto (embaixo do ícone no celular)<input name="short_name" maxlength="20" value="${esc(c.short_name || '')}" placeholder="${esc(c.name.slice(0, 20))}"></label>
        <p class="hint">É o nome que aparece embaixo do ícone do app instalado. Deixe em branco para usar o começo do nome da igreja.</p>
        <div class="logo-picker">
          <div class="icon-with-name">
            <div class="icon-preview" id="icon-preview" style="background:${esc(c.icon_background)}">
              <img id="logo-preview" src="${esc(c.logo_url || 'icons/icon-192.png')}" alt="">
            </div>
            <span id="icon-name" aria-label="Nome embaixo do ícone">${esc(c.short_name || c.name.slice(0, 20))}</span>
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
        <legend>${icon.pix} Dízimos e ofertas (Pix)</legend>
        <p class="hint">Com a funcionalidade ligada, a tela <em>Dízimos e ofertas</em> mostra o QR Code e a chave da igreja. O dinheiro vai direto para a conta da igreja: o app não recebe nem registra pagamentos.</p>
        <div class="pix-row">
          <label>Tipo de chave
            <select name="pix_type">
              ${Object.entries(PIX_TYPES).map(([k, v]) => `<option value="${k}" ${k === (c.pix_key ? guessPixType(c.pix_key) : 'cpf') ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>
          <label>Chave Pix<input name="pix_key" maxlength="120" autocomplete="off" value="${esc(c.pix_key ? formatPixKey(c.pix_key) : '')}"></label>
        </div>
        <label>Nome do recebedor (como aparece no banco)<input name="pix_name" maxlength="25" value="${esc(c.pix_name || '')}" placeholder="${esc(c.name.slice(0, 25))}"></label>
        <p class="hint">A chave fica visível para qualquer pessoa que abrir a página da igreja, mesmo sem entrar. Prefira o CNPJ ou uma chave aleatória da conta da igreja.</p>
        <div class="notice warn-box" id="pix-cpf-warning" hidden><p>Se a chave for um <strong>CPF</strong>, ele fica público. Use o CPF de uma pessoa só se ela concordar.</p></div>
      </fieldset>

      <fieldset class="card">
        <legend>Funcionalidades</legend>
        ${FEATURES.map(
          (f) => `
          <label class="check ${f.soon ? 'disabled' : ''}">
            <input type="checkbox" name="feature_${f.key}" ${c.features?.[f.key] ? 'checked' : ''} ${f.soon ? 'disabled' : ''}>
            ${esc(f.label)}${f.soon ? ` <small>(em breve)</small>` : ''}
          </label>`,
        ).join('')}
      </fieldset>

      <fieldset class="card">
        <legend>Privacidade</legend>
        <label>E-mail para pedidos sobre dados pessoais<input name="privacy_email" type="email" maxlength="160" value="${esc(c.privacy_email || '')}"></label>
        <label>Complemento da política de privacidade (opcional)<textarea name="privacy_text" rows="4" maxlength="8000" placeholder="Quem cuida dos dados na igreja, por quanto tempo eles ficam guardados…">${esc(c.privacy_text || '')}</textarea></label>
      </fieldset>

      <button class="btn primary big">Salvar</button>
      <p class="hint">O nome e o ícone do app instalado na tela inicial mudam em até 15 minutos. Quem já instalou pode precisar reinstalar para ver o ícone novo.</p>
    </form>`;

  const form = document.getElementById('settings');
  let logoFile = null;
  const colorWarn = () => (document.getElementById('color-warn').hidden = readableOnWhite(form.primary_color.value));
  colorWarn();
  form.primary_color.addEventListener('input', colorWarn);
  form.icon_background.addEventListener('input', () => (document.getElementById('icon-preview').style.background = form.icon_background.value));
  // Nome embaixo do ícone no celular: o nome curto, ou o começo do nome da igreja.
  const iconName = () => {
    const name = form.name.value.trim();
    document.getElementById('icon-name').textContent = form.short_name.value.trim() || name.slice(0, 20);
    form.short_name.placeholder = name.slice(0, 20);
  };
  form.name.addEventListener('input', iconName);
  form.short_name.addEventListener('input', iconName);
  const cpfWarn = () => {
    const key = form.pix_key.value.trim();
    document.getElementById('pix-cpf-warning').hidden = !(form.pix_type.value === 'cpf' && key.replace(/\D/g, '').length === 11);
  };
  cpfWarn();
  form.pix_type.addEventListener('change', cpfWarn);
  form.pix_key.addEventListener('input', cpfWarn);
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
      for (const f of FEATURES) if (!f.soon) features[f.key] = form[`feature_${f.key}`].checked;
      const pixRaw = form.pix_key.value.trim();
      const pix_key = pixRaw ? normalizePixKey(form.pix_type.value, pixRaw) : null;
      if (pixRaw && !pix_key) throw new Error(`Chave Pix inválida para o tipo "${PIX_TYPES[form.pix_type.value]}".`);
      if (features.pix && !pix_key) throw new Error('Para ligar Dízimos e ofertas, preencha a chave Pix da igreja.');

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
        pix_key,
        pix_name: pix_key ? form.pix_name.value.trim() || null : null,
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
      saveBootCache();
      applyBranding();
      toast(
        saved.branding_version > c.branding_version
          ? 'Pronto! Em até 15 minutos o app passa a instalar com o ícone novo.'
          : 'Configuração salva.',
      );
      render();
    } catch (err) {
      toast(errorText(err), 'error');
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
}

// ---------------------------------------------------------------------
// Dízimos e ofertas: QR Code e chave Pix da igreja. Aberta a todos, como a chave
// na tabela de igrejas. O app não recebe nem registra pagamentos.
// ---------------------------------------------------------------------
async function viewOffer() {
  const c = state.church;
  if (!offerReady()) {
    $view.innerHTML = `<div class="empty"><h2>Dízimos e ofertas</h2><p>A igreja ainda não informou uma chave Pix.</p><a class="btn" href="#/">Voltar</a></div>`;
    return;
  }
  const receiver = c.pix_name || c.name;
  $view.innerHTML = `
    <div class="page offer">
      <h1>Dízimos e ofertas</h1>
      <p>Aponte a câmera do app do seu banco para o QR Code ou copie o código e cole em <strong>Pix &gt; Copia e cola</strong>.</p>
      <label>Valor (opcional)<input id="offer-amount" inputmode="decimal" autocomplete="off" placeholder="R$ 0,00"></label>
      <p class="hint warn" id="offer-amount-error" hidden>Valor inválido. Use, por exemplo, 50 ou 50,00.</p>
      <div class="qr" id="offer-qr">Gerando QR Code…</div>
      <button class="btn primary big" id="copy-code" type="button">Copiar código Pix (copia e cola)</button>
      <section class="card">
        <h2>Chave Pix</h2>
        <p class="key"><strong>${esc(formatPixKey(c.pix_key))}</strong></p>
        <button class="btn small" id="copy-key" type="button">Copiar chave</button>
        <p class="hint">Recebedor: <strong>${esc(receiver)}</strong>. Confira o nome no app do banco antes de confirmar.</p>
      </section>
      <p class="hint">O dinheiro vai direto para a conta da igreja. O app não recebe, não processa e não registra nenhum pagamento.</p>
    </div>`;

  let code = '';
  let drawId = 0;
  const draw = async () => {
    const amount = parseAmount(document.getElementById('offer-amount').value);
    document.getElementById('offer-amount-error').hidden = amount !== null;
    if (amount === null) return;
    const id = ++drawId;
    code = pixPayload({ key: c.pix_key, name: receiver, city: c.city || undefined, amount });
    const box = document.getElementById('offer-qr');
    try {
      const svg = await qrSvg(code);
      if (id === drawId && box) box.innerHTML = svg;
    } catch (err) {
      if (box) box.textContent = err.message;
    }
  };
  const copy = async (text, done) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      prompt('Copie:', text);
    }
  };
  document.getElementById('offer-amount').addEventListener('input', draw);
  document.getElementById('copy-code').onclick = () => {
    if (parseAmount(document.getElementById('offer-amount').value) === null) return toast('Confira o valor.', 'error');
    copy(code, 'Código Pix copiado! Cole no app do seu banco, em Pix > Copia e cola.');
  };
  document.getElementById('copy-key').onclick = () => copy(c.pix_key, 'Chave Pix copiada.');
  await draw();
}

// ---------------------------------------------------------------------
// Agenda (cultos e eventos) e mural de avisos
// ---------------------------------------------------------------------
const fmtHour = (d) => `${d.getHours()}h${d.getMinutes() ? String(d.getMinutes()).padStart(2, '0') : ''}`;
const fmtDayShort = (d) => d.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');

function fmtEventWhen(ev) {
  const s = new Date(ev.starts_at);
  const e = ev.ends_at ? new Date(ev.ends_at) : null;
  const label = dayLabel(isoLocal(s));
  const day = ['Hoje', 'Amanhã'].includes(label) ? label : fmtDayShort(s);
  if (!e) return `${day} · ${fmtHour(s)}`;
  return isoLocal(e) === isoLocal(s) ? `${day} · ${fmtHour(s)}–${fmtHour(e)}` : `${day} · ${fmtHour(s)} até ${fmtDayShort(e)} ${fmtHour(e)}`;
}

const mapsUrl = (place) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;

async function fetchEvents(from, to) {
  const { data, error } = await sb.rpc('events_between', { p_church: state.church.id, p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) throw error;
  return data;
}

function eventCard(ev) {
  return `
    <a class="event-card" href="#/agenda/${ev.event_id}?em=${encodeURIComponent(ev.starts_at)}">
      <span class="event-time">${esc(fmtHour(new Date(ev.starts_at)))}</span>
      <span><strong>${esc(ev.title)}</strong>
        ${ev.location ? `<small>${icon.pin}${esc(ev.location)}</small>` : ''}
        ${ev.repeat_weekly ? '<small>Toda semana</small>' : ''}</span>
      ${icon.chevron}
    </a>`;
}

function requireMemberFeature(next, key) {
  if (!requireLogin(next)) return false;
  if (!isActiveMember()) {
    navigate('/');
    return false;
  }
  if (featureOn(key)) return true;
  $view.innerHTML = `<div class="empty"><h2>Desligado nesta igreja</h2><a class="btn" href="#/">Voltar</a></div>`;
  return false;
}

async function homeEventsCard(el) {
  if (!isActiveMember()) return;
  const now = new Date();
  const rows = (await fetchEvents(now, addDays(now, 8))).slice(0, 3);
  if (!rows.length || !el.isConnected) return;
  el.innerHTML = `
    <section class="card">
      <h2>${icon.calendar} Próximos eventos</h2>
      <div class="list">${rows
        .map(
          (ev) => `
        <a class="event-card" href="#/agenda/${ev.event_id}?em=${encodeURIComponent(ev.starts_at)}">
          <span><strong>${esc(ev.title)}</strong><small>${esc(fmtEventWhen(ev))}</small></span>${icon.chevron}
        </a>`,
        )
        .join('')}</div>
      <a href="#/agenda">Ver a agenda</a>
    </section>`;
}

async function homeNoticesCard(el) {
  if (!isActiveMember()) return;
  const { data } = await sb
    .from('announcements')
    .select('id, title, body, pinned, created_at')
    .eq('church_id', state.church.id)
    .or(`visible_until.is.null,visible_until.gte.${isoLocal(new Date())}`)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(2);
  if (!data?.length || !el.isConnected) return;
  el.innerHTML = `
    <section class="card">
      <h2>${icon.megaphone} Avisos</h2>
      ${data
        .map(
          (a) => `
        <article class="notice-mini">
          <strong>${a.pinned ? '<span class="tag role">Fixado</span> ' : ''}${esc(a.title)}</strong>
          <p class="pre clamp">${esc(a.body)}</p>
        </article>`,
        )
        .join('')}
      <a href="#/avisos">Ver todos os avisos</a>
    </section>`;
}

async function viewAgenda(ctx) {
  if (!requireMemberFeature('/agenda', 'agenda')) return;
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const rows = await fetchEvents(from, addDays(from, 90));
  if (!ctx.alive()) return;
  const byDay = new Map();
  for (const ev of rows) {
    const day = isoLocal(new Date(ev.starts_at));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(ev);
  }
  $view.innerHTML = `
    <div class="page">
      <h1>Agenda</h1>
      ${isLeaderRole(myRole()) ? `<div class="actions-row"><a class="btn primary" href="#/agenda/novo">${icon.plus} Novo evento</a></div>` : ''}
      ${
        rows.length
          ? [...byDay]
              .map(([day, list]) => {
                const label = dayLabel(day);
                const long = parseIso(day).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
                return `
            <section class="agenda-day">
              <h2>${['Hoje', 'Amanhã'].includes(label) ? `${label}, ${long.split(',')[0]}` : long.charAt(0).toUpperCase() + long.slice(1)}</h2>
              <div class="list">${list.map(eventCard).join('')}</div>
            </section>`;
              })
              .join('')
          : `<div class="empty"><p>Nenhum evento nos próximos 3 meses.</p></div>`
      }
    </div>`;
}

function downloadIcs(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function viewEvent(ctx, id) {
  if (!requireMemberFeature(`/agenda/${id}`, 'agenda')) return;
  const { data: ev, error } = await sb.from('events').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!ctx.alive()) return;
  if (!ev) {
    $view.innerHTML = `<div class="empty"><h2>Evento não encontrado</h2><a class="btn" href="#/agenda">Voltar à agenda</a></div>`;
    return;
  }
  // Ocorrência escolhida na agenda (eventos semanais): mesma duração, outra data.
  const em = new Date(ctx.params.get('em') || ev.starts_at);
  const start = Number.isNaN(em.getTime()) ? new Date(ev.starts_at) : em;
  const dur = ev.ends_at ? new Date(ev.ends_at) - new Date(ev.starts_at) : null;
  const occ = { ...ev, starts_at: start.toISOString(), ends_at: dur ? new Date(start.getTime() + dur).toISOString() : null };
  const leader = isLeaderRole(myRole());
  const remind = REMIND_OPTIONS.find(([m]) => m === ev.remind_minutes)?.[1];
  const calOpts = { church: state.church.name, url: `${PAGE_URL}#/agenda/${ev.id}` };

  $view.innerHTML = `
    <div class="page">
      <a href="#/agenda" class="back">← Agenda</a>
      <h1>${esc(ev.title)}</h1>
      <p class="meta">${icon.clock}${esc(fmtEventWhen(occ))}</p>
      ${ev.location ? `<p class="meta">${icon.pin}<a href="${esc(mapsUrl(ev.location))}" target="_blank" rel="noopener">${esc(ev.location)}</a></p>` : ''}
      ${ev.repeat_weekly ? `<p class="hint">Repete toda semana${ev.repeat_until ? ` até ${esc(fmtDate(ev.repeat_until))}` : ''}.</p>` : ''}
      ${ev.description ? `<div class="card"><p class="pre">${esc(ev.description)}</p></div>` : ''}
      ${ev.remind_minutes ? `<p class="hint">${icon.bell} Lembrete por notificação ${esc(remind.toLowerCase())}.</p>` : ''}
      <div class="actions-row">
        <button class="btn primary" id="ics">${icon.calendar} Adicionar à agenda</button>
        <a class="btn" href="${esc(googleCalendarUrl(ev, calOpts))}" target="_blank" rel="noopener">Google Agenda</a>
      </div>
      ${ev.repeat_weekly ? '<p class="hint">Na sua agenda, entra a série inteira (toda semana).</p>' : ''}
      ${
        leader
          ? `<div class="actions-row">
              <a class="btn" href="#/agenda/${ev.id}/editar">Editar</a>
              <button class="btn danger-outline" id="delete">Excluir</button>
            </div>`
          : ''
      }
    </div>`;

  document.getElementById('ics').onclick = () => {
    downloadIcs(`evento-${isoLocal(new Date(ev.starts_at))}.ics`, icsForEvent(ev, calOpts));
    toast('Abra o arquivo baixado para salvar na agenda do celular.');
  };
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!confirm(ev.repeat_weekly ? `Excluir "${ev.title}" e todas as repetições?` : `Excluir "${ev.title}"?`)) return;
    const { data, error: err } = await sb.from('events').delete().eq('id', ev.id).select('id');
    if (err || !data.length) return toast(err ? errorText(err) : 'Você não tem permissão para excluir.', 'error');
    toast('Evento excluído.');
    navigate('/agenda');
  });
}

const timeValue = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

async function viewEventForm(ctx, id) {
  if (!requireMemberFeature(id ? `/agenda/${id}/editar` : '/agenda/novo', 'agenda')) return;
  if (!isLeaderRole(myRole())) return navigate('/agenda');
  let ev = { title: '', description: '', location: '', starts_at: null, ends_at: null, repeat_weekly: false, repeat_until: null, remind_minutes: 120 };
  if (id) {
    const { data, error } = await sb.from('events').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return navigate('/agenda');
    ev = data;
  }
  if (!ctx.alive()) return;
  const s = ev.starts_at ? new Date(ev.starts_at) : null;
  const e = ev.ends_at ? new Date(ev.ends_at) : null;

  $view.innerHTML = `
    <form id="event" class="form page">
      <a href="${id ? `#/agenda/${id}` : '#/agenda'}" class="back">← ${id ? 'Evento' : 'Agenda'}</a>
      <h1>${id ? 'Editar evento' : 'Novo evento'}</h1>
      <label>Título<input name="title" required minlength="3" maxlength="120" value="${esc(ev.title)}" placeholder="Culto de domingo"></label>
      <label>Data<input name="date" type="date" required value="${s ? isoLocal(s) : ''}"></label>
      <div class="colors">
        <label>Começa<input name="start" type="time" required value="${s ? timeValue(s) : ''}"></label>
        <label>Termina (opcional)<input name="end" type="time" value="${e ? timeValue(e) : ''}"></label>
      </div>
      <label>Local (opcional)<input name="location" maxlength="200" value="${esc(ev.location || '')}" placeholder="Templo principal"></label>
      <label>Descrição (opcional)<textarea name="description" rows="4" maxlength="2000">${esc(ev.description || '')}</textarea></label>
      <label class="check"><input type="checkbox" name="repeat_weekly" ${ev.repeat_weekly ? 'checked' : ''}> Repetir toda semana</label>
      <label id="until-box" ${ev.repeat_weekly ? '' : 'hidden'}>Repetir até (opcional)<input name="repeat_until" type="date" value="${esc(ev.repeat_until || '')}"></label>
      <label>Lembrete por notificação
        <select name="remind_minutes">${REMIND_OPTIONS.map(([m, label]) => `<option value="${m}" ${ev.remind_minutes === m ? 'selected' : ''}>${label}</option>`).join('')}</select>
      </label>
      ${id && ev.repeat_weekly ? '<p class="hint">As mudanças valem para todas as repetições.</p>' : ''}
      <button class="btn primary big">${id ? 'Salvar' : 'Criar evento'}</button>
    </form>`;

  const form = document.getElementById('event');
  form.repeat_weekly.addEventListener('change', () => (document.getElementById('until-box').hidden = !form.repeat_weekly.checked));
  form.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const start = new Date(`${form.date.value}T${form.start.value}`);
    let end = form.end.value ? new Date(`${form.date.value}T${form.end.value}`) : null;
    if (end && end <= start) end = new Date(end.getTime() + 864e5); // termina depois da meia-noite
    const weekly = form.repeat_weekly.checked;
    const until = weekly ? form.repeat_until.value || null : null;
    if (until && until < form.date.value) return toast('"Repetir até" precisa ser depois da data do evento.', 'error');
    const row = {
      title: form.title.value.trim(),
      description: form.description.value.trim() || null,
      location: form.location.value.trim() || null,
      starts_at: start.toISOString(),
      ends_at: end ? end.toISOString() : null,
      repeat_weekly: weekly,
      repeat_until: until,
      remind_minutes: Number(form.remind_minutes.value),
    };
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = id
      ? await sb.from('events').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id).select('id').single()
      : await sb.from('events').insert({ ...row, church_id: state.church.id }).select('id').single();
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    toast(id ? 'Evento salvo.' : 'Evento criado.');
    navigate(`/agenda/${data.id}`);
  });
}

async function viewAnnouncements(ctx) {
  if (!requireMemberFeature('/avisos', 'avisos')) return;
  const { data: rows, error } = await sb
    .from('announcements')
    .select('id, title, body, pinned, visible_until, push, created_at')
    .eq('church_id', state.church.id)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  if (!ctx.alive()) return;
  const leader = isLeaderRole(myRole());
  const today = isoLocal(new Date());
  $view.innerHTML = `
    <div class="page">
      <h1>Avisos</h1>
      ${leader ? `<div class="actions-row"><a class="btn primary" href="#/avisos/novo">${icon.plus} Novo aviso</a></div>` : ''}
      ${
        rows.length
          ? rows
              .map((a) => {
                const expired = a.visible_until && a.visible_until < today;
                return `
            <article class="card announcement ${expired ? 'expired' : ''}">
              <div class="tags-row">
                ${a.pinned ? '<span class="tag role">Fixado</span>' : ''}
                ${expired ? '<span class="tag">Vencido (só a liderança vê)</span>' : a.visible_until && leader ? `<span class="tag">Até ${esc(fmtDate(a.visible_until))}</span>` : ''}
              </div>
              <h2>${esc(a.title)}</h2>
              <p class="pre">${esc(a.body)}</p>
              <p class="hint">${esc(new Date(a.created_at).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' }))}</p>
              ${leader ? `<div class="actions-row"><a class="btn small" href="#/avisos/${a.id}/editar">Editar</a><button class="btn small danger-outline" data-delete="${a.id}">Excluir</button></div>` : ''}
            </article>`;
              })
              .join('')
          : `<div class="empty"><p>Nenhum aviso por enquanto.</p></div>`
      }
    </div>`;
  $view.querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Excluir este aviso?')) return;
      const { data, error: err } = await sb.from('announcements').delete().eq('id', b.dataset.delete).select('id');
      if (err || !data.length) return toast(err ? errorText(err) : 'Você não tem permissão para excluir.', 'error');
      toast('Aviso excluído.');
      render();
    };
  });
}

async function viewAnnouncementForm(ctx, id) {
  if (!requireMemberFeature(id ? `/avisos/${id}/editar` : '/avisos/novo', 'avisos')) return;
  if (!isLeaderRole(myRole())) return navigate('/avisos');
  let a = { title: '', body: '', pinned: false, visible_until: null };
  if (id) {
    const { data, error } = await sb.from('announcements').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return navigate('/avisos');
    a = data;
  }
  if (!ctx.alive()) return;
  $view.innerHTML = `
    <form id="notice" class="form page">
      <a href="#/avisos" class="back">← Avisos</a>
      <h1>${id ? 'Editar aviso' : 'Novo aviso'}</h1>
      <label>Título<input name="title" required minlength="3" maxlength="120" value="${esc(a.title)}"></label>
      <label>Aviso<textarea name="body" required rows="6" maxlength="4000">${esc(a.body)}</textarea></label>
      <label class="check"><input type="checkbox" name="pinned" ${a.pinned ? 'checked' : ''}> Fixar no topo</label>
      <label>Mostrar até (opcional)<input name="visible_until" type="date" value="${esc(a.visible_until || '')}">
        <small class="hint">Depois dessa data, o aviso some para os membros (a liderança continua vendo).</small></label>
      ${
        id
          ? ''
          : `<label class="check"><input type="checkbox" name="push"> Mandar notificação para os membros</label>
             <p class="hint">Chega em até uns 15 minutos para quem ativou as notificações, e fica na central de notificações de todos.</p>`
      }
      <button class="btn primary big">${id ? 'Salvar' : 'Publicar aviso'}</button>
    </form>`;
  const form = document.getElementById('notice');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {
      title: form.title.value.trim(),
      body: form.body.value.trim(),
      pinned: form.pinned.checked,
      visible_until: form.visible_until.value || null,
    };
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { error } = id
      ? await sb.from('announcements').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id)
      : await sb.from('announcements').insert({ ...row, church_id: state.church.id, push: form.push.checked });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    toast(id ? 'Aviso salvo.' : 'Aviso publicado.');
    navigate('/avisos');
  });
}

// ---------------------------------------------------------------------
// Pedidos de oração: mural da igreja, meus pedidos e moderação (administrador e líderes)
// ---------------------------------------------------------------------
const PRAYER_MAX = 500;
const PRAYER_STATUS = {
  privado: 'Só para os pastores',
  pendente: 'Aguardando aprovação',
  aprovado: 'No mural',
  recusado: 'Não foi para o mural',
};
const fmtDayMonth = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
const onWall = (p) => p.status === 'aprovado' && Date.now() - new Date(p.moderated_at).getTime() < 30 * 864e5;

function prayerTabs(active) {
  const tabs = [
    ['/oracao', 'Mural'],
    ['/oracao/meus', 'Meus pedidos'],
    ...(isPastoral() ? [['/oracao/moderar', 'Moderação']] : []),
  ];
  return `<div class="chips filters">${tabs
    .map(([href, label]) => `<a class="chip ${href === active ? 'active' : ''}" href="#${href}">${label}</a>`)
    .join('')}</div>`;
}

async function viewPrayers(ctx) {
  if (!requireMemberFeature('/oracao', 'oracao')) return;
  const { data: rows, error } = await sb.rpc('prayer_wall', { p_church: state.church.id });
  if (error) throw error;
  if (!ctx.alive()) return;
  $view.innerHTML = `
    <div class="page">
      <h1>Pedidos de oração</h1>
      ${prayerTabs('/oracao')}
      <div class="actions-row"><a class="btn primary" href="#/oracao/novo">${icon.plus} Fazer um pedido</a></div>
      ${
        rows.length
          ? rows
              .map(
                (p) => `
            <article class="card prayer">
              ${p.answered_at ? '<div class="tags-row"><span class="tag ok">Deus respondeu 🙌</span></div>' : ''}
              <p class="pre">${esc(p.body)}</p>
              <p class="hint">${p.author ? esc(p.author) : 'Pedido anônimo'}${p.anonymous && p.author ? ' (anônimo para os membros)' : ''} · ${esc(fmtDayMonth(p.approved_at))}</p>
              <button class="btn small ${p.i_pray ? 'primary' : ''}" data-pray="${p.id}" aria-pressed="${p.i_pray}">
                🙏 ${p.i_pray ? 'Estou orando' : 'Vou orar'}${p.praying ? ` · ${p.praying}` : ''}
              </button>
            </article>`,
              )
              .join('')
          : `<div class="empty"><p>Nenhum pedido no mural agora. Os pedidos aprovados ficam aqui por 30 dias.</p></div>`
      }
    </div>`;
  $view.querySelectorAll('[data-pray]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      const { data, error: err } = await sb.rpc('prayer_toggle', { p_request: b.dataset.pray });
      b.disabled = false;
      if (err) return toast(errorText(err), 'error');
      const { praying, i_pray: on } = data[0];
      b.classList.toggle('primary', on);
      b.setAttribute('aria-pressed', String(on));
      b.textContent = `🙏 ${on ? 'Estou orando' : 'Vou orar'}${praying ? ` · ${praying}` : ''}`;
    };
  });
}

async function viewPrayerForm() {
  if (!requireMemberFeature('/oracao/novo', 'oracao')) return;
  $view.innerHTML = `
    <form id="prayer" class="form page">
      <a href="#/oracao" class="back">← Pedidos de oração</a>
      <h1>Fazer um pedido</h1>
      <label>Seu pedido<textarea name="body" required minlength="3" maxlength="${PRAYER_MAX}" rows="6"></textarea>
        <small class="hint" id="count">0 de ${PRAYER_MAX} letras</small></label>
      <fieldset>
        <legend>Para quem vai</legend>
        <label class="check"><input type="radio" name="audience" value="pastores" checked> Só para os pastores
          <small class="hint">Só o pastor (administrador) e os líderes leem. A secretaria não vê.</small></label>
        <label class="check"><input type="radio" name="audience" value="igreja"> Para a igreja orar junto
          <small class="hint">Vai para o mural depois da aprovação da liderança e fica lá por 30 dias.</small></label>
      </fieldset>
      <label class="check" id="anon-box" hidden><input type="checkbox" name="anonymous"> Não mostrar meu nome
        <small class="hint">Os membros veem "Pedido anônimo". A liderança continua vendo quem enviou.</small></label>
      <button class="btn primary big">Enviar pedido</button>
    </form>`;
  const form = document.getElementById('prayer');
  const count = document.getElementById('count');
  form.body.addEventListener('input', () => (count.textContent = `${form.body.value.length} de ${PRAYER_MAX} letras`));
  form.addEventListener('change', () => (document.getElementById('anon-box').hidden = form.audience.value !== 'igreja'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const audience = form.audience.value;
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { error } = await sb.from('prayer_requests').insert({
      church_id: state.church.id,
      body: form.body.value.trim(),
      audience,
      anonymous: audience === 'igreja' && form.anonymous.checked,
    });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    toast(audience === 'igreja' ? 'Pedido enviado. Ele vai para o mural depois da aprovação.' : 'Pedido enviado aos pastores.');
    navigate('/oracao/meus');
  });
}

async function viewMyPrayers(ctx) {
  if (!requireMemberFeature('/oracao/meus', 'oracao')) return;
  const { data: rows, error } = await sb
    .from('prayer_requests')
    .select('id, body, audience, anonymous, status, moderated_at, answered_at, created_at')
    .eq('church_id', state.church.id)
    .eq('user_id', state.user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  if (!ctx.alive()) return;
  $view.innerHTML = `
    <div class="page">
      <h1>Pedidos de oração</h1>
      ${prayerTabs('/oracao/meus')}
      <div class="actions-row"><a class="btn primary" href="#/oracao/novo">${icon.plus} Fazer um pedido</a></div>
      ${
        rows.length
          ? rows
              .map(
                (p) => `
            <article class="card prayer">
              <div class="tags-row">
                <span class="tag">${p.status === 'aprovado' && !onWall(p) ? 'Saiu do mural' : PRAYER_STATUS[p.status]}</span>
                ${p.anonymous ? '<span class="tag">Anônimo</span>' : ''}
                ${p.answered_at ? '<span class="tag ok">Deus respondeu 🙌</span>' : ''}
              </div>
              <p class="pre">${esc(p.body)}</p>
              <p class="hint">Enviado em ${esc(fmtDayMonth(p.created_at))}${p.status === 'recusado' ? '. A liderança recebeu e vai orar por você.' : ''}</p>
              <div class="actions-row">
                ${p.answered_at ? '' : `<button class="btn small" data-answered="${p.id}">Deus respondeu 🙌</button>`}
                <button class="btn small danger-outline" data-delete="${p.id}">Apagar</button>
              </div>
            </article>`,
              )
              .join('')
          : `<div class="empty"><p>Você ainda não fez nenhum pedido.</p></div>`
      }
    </div>`;
  $view.querySelectorAll('[data-answered]').forEach((b) => {
    b.onclick = async () => {
      const { error: err } = await sb.from('prayer_requests').update({ answered_at: new Date().toISOString() }).eq('id', b.dataset.answered);
      if (err) return toast(errorText(err), 'error');
      toast('Glória a Deus! 🙌');
      render();
    };
  });
  $view.querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Apagar este pedido? Ele sai também do mural.')) return;
      const { error: err } = await sb.from('prayer_requests').delete().eq('id', b.dataset.delete);
      if (err) return toast(errorText(err), 'error');
      toast('Pedido apagado.');
      render();
    };
  });
}

async function viewPrayerModeration(ctx) {
  if (!requireMemberFeature('/oracao/moderar', 'oracao')) return;
  if (!isPastoral()) return navigate('/oracao');
  const tab = ['pendente', 'privado', 'aprovado'].includes(ctx.params.get('ver')) ? ctx.params.get('ver') : 'pendente';
  let query = sb
    .from('prayer_requests')
    .select('id, user_id, body, anonymous, status, moderated_at, cared_at, answered_at, created_at')
    .eq('church_id', state.church.id)
    .eq('status', tab)
    .order('created_at', { ascending: tab === 'pendente' })
    .limit(100);
  if (tab === 'aprovado') query = query.gt('moderated_at', new Date(Date.now() - 30 * 864e5).toISOString());
  const { data: rows, error } = await query;
  if (error) throw error;
  const ids = [...new Set(rows.map((p) => p.user_id))];
  const { data: people } = ids.length
    ? await sb.from('members').select('user_id, name').eq('church_id', state.church.id).in('user_id', ids)
    : { data: [] };
  if (!ctx.alive()) return;
  const nameOf = new Map((people || []).map((m) => [m.user_id, m.name]));
  const views = [
    ['pendente', 'Para aprovar'],
    ['privado', 'Só para os pastores'],
    ['aprovado', 'No mural'],
  ];
  $view.innerHTML = `
    <div class="page">
      <h1>Pedidos de oração</h1>
      ${prayerTabs('/oracao/moderar')}
      <div class="chips filters">${views
        .map(([k, label]) => `<a class="chip ${tab === k ? 'active' : ''}" href="#/oracao/moderar?ver=${k}">${label}</a>`)
        .join('')}</div>
      ${tab === 'privado' ? '<p class="hint">Só o administrador e os líderes veem estes pedidos.</p>' : ''}
      ${
        rows.length
          ? rows
              .map(
                (p) => `
            <article class="card prayer" data-id="${p.id}">
              <div class="tags-row">
                ${p.anonymous ? '<span class="tag">Anônimo para os membros</span>' : ''}
                ${p.cared_at ? '<span class="tag ok">Já cuidado</span>' : ''}
                ${p.answered_at ? '<span class="tag ok">Deus respondeu 🙌</span>' : ''}
              </div>
              ${
                tab === 'pendente'
                  ? `<label>Pedido<textarea rows="4" maxlength="${PRAYER_MAX}" data-body>${esc(p.body)}</textarea>
                       <small class="hint">Se precisar, corrija o texto antes de aprovar (por exemplo, para tirar um dado pessoal).</small></label>`
                  : `<p class="pre">${esc(p.body)}</p>`
              }
              <p class="hint">${esc(nameOf.get(p.user_id) || 'Pessoa que saiu da igreja')} · ${esc(fmtDayMonth(p.created_at))}</p>
              <div class="actions-row">
                ${
                  tab === 'pendente'
                    ? `<button class="btn small primary" data-status="aprovado">Aprovar</button>
                       <button class="btn small" data-status="recusado">Não publicar</button>`
                    : tab === 'privado'
                      ? `<button class="btn small" data-cared="${p.cared_at ? '' : '1'}">${p.cared_at ? 'Desmarcar' : 'Já orei / já entrei em contato'}</button>`
                      : `<button class="btn small danger-outline" data-remove>Tirar do mural</button>`
                }
              </div>
            </article>`,
              )
              .join('')
          : `<div class="empty"><p>${tab === 'pendente' ? 'Nenhum pedido esperando aprovação.' : tab === 'privado' ? 'Nenhum pedido só para os pastores.' : 'Nenhum pedido no mural.'}</p></div>`
      }
    </div>`;

  const update = async (card, patch, done) => {
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const { data, error: err } = await sb.from('prayer_requests').update(patch).eq('id', card.dataset.id).select('id');
    if (err || !data.length) {
      card.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return toast(err ? errorText(err) : 'Você não tem permissão para isso.', 'error');
    }
    toast(done);
    render();
  };
  $view.querySelectorAll('article.prayer').forEach((card) => {
    card.querySelectorAll('[data-status]').forEach((b) => {
      b.onclick = () => {
        const body = card.querySelector('[data-body]').value.trim();
        if (body.length < 3) return toast('O pedido ficou curto demais.', 'error');
        const approve = b.dataset.status === 'aprovado';
        update(card, { body, status: b.dataset.status }, approve ? 'Pedido aprovado: já está no mural.' : 'Pedido não publicado. Quem pediu recebe um aviso.');
      };
    });
    card.querySelector('[data-cared]')?.addEventListener('click', (e) =>
      update(card, { cared_at: e.currentTarget.dataset.cared ? new Date().toISOString() : null }, 'Pronto.'),
    );
    card.querySelector('[data-remove]')?.addEventListener('click', () => {
      if (!confirm('Tirar este pedido do mural? Quem pediu continua vendo em "Meus pedidos".')) return;
      update(card, { status: 'recusado' }, 'Pedido tirado do mural.');
    });
  });
}

// ---------------------------------------------------------------------
// Células e pequenos grupos: participantes, encontros e presença
// ---------------------------------------------------------------------
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const CELL_ROLES = { lider: 'Líder', auxiliar: 'Auxiliar', participante: 'Participante' };
const fmtTime = (t) => (t ? `${Number(t.slice(0, 2))}h${t.slice(3, 5) === '00' ? '' : t.slice(3, 5)}` : '');
const cellWhen = (c) =>
  [c.weekday != null ? `Toda ${WEEKDAYS[c.weekday]}${c.weekday === 0 || c.weekday === 6 ? '' : '-feira'}` : '', fmtTime(c.meets_at)]
    .filter(Boolean)
    .join(', às ');

async function viewCells(ctx) {
  if (!requireMemberFeature('/celulas', 'celulas')) return;
  const leader = isLeaderRole(myRole());
  const { data: cells, error } = await sb
    .from('cells')
    .select('id, name, weekday, meets_at, location, active, cell_members(member_id, role)')
    .eq('church_id', state.church.id)
    .order('name');
  if (error) throw error;
  if (!leader) {
    const mine = cells.filter((c) => c.active);
    if (mine.length === 1) return navigate(`/celulas/${mine[0].id}`);
    if (!ctx.alive()) return;
    $view.innerHTML = `
      <div class="page">
        <h1>Minha célula</h1>
        ${
          mine.length
            ? `<div class="list">${mine
                .map((c) => `<a class="menu-row" href="#/celulas/${c.id}">${icon.users}<span>${esc(c.name)}<small class="hint"> · ${esc(cellWhen(c))}</small></span>${icon.chevron}</a>`)
                .join('')}</div>`
            : '<div class="empty"><p>Você ainda não está em nenhuma célula. Fale com a secretaria ou com a liderança da igreja.</p></div>'
        }
      </div>`;
    return;
  }

  // Liderança: todas as células, a frequência dos últimos encontros e quem está sem célula.
  const since = isoLocal(addDays(new Date(), -60));
  const [meetings, people] = await Promise.all([
    sb.from('cell_meetings').select('cell_id, meeting_date, cell_attendance(count)').gte('meeting_date', since).order('meeting_date', { ascending: false }),
    sb.from('members').select('id, name, role, status').eq('church_id', state.church.id).eq('status', 'ativo').order('name'),
  ]);
  if (meetings.error) throw meetings.error;
  if (people.error) throw people.error;
  if (!ctx.alive()) return;
  const nameOf = new Map(people.data.map((m) => [m.id, m.name]));
  const inCell = new Set(cells.filter((c) => c.active).flatMap((c) => c.cell_members.map((x) => x.member_id)));
  const without = people.data.filter((m) => !inCell.has(m.id));
  const freq = (c) => {
    const last = meetings.data.filter((e) => e.cell_id === c.id).slice(0, 4);
    const size = c.cell_members.length;
    if (!last.length || !size) return null;
    return Math.round((100 * last.reduce((n, e) => n + (e.cell_attendance[0]?.count || 0), 0)) / (last.length * size));
  };
  $view.innerHTML = `
    <div class="page">
      <h1>Células</h1>
      <div class="actions-row"><a class="btn primary" href="#/celulas/nova">${icon.plus} Nova célula</a></div>
      ${
        cells.length
          ? `<div class="list">${cells
              .map((c) => {
                const f = freq(c);
                const leaders = c.cell_members.filter((x) => x.role === 'lider').map((x) => nameOf.get(x.member_id)).filter(Boolean);
                return `
            <a class="member-row ${c.active ? '' : 'inactive'}" href="#/celulas/${c.id}">
              <span class="avatar">${icon.users}</span>
              <span><strong>${esc(c.name)}</strong><small>${esc([cellWhen(c), leaders.length ? `Líder: ${leaders.join(', ')}` : 'Sem líder'].filter(Boolean).join(' · '))}</small></span>
              <span class="tags">
                <span class="tag">${c.cell_members.length} ${c.cell_members.length === 1 ? 'pessoa' : 'pessoas'}</span>
                ${!c.active ? '<span class="tag">Encerrada</span>' : f == null ? '<span class="tag">Sem encontros</span>' : `<span class="tag ${f >= 60 ? 'ok' : 'wait'}">Frequência ${f}%</span>`}
              </span>
            </a>`;
              })
              .join('')}</div>
             <p class="hint">Frequência: média de presença nos 4 últimos encontros (dos últimos 60 dias).</p>`
          : '<div class="empty"><p>Nenhuma célula ainda. Crie a primeira.</p></div>'
      }
      <section class="card">
        <h2>${icon.users} Membros sem célula (${without.length})</h2>
        ${
          without.length
            ? `<p class="pre">${without.map((m) => esc(m.name)).join('\n')}</p>`
            : '<p>Todos os membros ativos estão em alguma célula.</p>'
        }
      </section>
    </div>`;
}

async function viewCellForm(ctx, id) {
  if (!requireMemberFeature(id ? `/celulas/${id}/editar` : '/celulas/nova', 'celulas')) return;
  if (!isLeaderRole(myRole())) return navigate('/celulas');
  let c = { name: '', weekday: null, meets_at: null, location: '', description: '', active: true };
  if (id) {
    const { data, error } = await sb.from('cells').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return navigate('/celulas');
    c = data;
  }
  if (!ctx.alive()) return;
  $view.innerHTML = `
    <form id="cell" class="form page">
      <a href="${id ? `#/celulas/${id}` : '#/celulas'}" class="back">← ${id ? esc(c.name) : 'Células'}</a>
      <h1>${id ? 'Editar célula' : 'Nova célula'}</h1>
      <label>Nome<input name="name" required minlength="2" maxlength="80" value="${esc(c.name)}" placeholder="Célula Esperança"></label>
      <div class="colors">
        <label>Dia da semana
          <select name="weekday"><option value="">—</option>${WEEKDAYS.map((d, i) => `<option value="${i}" ${c.weekday === i ? 'selected' : ''}>${d}</option>`).join('')}</select>
        </label>
        <label>Horário<input name="meets_at" type="time" value="${esc(c.meets_at ? c.meets_at.slice(0, 5) : '')}"></label>
      </div>
      <label>Local (opcional)<input name="location" maxlength="200" value="${esc(c.location || '')}" placeholder="Rua das Flores, 10 · ou: on-line"></label>
      <label>Descrição (opcional)<textarea name="description" rows="3" maxlength="1000">${esc(c.description || '')}</textarea></label>
      ${id ? `<label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Célula ativa
        <small class="hint">Desmarque quando a célula encerrar: ela some para os participantes, e o histórico fica guardado.</small></label>` : ''}
      ${id ? '' : '<p class="hint">Depois de criar, abra a célula para escolher o líder e colocar os participantes.</p>'}
      <button class="btn primary big">${id ? 'Salvar' : 'Criar célula'}</button>
      ${id ? '<button class="btn danger-outline" type="button" id="delete">Excluir célula</button>' : ''}
    </form>`;
  const form = document.getElementById('cell');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {
      name: form.name.value.trim(),
      weekday: form.weekday.value === '' ? null : Number(form.weekday.value),
      meets_at: form.meets_at.value || null,
      location: form.location.value.trim() || null,
      description: form.description.value.trim() || null,
    };
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = id
      ? await sb.from('cells').update({ ...row, active: form.active.checked, updated_at: new Date().toISOString() }).eq('id', id).select('id').single()
      : await sb.from('cells').insert({ ...row, church_id: state.church.id }).select('id').single();
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    toast(id ? 'Célula salva.' : 'Célula criada. Agora escolha o líder e os participantes.');
    navigate(`/celulas/${data.id}`);
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!confirm(`Excluir a célula "${c.name}"? O histórico de encontros e presenças também é apagado. Para guardar o histórico, prefira desmarcar "Célula ativa".`)) return;
    const { data, error } = await sb.from('cells').delete().eq('id', id).select('id');
    if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para excluir.', 'error');
    toast('Célula excluída.');
    navigate('/celulas');
  });
}

async function viewCell(ctx, id) {
  if (!requireMemberFeature(`/celulas/${id}`, 'celulas')) return;
  const [cellRes, rosterRes, manageRes] = await Promise.all([
    sb.from('cells').select('*').eq('id', id).maybeSingle(),
    sb.rpc('cell_roster', { p_cell: id }),
    sb.rpc('can_manage_cell', { p_cell: id }),
  ]);
  if (cellRes.error) throw cellRes.error;
  if (rosterRes.error) throw rosterRes.error;
  const c = cellRes.data;
  if (!ctx.alive()) return;
  if (!c) {
    $view.innerHTML = `<div class="empty"><h2>Célula não encontrada</h2><a class="btn" href="#/celulas">Voltar</a></div>`;
    return;
  }
  const roster = rosterRes.data;
  const manage = !!manageRes.data;
  const leader = isLeaderRole(myRole());
  let meetings = [];
  if (manage) {
    const { data, error } = await sb
      .from('cell_meetings')
      .select('id, meeting_date, topic, visitors, cell_attendance(count)')
      .eq('cell_id', id)
      .order('meeting_date', { ascending: false })
      .limit(20);
    if (error) throw error;
    meetings = data;
  }
  if (!ctx.alive()) return;
  const photos = await signedPhotos(roster.filter((p) => p.photo_path).map((p) => miniOf(p.photo_path))).catch(() => ({}));
  if (!ctx.alive()) return;

  $view.innerHTML = `
    <div class="page">
      <a href="#/celulas" class="back">← ${leader ? 'Células' : 'Minha célula'}</a>
      <h1>${esc(c.name)}</h1>
      ${!c.active ? '<p class="notice">Esta célula está encerrada.</p>' : ''}
      ${cellWhen(c) ? `<p class="meta">${icon.clock}${esc(cellWhen(c))}</p>` : ''}
      ${c.location ? `<p class="meta">${icon.pin}${/^on-?line$/i.test(c.location.trim()) ? esc(c.location) : `<a href="${esc(mapsUrl(c.location))}" target="_blank" rel="noopener">${esc(c.location)}</a>`}</p>` : ''}
      ${c.description ? `<div class="card"><p class="pre">${esc(c.description)}</p></div>` : ''}
      ${
        manage
          ? `<div class="actions-row">
              <a class="btn primary" href="#/celulas/${id}/encontro">${icon.plus} Registrar encontro</a>
              ${leader ? `<a class="btn" href="#/celulas/${id}/editar">Editar célula</a>` : ''}
            </div>`
          : ''
      }

      <h2>Participantes (${roster.length})</h2>
      <div class="list">${
        roster
          .map(
            (p) => `
        <div class="member-row" data-member="${p.member_id}">
          ${avatar(p.name, p.photo_path && photos[miniOf(p.photo_path)])}
          <span><strong>${esc(p.name)}${p.is_me ? ' (você)' : ''}</strong>
            ${p.phone ? `<small><a href="tel:+${esc(p.phone)}">${esc(fmtPhone(p.phone))}</a></small>` : ''}
            ${manage && p.misses >= 2 ? `<small class="hint warn">Faltou nos ${p.misses} últimos encontros</small>` : ''}</span>
          <span class="tags">
            ${
              leader
                ? `<select data-role aria-label="Papel de ${esc(p.name)} na célula">${Object.entries(CELL_ROLES)
                    .map(([k, label]) => `<option value="${k}" ${p.role === k ? 'selected' : ''}>${label}</option>`)
                    .join('')}</select>`
                : p.role !== 'participante'
                  ? `<span class="tag role">${CELL_ROLES[p.role]}</span>`
                  : ''
            }
            ${manage && (leader || p.role === 'participante') ? `<button class="btn small danger-outline" data-remove aria-label="Tirar ${esc(p.name)} da célula">Tirar</button>` : ''}
          </span>
        </div>`,
          )
          .join('') || '<div class="empty"><p>Ninguém na célula ainda.</p></div>'
      }</div>
      ${
        manage
          ? `<form id="add-member" class="form card">
              <label>Colocar participante<input name="q" type="search" placeholder="Digite o nome de alguém do cadastro" autocomplete="off"></label>
              <div id="candidates" class="list"></div>
              <p class="hint">Quem ainda não está no cadastro precisa ser cadastrado pela secretaria.</p>
            </form>
            <h2>Encontros</h2>
            ${
              meetings.length
                ? `<div class="list">${meetings
                    .map(
                      (e) => `
                <a class="event-card" href="#/celulas/${id}/encontro?data=${e.meeting_date}">
                  <span class="event-time">${esc(fmtDate(e.meeting_date).slice(0, 5))}</span>
                  <span><strong>${esc(e.topic || 'Encontro')}</strong>
                    <small>${e.cell_attendance[0]?.count || 0} de ${roster.length} presentes${e.visitors ? ` · ${e.visitors} ${e.visitors === 1 ? 'visitante' : 'visitantes'}` : ''}</small></span>
                  ${icon.chevron}
                </a>`,
                    )
                    .join('')}</div>`
                : '<div class="empty"><p>Nenhum encontro registrado ainda.</p></div>'
            }`
          : ''
      }
    </div>`;

  $view.querySelectorAll('[data-member]').forEach((row) => {
    const memberId = row.dataset.member;
    row.querySelector('[data-role]')?.addEventListener('change', async (e) => {
      const { data, error } = await sb.from('cell_members').update({ role: e.target.value }).eq('cell_id', id).eq('member_id', memberId).select('role');
      if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para isso.', 'error');
      toast('Papel na célula salvo.');
    });
    row.querySelector('[data-remove]')?.addEventListener('click', async () => {
      const name = row.querySelector('strong').textContent;
      if (!confirm(`Tirar ${name} da célula? As presenças dela continuam no histórico.`)) return;
      const { data, error } = await sb.from('cell_members').delete().eq('cell_id', id).eq('member_id', memberId).select('member_id');
      if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para isso.', 'error');
      toast('Participante tirado da célula.');
      render();
    });
  });

  const addForm = document.getElementById('add-member');
  if (addForm) {
    const box = document.getElementById('candidates');
    let timer;
    addForm.addEventListener('submit', (e) => e.preventDefault());
    addForm.q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const term = addForm.q.value.trim();
        if (term.length < 2) return (box.innerHTML = '');
        const { data } = await sb.rpc('cell_candidates', { p_cell: id, p_search: term });
        if (addForm.q.value.trim() !== term) return;
        box.innerHTML = data?.length
          ? data.map((m) => `<button type="button" class="menu-row" data-add="${m.member_id}">${icon.plus}<span>${esc(m.name)}</span></button>`).join('')
          : '<p class="hint">Ninguém encontrado (ou já está na célula).</p>';
        box.querySelectorAll('[data-add]').forEach((b) => {
          b.onclick = async () => {
            b.disabled = true;
            const { error } = await sb.from('cell_members').insert({ cell_id: id, member_id: b.dataset.add });
            if (error) {
              b.disabled = false;
              return toast(errorText(error), 'error');
            }
            toast(`${b.textContent.trim()} entrou na célula.`);
            render();
          };
        });
      }, 250);
    });
  }
}

async function viewCellMeeting(ctx, id) {
  if (!requireMemberFeature(`/celulas/${id}/encontro`, 'celulas')) return;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(ctx.params.get('data') || '') ? ctx.params.get('data') : isoLocal(new Date());
  const [cellRes, rosterRes, meetRes] = await Promise.all([
    sb.from('cells').select('id, name').eq('id', id).maybeSingle(),
    sb.rpc('cell_roster', { p_cell: id }),
    sb.from('cell_meetings').select('id, topic, notes, visitors, cell_attendance(member_id)').eq('cell_id', id).eq('meeting_date', date).maybeSingle(),
  ]);
  if (cellRes.error) throw cellRes.error;
  if (rosterRes.error) throw rosterRes.error;
  if (meetRes.error) throw meetRes.error;
  if (!ctx.alive()) return;
  if (!cellRes.data) return navigate('/celulas');
  const meeting = meetRes.data;
  const present = new Set((meeting?.cell_attendance || []).map((a) => a.member_id));
  const roster = rosterRes.data;
  $view.innerHTML = `
    <form id="meeting" class="form page">
      <a href="#/celulas/${id}" class="back">← ${esc(cellRes.data.name)}</a>
      <h1>${meeting ? 'Corrigir encontro' : 'Registrar encontro'}</h1>
      <label>Data<input name="date" type="date" required value="${date}" max="${isoLocal(addDays(new Date(), 1))}"></label>
      <label>Tema (opcional)<input name="topic" maxlength="120" value="${esc(meeting?.topic || '')}" placeholder="Estudo de Romanos 8"></label>
      <fieldset>
        <legend>Presença: marque quem veio</legend>
        ${
          roster.length
            ? roster
                .map((p) => `<label class="check"><input type="checkbox" name="present" value="${p.member_id}" ${present.has(p.member_id) ? 'checked' : ''}> ${esc(p.name)}</label>`)
                .join('')
            : '<p class="hint">Ninguém na célula ainda.</p>'
        }
        <small class="hint" id="present-count"></small>
      </fieldset>
      <label>Visitantes (quantos vieram)<input name="visitors" type="number" min="0" max="200" inputmode="numeric" value="${meeting?.visitors || 0}"></label>
      <label>Observação (opcional)<textarea name="notes" rows="3" maxlength="1000">${esc(meeting?.notes || '')}</textarea></label>
      <button class="btn primary big">Salvar encontro</button>
      ${meeting ? '<button class="btn danger-outline" type="button" id="delete">Apagar este encontro</button>' : ''}
    </form>`;
  const form = document.getElementById('meeting');
  const counter = document.getElementById('present-count');
  const count = () => (counter.textContent = `${form.querySelectorAll('[name=present]:checked').length} de ${roster.length} presentes`);
  form.addEventListener('change', count);
  count();
  // Outra data: abre o encontro daquele dia (se já houver, para corrigir).
  form.date.addEventListener('change', () => form.date.value && form.date.value !== date && navigate(`/celulas/${id}/encontro?data=${form.date.value}`));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { error } = await sb.rpc('save_cell_meeting', {
      p_cell: id,
      p_date: form.date.value,
      p_topic: form.topic.value,
      p_notes: form.notes.value,
      p_visitors: Math.max(0, Math.min(200, Number(form.visitors.value) || 0)),
      p_present: [...form.querySelectorAll('[name=present]:checked')].map((i) => i.value),
    });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    toast('Encontro salvo.');
    navigate(`/celulas/${id}`);
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!confirm('Apagar este encontro e a lista de presença dele?')) return;
    const { error } = await sb.from('cell_meetings').delete().eq('id', meeting.id);
    if (error) return toast(errorText(error), 'error');
    toast('Encontro apagado.');
    navigate(`/celulas/${id}`);
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

// "faz 30 anos", "💍 Casamento · 10 anos", "🕊️ Batismo" (os anos só para a liderança).
function celebrationNote(r, sep = '') {
  if (r.kind === 'aniversario') return r.years ? `${sep}faz ${r.years} anos` : '';
  const k = MESSAGE_KINDS[r.kind];
  return `${sep}${k.emoji} ${k.label}${r.years ? ` · ${yearsText(r.years)}` : ''}`;
}

function dayLabel(iso) {
  const today = new Date();
  if (iso === isoLocal(today)) return 'Hoje';
  if (iso === isoLocal(addDays(today, 1))) return 'Amanhã';
  return parseIso(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'numeric' }).replace('.', '');
}

// A regra de quem aparece fica no banco: liderança vê todos (com a idade e os anos); membros, só quem autorizou.
// Cada linha tem o tipo: aniversario, casamento ou batismo.
async function fetchBirthdays(from, to) {
  const { data, error } = await sb.rpc('celebrations_between', { p_church: state.church.id, p_from: from, p_to: to });
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
            <span><strong>${esc(r.name)}</strong><small>${esc(dayLabel(r.on_date))}${celebrationNote(r, ' · ')}</small></span>
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
          ? `${rows.length} ${rows.length === 1 ? 'data' : 'datas'}. Como liderança, você vê todos os membros ativos.`
          : `Aparecem só os membros que autorizaram mostrar o aniversário${featureOn('datas_especiais') ? ', o casamento ou o batismo' : ''}.`
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
                    <span><strong>${esc(r.name)}</strong>${celebrationNote(r) ? `<small>${celebrationNote(r)}</small>` : ''}</span></li>`,
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

const NOTIF_ICON = { aniversario: 'cake', casamento: 'cake', batismo: 'cake', resumo_lideres: 'cake', evento: 'calendar', aviso: 'megaphone', oracao: 'heart', sistema: 'bell' };

function timeAgo(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ontem' : d < 7 ? `há ${d} dias` : new Date(iso).toLocaleDateString('pt-BR');
}

// Central de notificações (desta igreja) e, embaixo, as notificações no celular.
async function viewNotifications(ctx) {
  if (!requireLogin('/notificacoes')) return;
  if (!isActiveMember()) return navigate('/');
  const { data: items, error } = await sb
    .from('notifications')
    .select('id, kind, title, body, url, read_at, created_at')
    .eq('church_id', state.church.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  const support = pushSupport();
  const active = await pushActive();
  const blocked = support === 'ok' && Notification.permission === 'denied';
  if (!ctx.alive()) return;
  $view.innerHTML = `
    <div class="page">
      <h1>Notificações</h1>
      ${
        items.length
          ? `<div class="list">${items
              .map(
                (n) => `
            <a class="notif-row ${n.read_at ? '' : 'unread'}" href="${esc(n.url && n.url.startsWith('#/') ? n.url : '#/')}">
              <span class="notif-icon">${icon[NOTIF_ICON[n.kind]] || icon.bell}</span>
              <span><strong>${esc(n.title)}</strong>${n.body ? `<small class="pre">${esc(n.body)}</small>` : ''}<small>${esc(timeAgo(n.created_at))}</small></span>
            </a>`,
              )
              .join('')}</div>`
          : `<div class="empty"><p>Nenhuma notificação ainda. Avisos, lembretes da agenda e a sua mensagem de aniversário aparecem aqui.</p></div>`
      }
      <div class="card">
        <h2>No celular</h2>
        <p>Receba avisos, lembretes da agenda e a mensagem de aniversário mesmo com o app fechado${isLeaderRole(myRole()) ? ', e o resumo dos aniversariantes para a liderança' : ''}.</p>
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
  // Abrir a central marca tudo como lido.
  if (items.some((n) => !n.read_at)) {
    sb.from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('church_id', state.church.id)
      .is('read_at', null)
      .then(() => refreshUnread())
      .catch(() => {});
  }
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

// Textos da tela de cada mensagem.
const MESSAGE_SCREEN = {
  aniversario: {
    intro: 'Vai às 7h (horário de Brasília) para quem faz aniversário. Quem nasceu em 29/02 recebe em 28/02 nos anos que não são bissextos.',
    send: 'Enviar a mensagem de aniversário',
    fields: MESSAGE_FIELDS,
    fieldsHint: '{idade} é a idade que a pessoa completa.',
    sample: (age) => `se fizesse ${age} anos hoje`,
    age: 30,
  },
  casamento: {
    intro: 'Vai às 7h (horário de Brasília) no aniversário de casamento, para quem tem a data de casamento no cadastro. Cada cônjuge recebe a sua mensagem.',
    send: 'Enviar a mensagem de aniversário de casamento',
    fields: SPECIAL_FIELDS,
    fieldsHint: '{anos} vira "1 ano", "10 anos"…: quanto tempo de casamento a pessoa completa.',
    sample: (n) => `se completasse ${yearsText(n)} de casamento hoje`,
    age: 10,
  },
  batismo: {
    intro: 'Vai às 7h (horário de Brasília) no aniversário de batismo, para quem tem a data de batismo no cadastro.',
    send: 'Enviar a mensagem de aniversário de batismo',
    fields: SPECIAL_FIELDS,
    fieldsHint: '{anos} vira "1 ano", "10 anos"…: quanto tempo de batismo a pessoa completa.',
    sample: (n) => `se completasse ${yearsText(n)} de batismo hoje`,
    age: 5,
  },
};

async function viewMessageSettings(ctx, kind) {
  if (!requireLogin(`/config/${kind}`)) return;
  if (myRole() !== 'admin') {
    $view.innerHTML = `<div class="empty"><h2>Só para o administrador</h2><a class="btn" href="#/">Voltar</a></div>`;
    return;
  }
  const info = MESSAGE_KINDS[kind];
  const screen = MESSAGE_SCREEN[kind];
  if (!featureOn(info.feature)) {
    $view.innerHTML = `<div class="empty"><h2>${esc(info.menu)}</h2><p>Ligue a funcionalidade em Configurar a igreja.</p><a class="btn" href="#/config">Configurar a igreja</a></div>`;
    return;
  }
  const { data, error } = await sb.from('message_templates').select('*').eq('church_id', state.church.id).in('kind', [kind, 'resumo_lideres']);
  if (error) throw error;
  if (!ctx.alive()) return;
  const t = data.find((r) => r.kind === kind);
  const summary = data.find((r) => r.kind === 'resumo_lideres');
  if (!t || !summary) throw new Error('Os modelos de mensagem não foram encontrados. Rode o supabase/008_datas_especiais.sql.');
  const sample = { name: myMember()?.name || 'Maria da Silva', church: state.church.name, age: screen.age };

  $view.innerHTML = `
    <form id="bday" class="form page">
      <a href="#/menu" class="back">← Menu</a>
      <h1>${esc(info.menu)}</h1>
      <p class="hint">${esc(screen.intro)}</p>
      <label class="check"><input type="checkbox" name="enabled" ${t.enabled ? 'checked' : ''}> ${esc(screen.send)}</label>

      <fieldset class="card">
        <legend>Texto</legend>
        <label>Título<input name="title" required maxlength="120" value="${esc(t.title)}"></label>
        <label>Mensagem<textarea name="body" required rows="5" maxlength="1000">${esc(t.body)}</textarea></label>
        <div class="chips" aria-label="Campos para a mensagem">
          ${screen.fields.map((f) => `<button type="button" class="chip" data-field="${f}">{${f}}</button>`).join('')}
        </div>
        <p class="hint">Toque num campo para colocá-lo no texto. ${esc(screen.fieldsHint)}</p>
        <div class="chips emojis" aria-label="Emojis para a mensagem">
          ${MESSAGE_EMOJIS.map((em) => `<button type="button" class="chip" data-insert="${em}" aria-label="Colocar ${em}">${em}</button>`).join('')}
        </div>
        <p class="hint">Toque num emoji para colocá-lo onde está o cursor, no título ou na mensagem. Pelo teclado do celular dá para pôr qualquer outro.</p>
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
        <p class="hint">O e-mail vai para quem tem e-mail no cadastro, mesmo sem ter entrado no app.</p>
      </fieldset>

      <fieldset class="card">
        <legend>Liderança</legend>
        <label class="check"><input type="checkbox" name="summary" ${summary.enabled ? 'checked' : ''}> Resumo para a liderança às 7h: as datas do dia (aniversários${featureOn('datas_especiais') ? ', casamentos e batismos' : ''}) e, às segundas, as da semana</label>
        <p class="hint">O resumo é um só para todas as datas: ligar ou desligar aqui vale também nas outras mensagens.</p>
      </fieldset>

      <section class="card preview">
        <h2>Prévia</h2>
        <div class="push-preview">
          <img src="${esc(state.church.logo_url || 'icons/icon-192.png')}" alt="" width="36" height="36">
          <div><strong id="pv-title"></strong><p id="pv-body"></p></div>
        </div>
        <p class="hint">Assim chega para ${esc(sample.name.split(' ')[0])}, ${esc(screen.sample(sample.age))}.</p>
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
  form.querySelectorAll('[data-field], [data-insert]').forEach((b) => {
    b.onclick = () => {
      const el = lastField;
      const text = b.dataset.insert ?? `{${b.dataset.field}}`;
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
        const path = `${state.church.id}/${kind}/imagem-${Date.now()}.${img.type === 'image/webp' ? 'webp' : 'jpg'}`;
        const up = await bucket.upload(path, img, { contentType: img.type, cacheControl: '31536000' });
        if (up.error) throw up.error;
        patch.image_url = bucket.getPublicUrl(path).data.publicUrl;
      } else if (removeImage) patch.image_url = null;

      const save = (kind, p) => sb.from('message_templates').update(p).eq('church_id', state.church.id).eq('kind', kind).select('kind');
      const [a, b] = await Promise.all([save(kind, patch), save('resumo_lideres', { enabled: form.summary.checked, updated_at: patch.updated_at })]);
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

// Abertura rápida: guarda no aparelho a igreja e os cadastros da última abertura. Na próxima,
// a tela aparece na hora com eles, e o banco confirma em segundo plano (se algo mudou, redesenha).
// Só vale para a mesma conta que está logada neste aparelho; as permissões continuam no banco.
const BOOT_KEY = 'abertura-rapida';
const AUTH_KEY = `sb-${new URL(CONFIG.SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
const bootSnapshot = () =>
  JSON.stringify({ church: state.church, user: state.user?.id ?? null, memberships: state.memberships, platformAdmin: state.platformAdmin });

function saveBootCache() {
  if (!SLUG || !state.church) return;
  try {
    localStorage.setItem(BOOT_KEY, JSON.stringify({ slug: SLUG, snapshot: bootSnapshot() }));
  } catch {}
}

function clearBootCache() {
  try {
    localStorage.removeItem(BOOT_KEY);
  } catch {}
}

// Desenha a tela com o que ficou guardado. Devolve o retrato usado, ou null se não deu.
function quickStart() {
  if (!SLUG || location.search || sessionStorage.getItem('next')) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(BOOT_KEY) || 'null');
    const sessionUser = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null')?.user ?? null;
    if (!saved || saved.slug !== SLUG) return null;
    const snap = JSON.parse(saved.snapshot);
    if (snap.user !== (sessionUser?.id ?? null) || !snap.church) return null;
    state.church = snap.church;
    state.user = sessionUser;
    state.memberships = snap.memberships || [];
    state.platformAdmin = !!snap.platformAdmin;
  } catch {
    return null;
  }
  applyBranding();
  renderAccountLink();
  window.addEventListener('hashchange', render);
  render();
  return bootSnapshot();
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

  const quick = (quickStarted = quickStart());
  const authError = new URLSearchParams(location.search).get('error_description');
  const [{ data }, church] = await Promise.all([sb.auth.getSession(), SLUG ? loadChurch() : null]);
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  if (authError) toast(authError, 'error');

  if (SLUG && !church) {
    clearBootCache();
    state.church = null;
    renderTabbar('/');
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
      saveBootCache();
      render();
    }, 0);
  });

  const next = sessionStorage.getItem('next');
  if (data.session && next && ['', '#/', '#/entrar'].includes(location.hash)) {
    sessionStorage.removeItem('next');
    history.replaceState(null, '', location.pathname + '#' + next);
  }

  saveBootCache();
  if (!quick) {
    window.addEventListener('hashchange', render);
    render();
  } else if (bootSnapshot() !== quick) {
    render(); // a igreja ou os cadastros mudaram desde a última abertura
  }
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
let quickStarted = null;
boot().catch((e) => {
  console.error(e);
  // Já está na tela com o que ficou guardado (ex.: sem internet): só avisa.
  if (quickStarted) return toast(errorText(e), 'error');
  $view.innerHTML = `<div class="empty"><h2>Não foi possível abrir o app</h2><p>${esc(errorText(e))}</p><button class="btn primary" onclick="location.reload()">Tentar de novo</button></div>`;
});
