import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { CONFIG } from './config.js';
import {
  esc, slugify, isValidSlug, churchSlugFromPath, inkOn, readableOnWhite, normalizePhone, fmtPhone,
  ROLES, isLeaderRole, FEATURES, fold, fmtDate, fmtMoney, EMAIL_RE, parseMembersCsv, MEMBERS_CSV_TEMPLATE,
  parseFinanceCsv, financeKey, FINANCE_CSV_TEMPLATE, FINANCE_CSV_HEADER, FIN_KIND_CSV,
  renderMessage, firstName, MESSAGE_FIELDS, SPECIAL_FIELDS, yearsText, MESSAGE_EMOJIS, icsForEvent, googleCalendarUrl, REMIND_OPTIONS,
} from './util.js';
import { resizeImage, resizeLogo, makeIconSet, resizeForGallery } from './images.js';
import { maybeSuggestInstall, installState, installNow, iconReady, ICON_PREPARING } from './install.js';
import { pushSupport, pushActive, enablePush, disablePush, syncPush, movePushToPage } from './push.js';
import { PIX_TYPES, guessPixType, normalizePixKey, formatPixKey, parseAmount, pixPayload, qrSvg, qrImage } from './pix.js';
import { placeBlock, mountPlaceMaps, pinField, bindPinField, pinValues } from './map.js';
import { BOOKS, BIBLE_VERSIONS, bibleUrl, bookName, bookChapters, verseRef, READING_PLANS, planReading, passageLabel, readingLabel } from './biblia.js';

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
// Alfinete da igreja no mapa: ponto de partida para marcar eventos e células.
const churchPin = () => (state.church?.lat != null ? { lat: state.church.lat, lng: state.church.lng } : null);
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
// Tela Visitantes: a liderança e a equipe do ministério que recebe os avisos (ex.: Acolhimento).
const visitorTeam = () => featureOn('visitantes') && (isLeaderRole(myRole()) || (isActiveMember() && !!myMember().visitor_team));
// Financeiro: o administrador e quem ele marcou como tesouraria.
const treasury = () => featureOn('financeiro') && isActiveMember() && (myRole() === 'admin' || !!myMember().treasury);

// ---------------------------------------------------------------------
// Telas que abrem na hora: guarda (na memória e no aparelho) o que veio do banco da última
// vez, desenha com isso e confere com o banco em seguida. Vale só para a conta e a igreja
// atuais, e é apagado ao sair da conta. As permissões continuam no banco.
// ---------------------------------------------------------------------
const SCREEN_PREFIX = 'tela:';
const screenMem = new Map();
const screenLoading = new Map();
// Telas com dados sensíveis de outras pessoas: guardadas só na memória, nunca gravadas no aparelho.
const PRIVATE_SCREENS = /^(moderar:|visitantes$|inscritos:|infantil$|chat$|conversa:|financeiro)/;
const screenKey = (name) => `${SCREEN_PREFIX}${state.user?.id}:${state.church?.id}:${name}`;

function screenCached(name) {
  const key = screenKey(name);
  if (screenMem.has(key)) return screenMem.get(key);
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved) screenMem.set(key, saved);
    return saved;
  } catch {
    return null;
  }
}

// Busca no banco (uma busca por vez para cada tela) e guarda.
function screenFetch(name, fetcher) {
  const key = screenKey(name);
  if (!screenLoading.has(key)) {
    const p = fetcher()
      .then((data) => {
        screenMem.set(key, data);
        // Pedidos de oração da moderação (inclui os privados): só na memória, nunca gravados no aparelho.
        if (!PRIVATE_SCREENS.test(name)) {
          try {
            localStorage.setItem(key, JSON.stringify(data));
          } catch {}
        }
        return data;
      })
      .finally(() => screenLoading.delete(key));
    screenLoading.set(key, p);
  }
  return screenLoading.get(key);
}

// Desenha na hora com o guardado e de novo se o banco trouxer algo diferente.
// Sem internet, fica com o guardado; sem nada guardado, o erro aparece como sempre.
async function screenShow(ctx, name, fetcher, draw) {
  const cached = screenCached(name);
  // Como estava ao abrir: a própria tela pode mudar o guardado (ex.: "Li", "Amém") enquanto o banco responde.
  const opened = JSON.stringify(cached);
  if (cached) draw(cached);
  let data;
  try {
    data = await screenFetch(name, fetcher);
  } catch (err) {
    if (cached) return;
    throw err;
  }
  if (!ctx.alive() || JSON.stringify(data) === opened) return;
  const typing = document.activeElement;
  if (cached && $view.contains(typing) && /^(INPUT|TEXTAREA|SELECT)$/.test(typing.tagName)) return;
  draw(data);
}

// Fotos dos membros já conhecidas (links ainda válidos), sem esperar a rede.
function knownPhotos(paths) {
  const now = Date.now();
  const out = {};
  for (const p of paths) {
    const hit = photoLinks.get(p);
    if (hit && hit.until > now) out[p] = hit.url;
  }
  return out;
}

// Como screenShow, para telas com fotos: desenha na hora com as fotos já conhecidas
// (as outras com as iniciais) e de novo quando os links das que faltam chegam.
// photosOf devolve os caminhos das fotos (os nulos são ignorados).
async function screenShowWithPhotos(ctx, name, fetcher, photosOf, draw) {
  const minisOf = (data) => photosOf(data).filter(Boolean).map(miniOf);
  await screenShow(ctx, name, fetcher, (data) => draw(data, knownPhotos(minisOf(data))));
  const data = screenCached(name);
  if (!data || !ctx.alive()) return;
  const paths = minisOf(data);
  if (paths.every((p) => knownPhotos([p])[p])) return;
  const minis = await signedPhotos(paths).catch(() => ({}));
  if (ctx.alive()) draw(data, minis);
}

// Formulários: abrem na hora com o guardado (cached) e conferem com o banco em segundo plano.
// Se o banco trouxer outra versão antes de a pessoa mexer no formulário, guarda (remember) e
// abre a tela de novo com ela; depois que a pessoa começou a mexer, não troca nada.
function formFresh(ctx, cached, fetcher, remember) {
  let touched = false;
  $view.addEventListener('input', () => (touched = true), { once: true });
  fetcher()
    .then((fresh) => {
      if (!ctx.alive() || touched || JSON.stringify(fresh) === JSON.stringify(cached)) return;
      remember(fresh);
      render();
    })
    .catch(() => {});
}

// Item para editar: o que já está guardado de uma lista (abre na hora, conferindo com o banco
// em segundo plano) ou, se não houver, o banco.
async function editItem(ctx, cachedItem, fetcher, remember) {
  if (!cachedItem) return fetcher();
  formFresh(ctx, cachedItem, fetcher, remember);
  return cachedItem;
}

// Foto grande do formulário: aparece na hora a que já está guardada (ou a miniatura); a de
// tamanho cheio entra quando o link chegar, se a pessoa não tiver escolhido outra.
function photoNow(path) {
  if (!path) return null;
  const known = knownPhotos([path, miniOf(path)]);
  return known[path] || known[miniOf(path)] || null;
}
function photoLater(ctx, form, name, path) {
  if (!path || knownPhotos([path])[path]) return;
  signedPhotos([path])
    .then((links) => {
      const box = document.getElementById('photo-preview');
      if (!ctx.alive() || !box || !links[path] || form.photo?.files?.length || form.dataset.photoRemoved) return;
      box.innerHTML = avatar(name, links[path], 'big');
    })
    .catch(() => {});
}

// Depois de criar, editar ou apagar: a próxima abertura espera o banco.
function screenForget(name) {
  const key = screenKey(name);
  screenMem.delete(key);
  screenLoading.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {}
}

// Depois de uma mudança feita na própria tela: guarda a versão nova, sem esperar o banco.
function screenUpdate(name, data) {
  const key = screenKey(name);
  screenMem.set(key, data);
  if (PRIVATE_SCREENS.test(name)) return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {}
}

// No Início, já busca em segundo plano as telas mais usadas.
function prefetchScreens() {
  if (!isActiveMember()) return;
  const run = () => {
    if (featureOn('agenda')) {
      screenFetch('agenda', loadAgenda).catch(() => {});
      screenFetch('eventos', loadEventDetails).catch(() => {});
    }
    if (featureOn('avisos')) screenFetch('avisos', loadAnnouncements).catch(() => {});
    if (regsOn()) screenFetch('inscricoes', loadRegistrations).catch(() => {});
    // Conversas e visitantes: só na memória (PRIVATE_SCREENS), nunca gravados no aparelho.
    if (chatOn()) screenFetch('chat', loadChats).then(prefetchConversations).catch(() => {});
    if (visitorTeam()) screenFetch('visitantes', loadVisitors).catch(() => {});
    if (featureOn('infantil')) screenFetch('filhos', loadMyKids).catch(() => {});
    if (kidsTeam()) screenFetch('infantil', loadKids).catch(() => {});
    if (featureOn('galeria')) {
      // E as capas dos álbuns, para a Galeria abrir com as imagens.
      screenFetch('galeria', loadAlbums)
        .then((all) => galleryUrls(all.map((a) => a.cover_mini).filter(Boolean)))
        .catch(() => {});
    }
    if (featureOn('relatorios') && isLeaderRole(myRole())) screenFetch('relatorio:3', () => loadReport(reportPeriod('3'))).catch(() => {});
    const me = myMember();
    screenFetch('perfil', () => loadProfile(me.id))
      .then((m) => m.photo_path && signedPhotos([m.photo_path]))
      .catch(() => {});
    if (featureOn('oracao')) screenFetch('mural', loadPrayerWall).catch(() => {});
    screenFetch('notificacoes:todas', async () => {
      const { data, error } = await sb
        .from('notifications')
        .select('id, kind, title, body, url, read_at, created_at')
        .eq('church_id', state.church.id)
        .order('created_at', { ascending: false })
        .range(0, NOTIF_PAGE);
      if (error) throw error;
      return data;
    }).catch(() => {});
    if (featureOn('celulas')) screenFetch('celulas', loadCells).catch(() => {});
    if (featureOn('escalas')) {
      // E os ministérios de que a pessoa participa (a escala completa abre na hora).
      screenFetch('escalas', loadSchedules)
        .then((d) => d.ministries.filter((mi) => mi.my_role).forEach((mi) => screenFetch(`ministerio:${mi.id}`, () => loadMinistry(mi.id)).catch(() => {})))
        .catch(() => {});
    }
    if (featureOn('devocional')) {
      screenFetch('devocionais', loadDevotionals).catch(() => {});
      screenFetch('leitura', loadReading).catch(() => {});
    }
    if (datesOn()) {
      const now = new Date();
      const [y, m] = [now.getFullYear(), now.getMonth() + 1];
      screenFetch(`mes:${y}-${m}`, () => fetchBirthdays(isoLocal(new Date(y, m - 1, 1)), isoLocal(new Date(y, m, 0)))).catch(() => {});
    }
  };
  'requestIdleCallback' in window ? requestIdleCallback(run, { timeout: 1500 }) : setTimeout(run, 300);
}

// ---------------------------------------------------------------------
// Utilidades da tela
// ---------------------------------------------------------------------
let toastTimer;
// action (opcional): { label, run } vira um botão no aviso, como "Desfazer".
function toast(msg, kind = '', action = null) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => {
      el.hidden = true;
      action.run();
    };
    el.append(' ', btn);
  }
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 6000 : action ? 6000 : 3500);
}

// Pergunta numa janela do app, com o nome da igreja no topo (a janela do navegador, confirm/prompt,
// mostraria o endereço do site). Devolve true/false; com `input`, o texto digitado (ou null se cancelou).
// O botão da ação diz o que faz ("Apagar", "Excluir"…, tirado da própria pergunta) e fica vermelho
// quando apaga ou tira algo. Esc e "Cancelar" desistem; Enter confirma.
const ASK_DANGER = ['Apagar', 'Excluir', 'Tirar', 'Desligar', 'Sair', 'Desativar', 'Bloquear', 'Denunciar'];
function ask(message, { ok, danger, input, value = '', placeholder = '', readonly = false } = {}) {
  const verb = message.match(/^[A-ZÀ-Ú][a-zà-ú]+/)?.[0];
  const label = ok || (verb && /r$/.test(verb) ? verb : 'Confirmar');
  const red = danger ?? ASK_DANGER.includes(label.split(' ')[0]);
  const dlg = document.createElement('dialog');
  dlg.className = 'ask';
  dlg.innerHTML = `
    <form method="dialog">
      <h2></h2>
      <p class="pre"></p>
      ${input ? `<input name="answer" type="${input === 'email' ? 'email' : 'text'}" maxlength="500" autocomplete="off">` : ''}
      <div class="actions-row">
        <button type="button" class="btn" value="cancel">${readonly ? 'Fechar' : 'Cancelar'}</button>
        ${readonly ? '' : `<button class="btn ${red ? 'danger' : 'primary'}" value="ok"></button>`}
      </div>
    </form>`;
  dlg.querySelector('h2').textContent = state.church?.name || 'Igreja Conecta';
  dlg.querySelector('p').textContent = message;
  const field = dlg.querySelector('input');
  if (field) {
    Object.assign(field, { value, placeholder, readOnly: readonly });
    field.setAttribute('aria-label', message);
  }
  const okBtn = dlg.querySelector('[value="ok"]');
  if (okBtn) okBtn.textContent = label;
  document.body.append(dlg);
  return new Promise((resolve) => {
    dlg.querySelector('[value="cancel"]').onclick = () => dlg.close('cancel');
    dlg.addEventListener('close', () => {
      const yes = dlg.returnValue === 'ok';
      dlg.remove();
      resolve(input ? (yes ? field.value : null) : yes);
    });
    dlg.showModal();
    (field && !readonly ? field : okBtn || field)?.focus();
    if (readonly) field?.select();
  });
}

// Botão redondo com "+" no canto inferior direito, para criar algo na tela (conversa, evento, aviso).
const fab = (href, label) => `<a class="fab" href="${href}" aria-label="${esc(label)}" title="${esc(label)}">${icon.plus}</a>`;
// Mais de uma forma de criar na mesma tela: o "+" abre um menu com as opções ([href, texto]).
const fabMenu = (label, items) => `
  <details class="fab-menu">
    <summary class="fab" aria-label="${esc(label)}" title="${esc(label)}">${icon.plus}</summary>
    <div class="fab-options">${items.map(([href, text]) => `<a class="btn" href="${href}">${esc(text)}</a>`).join('')}</div>
  </details>`;

// Folha para imprimir ou salvar PDF (skill folha-para-imprimir): logo e nome da igreja no topo;
// assinaturas e rodapé só aparecem no papel.
const sheetHead = (title, accent, sub = '') => `
  <header class="sheet-head">
    ${state.church.logo_url ? `<img class="sheet-logo" src="${esc(state.church.logo_url)}" alt="" width="56" height="56">` : ''}
    <div>
      <p class="sheet-church">${esc(state.church.name)}</p>
      <h1>${esc(title)} <span>${esc(accent)}</span></h1>
      ${sub ? `<p class="sheet-sub">${esc(sub)}</p>` : ''}
    </div>
  </header>`;
const sheetSigns = (roles) =>
  `<div class="sheet-signs">${roles.map((r) => `<div><span class="sheet-line"></span>${esc(r)}<small>Data: ____/____/________</small></div>`).join('')}</div>`;
const sheetFoot = () => `<footer class="sheet-foot">Gerado pelo app da ${esc(state.church.name)} em ${esc(new Date().toLocaleDateString('pt-BR'))}.</footer>`;
// O título da página vira o nome do PDF salvo.
function printAs(fileTitle) {
  const title = document.title;
  document.title = fileTitle;
  window.addEventListener('afterprint', () => (document.title = title), { once: true });
  window.print();
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
  if (/ministries_visitors_idx/i.test(msg)) return 'Outro ministério já recebe os avisos de visitantes. Desmarque nele primeiro.';
  if (/ministries_kids_idx/i.test(msg)) return 'Outro ministério já faz o check-in das crianças. Desmarque nele primeiro.';
  if (/ministries_gallery_idx/i.test(msg)) return 'Outro ministério já publica na galeria. Desmarque nele primeiro.';
  if (/fin_categories_name_idx/i.test(msg)) return 'Já existe uma categoria com esse nome.';
  if (/exceeded the maximum allowed size|Payload too large/i.test(msg)) return 'A foto ficou grande demais mesmo reduzida. Tente outra foto.';
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
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  qr: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2M20 14v.01M14 20h.01M17 17v3h3M20 17v.01"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M7 9V3.5h10V9M7 17H4.5V9h15v8H17"/><path d="M7 14h10v6.5H7z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>',
  pix: '<svg viewBox="0 0 24 24"><path d="M12 3.5 20.5 12 12 20.5 3.5 12z"/><path d="M8 12h8"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24"><path d="M9 4.5H6.5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V5.5a1 1 0 0 0-1-1H15"/><rect x="9" y="3" width="6" height="3" rx="1"/><path d="M9 11h6M9 15h4"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 16-5-5-8 8.5"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 20h16M7 16.5V11M12 16.5V6M17 16.5v-8"/></svg>',
  idcard: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16.5a3.4 3.4 0 0 1 6.4 0M14.5 10h4M14.5 13.5h3"/></svg>',
  child: '<svg viewBox="0 0 24 24"><circle cx="12" cy="6" r="3"/><path d="M12 9v6M8 11.5l4-1 4 1M9.5 21l2.5-6 2.5 6"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5.5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><path d="M4 7.5a2 2 0 0 1 2-2h12v3"/><rect x="4" y="8.5" width="16" height="11" rx="2"/><path d="M15.5 14h.01"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="m4 12 16-7.5-6 15-2.5-6z"/><path d="m11.5 13.5 8.5-9"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M5 19.5V5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2 2 2 0 0 0 2 2h12v-4"/><path d="M12 6.5v6M9.5 8.8h5"/></svg>',
};

const SOCIAL = [
  ['instagram', 'Instagram', 'https://instagram.com/suaigreja'],
  ['youtube', 'YouTube', 'https://youtube.com/@suaigreja'],
  ['facebook', 'Facebook', 'https://facebook.com/suaigreja'],
  ['site', 'Site', 'https://suaigreja.com.br'],
];

// ---------------------------------------------------------------------
// Tema claro ou escuro: escolhido no botão do topo e guardado só neste aparelho (js/tema.js
// aplica antes de a página aparecer). Sem escolha, segue o tema do celular.
// ---------------------------------------------------------------------
const THEME_KEY = 'tema';
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light');
const themeChosen = () => {
  try {
    return !!localStorage.getItem(THEME_KEY);
  } catch {
    return false;
  }
};

// t: 'light', 'dark' ou null (voltar a seguir o celular).
function setTheme(t) {
  try {
    if (t) localStorage.setItem(THEME_KEY, t === 'dark' ? 'escuro' : 'claro');
    else localStorage.removeItem(THEME_KEY);
  } catch {}
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  updateThemeButton();
}

function updateThemeButton() {
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  const dark = currentTheme() === 'dark';
  const label = dark ? 'Usar tema claro' : 'Usar tema escuro';
  btn.innerHTML = dark ? icon.sun : icon.moon;
  btn.setAttribute('aria-label', label);
  btn.title = label;
}
document.getElementById('theme-btn')?.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
systemDark.addEventListener?.('change', updateThemeButton);
updateThemeButton();

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
  // A central de notificações abre pelo sininho do topo: nenhuma aba fica marcada.
  const active = ['/', ''].includes(path) ? '/' : section ? section[0] : path === '/notificacoes' ? null : '/menu';
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
  updateChatBadge();
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
      .select('id, role, consent_at, name, treasury, visitor_team, kids_team, gallery_team, church:churches(id, slug, name, logo_url, primary_color)')
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
  if (user)
    movePushToPage(sb, ROOT_URL, CONFIG.VAPID_PUBLIC_KEY)
      .catch(() => {})
      .then(() => syncPush(sb))
      .catch(() => {});
  // Chat: canal particular desta conta e o número de conversas não lidas.
  listenChat().catch(() => {});
  chatUnread = 0;
  refreshChatUnread().catch(() => {});
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
  [/^\/agenda\/([0-9a-f-]{36})\/inscritos$/, viewRegistrants],
  [/^\/avisos$/, viewAnnouncements],
  [/^\/avisos\/novo$/, viewAnnouncementForm],
  [/^\/avisos\/([0-9a-f-]{36})\/editar$/, viewAnnouncementForm],
  [/^\/ofertar$/, viewOffer],
  [/^\/oracao$/, viewPrayers],
  [/^\/oracao\/novo$/, viewPrayerForm],
  [/^\/oracao\/meus$/, viewMyPrayers],
  [/^\/oracao\/moderar$/, viewPrayerModeration],
  [/^\/visitante$/, viewVisitorForm],
  [/^\/visitantes$/, viewVisitors],
  [/^\/visitantes\/qr$/, viewVisitorQr],
  [/^\/visitantes\/([0-9a-f-]{36})$/, viewVisitor],
  [/^\/devocional$/, viewDevotionals],
  [/^\/devocional\/novo$/, viewDevotionalForm],
  [/^\/devocional\/([0-9a-f-]{36})$/, viewDevotional],
  [/^\/devocional\/([0-9a-f-]{36})\/editar$/, viewDevotionalForm],
  [/^\/leitura$/, viewReading],
  [/^\/leitura\/novo$/, viewReadingForm],
  [/^\/leitura\/([0-9a-f-]{36})$/, viewReadingPlan],
  [/^\/escalas$/, viewSchedules],
  [/^\/ministerios\/novo$/, viewMinistryForm],
  [/^\/ministerios\/([0-9a-f-]{36})$/, viewMinistry],
  [/^\/ministerios\/([0-9a-f-]{36})\/editar$/, viewMinistryForm],
  [/^\/ministerios\/([0-9a-f-]{36})\/escala$/, viewScheduleForm],
  [/^\/ministerios\/([0-9a-f-]{36})\/escala\/([0-9a-f-]{36})$/, viewScheduleForm],
  [/^\/filhos$/, viewMyKids],
  [/^\/filhos\/novo$/, viewChildForm],
  [/^\/filhos\/([0-9a-f-]{36})$/, viewChildForm],
  [/^\/infantil$/, viewKids],
  [/^\/infantil\/crianca\/nova$/, viewChildForm],
  [/^\/infantil\/crianca\/([0-9a-f-]{36})$/, viewChildForm],
  [/^\/infantil\/entrada\/([0-9a-f-]{36})$/, viewKidCheckin],
  [/^\/infantil\/etiqueta\/([0-9a-f-]{36})$/, viewKidLabel],
  [/^\/infantil\/retirada$/, viewKidCheckout],
  [/^\/infantil\/salas$/, viewKidRooms],
  [/^\/chat$/, viewChats],
  [/^\/chat\/nova$/, viewChatNew],
  [/^\/chat\/([0-9a-f-]{36})$/, viewConversation],
  [/^\/relatorios$/, viewReports],
  [/^\/financeiro$/, viewFinance],
  [/^\/financeiro\/novo$/, viewFinanceEntry],
  [/^\/financeiro\/config$/, viewFinanceConfig],
  [/^\/financeiro\/importar$/, viewFinanceImport],
  [/^\/financeiro\/([0-9a-f-]{36})$/, viewFinanceEntry],
  [/^\/prestacao$/, viewAccountability],
  [/^\/prestacao\/(\d{4}-\d{2})$/, viewAccountabilityMonth],
  [/^\/galeria$/, viewGallery],
  [/^\/galeria\/novo$/, viewAlbumForm],
  [/^\/galeria\/([0-9a-f-]{36})$/, viewAlbum],
  [/^\/galeria\/([0-9a-f-]{36})\/editar$/, viewAlbumForm],
  [/^\/galeria\/([0-9a-f-]{36})\/foto\/([0-9a-f-]{36})$/, viewGalleryPhoto],
  [/^\/carteirinha$/, viewCard],
  [/^\/carteirinha\/verificar\/([0-9a-f-]{36})$/, viewCardVerify],
  [/^\/celulas$/, viewCells],
  [/^\/celulas\/nova$/, viewCellForm],
  [/^\/celulas\/([0-9a-f-]{36})$/, viewCell],
  [/^\/celulas\/([0-9a-f-]{36})\/editar$/, viewCellForm],
  [/^\/celulas\/([0-9a-f-]{36})\/encontro$/, viewCellMeeting],
];

let renderId = 0;
let chatCheckedAt = 0;
async function render() {
  const id = ++renderId;
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  const ctx = { params: new URLSearchParams(qs || ''), path, alive: () => id === renderId };
  renderTabbar(path);
  document.getElementById('notif-link').classList.toggle('active', path === '/notificacoes');
  if (path !== '/notificacoes') refreshUnread().catch(() => {});
  if (!path.startsWith('/chat') && Date.now() - chatCheckedAt > 30000) {
    chatCheckedAt = Date.now();
    refreshChatUnread().catch(() => {});
  }
  const routes = state.church ? churchRoutes : rootRoutes;
  for (const [re, view] of routes) {
    const m = path.match(re);
    if (!m) continue;
    window.scrollTo(0, 0);
    try {
      await view(ctx, ...m.slice(1));
      if (ctx.alive()) mountPlaceMaps($view).catch(() => {});
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
      const email = await ask('E-mail do administrador desta igreja:', { input: 'email', ok: 'Salvar', placeholder: 'nome@exemplo.com' });
      if (!email) return;
      const { error } = await sb.rpc('set_church_admin', { p_church: id, p_email: email.trim(), p_name: null });
      if (error) return toast(errorText(error), 'error');
      toast(`Pronto. ${email.trim()} já pode entrar e aceitar o convite.`);
      await loadMemberships();
    };
    row.querySelector('[data-active]').onclick = async (e) => {
      const active = e.currentTarget.dataset.active === 'true';
      if (!active && !await ask('Desativar esta igreja? Ninguém mais acessa o app dela até você reativar.')) return;
      const { error } = await sb.rpc('set_church_active', { p_church: id, p_active: active });
      if (error) return toast(errorText(error), 'error');
      render();
    };
  });
}

// ---------------------------------------------------------------------
// Página da igreja
// ---------------------------------------------------------------------
// Só links https:// viram botão (um "javascript:" gravado direto no banco não roda; o banco também barra).
const safeLink = (v) => typeof v === 'string' && /^https:\/\/[^\s"<>'`]+$/i.test(v);

function socialLinks(c) {
  const links = SOCIAL.filter(([k]) => safeLink(c.social?.[k])).map(
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
      ${placeBlock({ lat: c.lat, lng: c.lng, address: [c.address, c.city].filter(Boolean).join(', ') })}
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
    if (!await ask(`Tirar o seu e-mail do cadastro de ${c.name}?`)) return;
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
        ${featureOn('visitantes') ? `<a class="btn" href="#/visitante">${icon.user} Sou visitante: deixar meu contato</a>` : ''}
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
    ['devocional', icon.book, 'Devocional', '#/devocional'],
    ['agenda', icon.calendar, 'Agenda', '#/agenda'],
    ['avisos', icon.megaphone, 'Avisos', '#/avisos'],
    ['aniversarios', icon.cake, 'Aniversariantes', '#/aniversariantes'],
    ['oracao', icon.heart, 'Oração', '#/oracao'],
    ['celulas', icon.users, isLeaderRole(m.role) ? 'Células' : 'Célula', '#/celulas'],
    ['escalas', icon.clipboard, 'Escalas', '#/escalas'],
    ['infantil', icon.child, 'Check-in', '#/infantil'],
    ['carteirinha', icon.idcard, 'Carteirinha', '#/carteirinha'],
    ['galeria', icon.image, 'Galeria', '#/galeria'],
    ['visitantes', icon.user, 'Visitantes', '#/visitantes'],
    ['pix', icon.pix, 'Ofertar', '#/ofertar'],
  ].filter(([k]) =>
    k === 'pix' ? offerReady() : k === 'aniversarios' ? datesOn() : k === 'visitantes' ? visitorTeam() : k === 'infantil' ? kidsTeam() : featureOn(k),
  );
  $view.innerHTML = `
    <div class="page">
      ${head}
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
      <div class="carousel" id="home-carousel" hidden>
        <div class="carousel-track">
          <div class="slide" id="home-kids"></div>
          <div class="slide" id="home-schedules"></div>
          <div class="slide" id="home-devotional"></div>
          <div class="slide" id="home-reading"></div>
          <div class="slide" id="home-notices"></div>
          <div class="slide" id="home-events"></div>
          <div class="slide" id="week-birthdays"></div>
        </div>
        <div class="carousel-dots"></div>
      </div>
      <div id="push-invite"></div>
      ${aboutCard(c)}
    </div>`;
  const slot = (id) => document.getElementById(id);
  const box = slot('home-carousel');
  const changed = () => setupCarousel(box);
  if (featureOn('devocional')) {
    homeDevotionalCard(slot('home-devotional'), changed).catch(() => {});
    homeReadingCard(slot('home-reading'), changed).catch(() => {});
  }
  if (featureOn('infantil')) homeKidsCard(slot('home-kids'), changed).catch(() => {});
  if (featureOn('escalas')) homeSchedulesCard(slot('home-schedules'), changed).catch(() => {});
  if (featureOn('avisos')) homeNoticesCard(slot('home-notices'), changed).catch(() => {});
  if (featureOn('agenda')) homeEventsCard(slot('home-events'), changed).catch(() => {});
  if (datesOn()) weekBirthdaysCard(slot('week-birthdays'), changed).catch(() => {});
  pushInvite(document.getElementById('push-invite')).catch(() => {});
  maybeSuggestInstall(c);
  prefetchMembers();
  prefetchScreens();
}

// Carrossel do Início: só os cartões com conteúdo; desliza para o lado e as bolinhas
// mostram (e levam a) cada cartão. Não passa sozinho. Pode ser chamado de novo quando um
// cartão muda (primeiro com o guardado no aparelho, depois com o que veio do banco).
function setupCarousel(box) {
  if (!box?.isConnected) return;
  const track = box.querySelector('.carousel-track');
  const all = [...track.querySelectorAll('.slide')];
  all.forEach((sl) => (sl.hidden = !sl.children.length));
  const slides = all.filter((sl) => !sl.hidden);
  box.hidden = !slides.length;
  const dots = box.querySelector('.carousel-dots');
  dots.hidden = slides.length < 2;
  if (slides.length < 2) return;
  const titleOf = (sl) => sl.querySelector('h2')?.textContent.trim() || 'Cartão';
  const step = () => slides[1].offsetLeft - slides[0].offsetLeft;
  const current = () => Math.min(slides.length - 1, Math.round(track.scrollLeft / step()));
  const at = current();
  dots.innerHTML = slides
    .map((sl, i) => `<button type="button" aria-label="${esc(titleOf(sl))}" ${i === at ? 'aria-current="true"' : ''}></button>`)
    .join('');
  const buttons = [...dots.children];
  buttons.forEach((b, i) => (b.onclick = () => track.scrollTo({ left: i * step(), behavior: 'smooth' })));
  track.onscroll = () => {
    const i = current();
    buttons.forEach((b, j) => (j === i ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
  };
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
        ${featureOn('relatorios') && isLeaderRole(m.role) ? `<a class="menu-row" href="#/relatorios">${icon.chart}<span>Relatórios</span>${icon.chevron}</a>` : ''}
        ${treasury() ? `<a class="menu-row" href="#/financeiro">${icon.wallet}<span>Financeiro</span>${icon.chevron}</a>` : ''}
        ${admin ? `<a class="menu-row" href="#/config">${icon.gear}<span>Configurar a igreja</span>${icon.chevron}</a>` : ''}
        ${state.memberships.length > 1 || state.platformAdmin ? `<a class="menu-row" href="${esc(ROOT_URL)}">${icon.swap}<span>Trocar de igreja</span>${icon.chevron}</a>` : ''}
        ${datesOn() ? `<a class="menu-row" href="#/aniversariantes">${icon.cake}<span>Aniversariantes do mês</span>${icon.chevron}</a>` : ''}
        ${visitorTeam() ? `<a class="menu-row" href="#/visitantes">${icon.user}<span>Visitantes</span>${icon.chevron}</a>` : ''}
        ${featureOn('galeria') ? `<a class="menu-row" href="#/galeria">${icon.image}<span>Galeria de fotos</span>${icon.chevron}</a>` : ''}
        ${featureOn('carteirinha') ? `<a class="menu-row" href="#/carteirinha">${icon.idcard}<span>Minha carteirinha</span>${icon.chevron}</a>` : ''}
        ${featureOn('infantil') ? `<a class="menu-row" href="#/filhos">${icon.child}<span>Meus filhos</span>${icon.chevron}</a>` : ''}
        ${kidsTeam() ? `<a class="menu-row" href="#/infantil">${icon.child}<span>Check-in infantil</span>${icon.chevron}</a>` : ''}
        ${featureOn('escalas') ? `<a class="menu-row" href="#/escalas">${icon.clipboard}<span>Ministérios e escalas</span>${icon.chevron}</a>` : ''}
        ${featureOn('celulas') ? `<a class="menu-row" href="#/celulas">${icon.users}<span>${isLeaderRole(m.role) ? 'Células' : 'Minha célula'}</span>${icon.chevron}</a>` : ''}
        ${featureOn('devocional') ? `<a class="menu-row" href="#/devocional">${icon.book}<span>Devocional</span>${icon.chevron}</a><a class="menu-row" href="#/leitura">${icon.book}<span>Plano de leitura</span>${icon.chevron}</a>` : ''}
        ${featureOn('oracao') ? `<a class="menu-row" href="#/oracao">${icon.heart}<span>Pedidos de oração</span>${icon.chevron}</a>` : ''}
        ${featureOn('oracao') && isPastoral() ? `<a class="menu-row" href="#/oracao/moderar">${icon.heart}<span>Moderar pedidos de oração</span>${icon.chevron}</a>` : ''}
        ${offerReady() ? `<a class="menu-row" href="#/ofertar">${icon.pix}<span>Dízimos e ofertas</span>${icon.chevron}</a>` : ''}
        ${featureOn('financeiro') ? `<a class="menu-row" href="#/prestacao">${icon.wallet}<span>Prestação de contas</span>${icon.chevron}</a>` : ''}
        ${featureOn('chat') ? `<a class="menu-row" href="#/chat">${icon.chat}<span>Conversas${chatUnread ? ` (${chatUnread})` : ''}</span>${icon.chevron}</a>` : ''}
        <a class="menu-row" href="#/notificacoes">${icon.bell}<span>Notificações</span>${icon.chevron}</a>
        ${admin ? messageLinks() : ''}
        <a class="menu-row" href="#/meus-dados">${icon.user}<span>Meus dados: baixar ou excluir</span>${icon.chevron}</a>
        ${themeChosen() ? `<button class="menu-row" id="theme-auto">${currentTheme() === 'dark' ? icon.moon : icon.sun}<span>Tema: seguir o celular</span></button>` : ''}
        <a class="menu-row" href="#/ajuda">${icon.help}<span>Ajuda: como funciona</span>${icon.chevron}</a>
        <a class="menu-row" href="#/privacidade">${icon.shield}<span>Privacidade e termos</span>${icon.chevron}</a>
        <button class="menu-row" id="logout">${icon.logout}<span>Sair</span></button>
      </div>
    </div>`;
  document.getElementById('logout').onclick = signOut;
  document.getElementById('theme-auto')?.addEventListener('click', () => {
    setTheme(null);
    toast('Pronto: o tema volta a seguir o do celular.');
    render();
  });
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
        <p>Um arquivo com tudo o que o app guarda sobre você: os seus cadastros em cada igreja, as suas células e presenças, os seus ministérios e escalas, as suas inscrições em eventos, os seus filhos e as entradas deles no infantil, os dados da carteirinha, os álbuns que publicou e os pedidos para tirar fotos, as suas conversas do chat, os seus pedidos de oração, os seus planos de leitura, as notificações, as mensagens enviadas, os aparelhos com notificação e o que você publicou.</p>
        <button class="btn" id="export">Baixar arquivo</button>
        <p class="hint">Para corrigir algum dado, use "Meu cadastro" ou fale com a secretaria da igreja.</p>
      </section>

      ${
        here
          ? `<section class="card">
              <h2>Sair da ${esc(state.church.name)}</h2>
              <p>O seu cadastro, a sua foto, os seus pedidos de oração e os seus planos de leitura nesta igreja são apagados, e você deixa de receber as mensagens dela. A sua conta e as outras igrejas continuam.</p>
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
    if (!await ask(`Sair da ${state.church.name}? O seu cadastro nesta igreja será apagado.`)) return;
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
      await ask('Sua conta foi excluída.', { readonly: true });
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
          `<p>A aba <a href="#/agenda">Agenda</a> mostra os cultos e eventos dos próximos 3 meses. Toque num evento para ver os detalhes, o mapa do local e a rota pelo Google Maps ou pelo Waze.</p>
           <p><strong>Adicionar à agenda</strong> baixa um arquivo: abra-o para salvar na agenda do celular. Cultos que se repetem entram na agenda toda semana. Se preferir, use o botão <em>Google Agenda</em>.</p>${
             features('inscricoes')
               ? `<p><strong>Inscrições:</strong> nos eventos com inscrição (retiros, cursos), toque em <em>Quero me inscrever</em>. A confirmação chega no app e por e-mail. Se as vagas acabaram, você pode entrar na <strong>lista de espera</strong>: quando alguém cancelar, a vaga é sua automaticamente e você recebe um aviso. Se não puder ir, cancele pelo app para liberar a vaga. Ninguém vê quem mais se inscreveu.</p>`
               : ''
           }`,
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
    ...(features('escalas')
      ? [[
          'Ministérios e escalas',
          `<p>Em <a href="#/escalas">Menu &gt; Ministérios e escalas</a> ficam as suas escalas. Toque em <em>Confirmo</em> para avisar que vai servir, ou em <em>Pedir troca</em> se não puder (o líder do ministério recebe o pedido e escolhe outra pessoa). Você recebe um aviso quando é escalado e um lembrete na véspera.</p>
           <p>Em cada ministério de que você participa, você vê a equipe e as próximas escalas. <strong>Se você lidera o ministério</strong>, toque em <em>Nova escala</em>: escolha a data e o horário, marque quem serve e escreva a função de cada um (ex.: Vocal, Teclado, Recepção). Você também coloca e tira pessoas da equipe.</p>`,
        ]]
      : []),
    ...(features('chat')
      ? [[
          'Chat',
          `<p>Toque no ícone de conversa no topo (ou em <a href="#/chat">Menu &gt; Conversas</a>) e no botão <strong>+</strong>, embaixo à direita: aparece a lista de quem você pode chamar (dá para buscar pelo nome). ${
            isLeaderRole(myRole())
              ? 'Você pode escrever para qualquer pessoa da igreja que recebe mensagens.'
              : features('chat_membros')
                ? 'Você pode escrever para a liderança e, buscando pelo nome, para outros membros.'
                : 'Você escreve para um pastor, um líder ou a secretaria.'
          } O número no ícone mostra as conversas com mensagem nova.</p>
           <p><strong>Só as duas pessoas leem a conversa</strong>: nem a liderança da igreja nem o administrador do app. Se alguém incomodar, toque em ⋯ para <em>Bloquear</em> ou <em>Denunciar</em> (o administrador da igreja recebe os nomes e o motivo, nunca as mensagens).</p>
           <p>Para <strong>apagar uma conversa</strong>, arraste-a para a esquerda na lista (ou toque em ⋯ e em <em>Apagar conversa</em>). Ela some só para você: a outra pessoa continua vendo. Se chegar mensagem nova, a conversa volta só com o que é novo. Logo depois de apagar, dá para tocar em <em>Desfazer</em>.</p>
           <p>Com as notificações ativadas, chega um aviso no celular a cada mensagem nova. O aviso mostra só quem escreveu, nunca o texto (a tela do celular bloqueado pode ser vista por outras pessoas).</p>
           <p>Não quer receber mensagens? Desligue <em>Receber mensagens pelo chat</em> em <a href="#/perfil">Meu cadastro</a>.</p>`,
        ]]
      : []),
    ...(features('galeria')
      ? [[
          'Galeria de fotos',
          `<p>Em <a href="#/galeria">Menu &gt; Galeria de fotos</a> ficam os álbuns da igreja. Toque numa foto para ver em tela cheia, passar para o lado, baixar ou compartilhar. Só quem é da igreja vê as fotos.</p>
           <p>Se você aparece numa foto e prefere que ela saia, toque em <em>Pedir para tirar esta foto</em>: quem publica a galeria recebe o pedido.</p>${
             galleryTeam()
               ? `<p><strong>Se você publica na galeria:</strong> toque no botão <strong>+</strong>, embaixo à direita, para criar o álbum e, dentro dele, em <em>Adicionar fotos</em> (dá para escolher várias de uma vez). O app reduz cada foto no celular antes de enviar, para gastar pouco espaço. A igreja pode ter até ${GALLERY_LIMIT} fotos: apague álbuns antigos quando chegar perto. Evite fotos de crianças em que elas apareçam de perto sem a autorização dos pais.</p>`
               : ''
           }`,
        ]]
      : []),
    ...(features('carteirinha')
      ? [[
          'Carteirinha digital',
          '<p>Em <a href="#/carteirinha">Menu &gt; Minha carteirinha</a> está a sua carteirinha de membro, com o QR Code. Ela abre mesmo sem internet. Toque em <em>Salvar imagem</em> para guardar na galeria do celular.</p><p>Quem apontar a câmera para o QR Code vê se você é membro ativo, com o nome, o papel e "membro desde" (sem foto, telefone ou e-mail). Se alguém copiou a sua carteirinha, toque em <em>Gerar novo QR Code</em>: o anterior deixa de valer.</p>',
        ]]
      : []),
    ...(features('infantil')
      ? [[
          'Ministério infantil (check-in)',
          `<p>Em <a href="#/filhos">Menu &gt; Meus filhos</a>, toque no botão <strong>+</strong>, embaixo à direita, e cadastre os seus filhos com a data de nascimento e, se houver, as alergias e os cuidados. Só você, a equipe do infantil e a liderança veem.</p>
           <p>No culto, a equipe faz a entrada e você recebe no app um <strong>código de retirada</strong> de 4 letras e números (ele também aparece no Início). Para buscar a criança, mostre o código: sem ele, a equipe não libera. Você recebe um aviso na entrada e na retirada.</p>${
             kidsTeam()
               ? `<p><strong>Se você é da equipe do infantil:</strong> em <a href="#/infantil">Menu &gt; Check-in infantil</a>, busque a criança e toque em <em>Entrada</em>; confira a sala (sugerida pela idade) e imprima as etiquetas, uma para a criança e outra com o código para o responsável. Sem impressora, escreva o código num adesivo. Na saída, toque em <em>Retirada por código</em> e digite o código que o responsável mostrar. Crianças de quem não usa o app são cadastradas na hora: toque no botão <strong>+</strong>, embaixo à direita, e em <em>Cadastrar criança</em>.</p>`
               : ''
           }`,
        ]]
      : []),
    ...(features('devocional')
      ? [[
          'Devocional e plano de leitura',
          `<p>Em <a href="#/devocional">Devocional</a> você lê a mensagem do dia, escrita pelos pastores e líderes. Ela também aparece no Início. Toque em <em>Amém</em> 🙏 se a palavra falou com você (ninguém vê quem tocou, só o total) e em <em>Ler na Bíblia</em> para abrir o versículo na YouVersion.</p>
           <p>Em <a href="#/leitura">Plano de leitura</a>, toque em <em>Entrar no plano</em>. Todo dia aparece a leitura de hoje: toque em cada trecho para ler e, depois, no círculo para marcar como lida. Se ficar para trás, as leituras atrasadas ficam separadas para você pôr em dia. Ninguém vê o seu progresso.</p>
           <p>Às 7h chega o aviso do devocional (quando a liderança marcar) e o lembrete da leitura, se você ainda não leu. O lembrete se desliga dentro do plano, em <em>Minha participação</em>.</p>`,
        ]]
      : []),
    ...(features('oracao')
      ? [[
          'Pedidos de oração',
          `<p>Em <a href="#/oracao">Pedidos de oração</a>, toque no botão <strong>+</strong>, embaixo à direita, e escolha para quem vai:</p>
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
    ...(features('financeiro')
      ? [[
          'Prestação de contas',
          `<p>Em <a href="#/prestacao">Menu &gt; Prestação de contas</a> estão os meses que a tesouraria da igreja fechou e publicou: o total de cada categoria de entrada (dízimos, ofertas…) e de saída (aluguel, luz…), o resultado do mês e o saldo. Quando sai um mês novo, você recebe um aviso.</p>
           <p>Aparecem só os totais: ninguém vê quem deu quanto. Toque em <em>Imprimir</em> para levar ao mural da igreja.</p>`,
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
      `<p>Na aba <a href="#/membros">Membros</a>, toque no botão <strong>+</strong>, embaixo à direita, e em <em>Novo membro</em>. Só o nome é obrigatório, mas <strong>sem e-mail a pessoa não consegue entrar no app</strong>. Marque que a pessoa concordou em ter os dados no app.</p>
       <p>A etiqueta de cada pessoa mostra a situação:</p>
       <ul class="bullets">
         <li><strong>Ainda não entrou:</strong> tem e-mail, mas ainda não abriu o app. Mande o endereço do app para ela.</li>
         <li><strong>Convite pendente:</strong> já entrou, falta tocar em <em>Aceito participar</em>.</li>
         <li><strong>No app:</strong> tudo certo.</li>
         <li><strong>Sem e-mail:</strong> não entra no app, mas aparece na lista de membros e nos aniversariantes.</li>
       </ul>
       <p>Quem saiu da igreja pode ficar <em>Inativo</em>: some das listas e não acessa o app, mas o cadastro fica guardado. Para inativar, arraste a pessoa para a esquerda na lista (ou mude a <em>Situação</em> no cadastro dela); em <em>Inativos</em>, o mesmo gesto reativa.</p>`,
    ],
    [
      'Importar uma planilha de membros',
      `<p>Em <a href="#/membros/importar">Membros &gt; + &gt; Importar planilha</a>, toque em <em>Baixar modelo</em> e preencha no Excel ou no Google Planilhas, com as colunas <strong>nome</strong>, <strong>email</strong>, <strong>telefone</strong> e <strong>nascimento</strong> (datas como 15/03/1980)${features('datas_especiais') ? '. Se quiser, acrescente <strong>casamento</strong> e <strong>batismo</strong>' : ''}.</p>
       <p>Salve como <strong>CSV</strong> e escolha o arquivo. O app mostra uma prévia antes de gravar: as linhas com erro são explicadas, e quem já tem o e-mail cadastrado é pulado.</p>`,
    ],
    ...(features('agenda')
      ? [[
          'Criar eventos e cultos',
          `<p>Na <a href="#/agenda">Agenda</a>, toque no botão <strong>+</strong>, embaixo à direita. Para os cultos fixos, marque <strong>Repetir toda semana</strong> (e, se quiser, até quando).</p>
           <p>Em <strong>Marcar no mapa</strong>, busque o endereço ou toque no ponto exato: quem abrir o evento vê o mapa e tem os botões de rota pelo Google Maps e pelo Waze. O mesmo vale para o local das células e o endereço da igreja.</p>
           ${features('inscricoes') ? '<p>Num evento que não se repete, marque <strong>Abrir inscrições</strong> e, se quiser, o número de vagas, o prazo e a lista de espera. Na página do evento, <em>Ver inscritos</em> mostra os confirmados e a fila, com telefone e e-mail, e baixa a planilha. Se você tirar alguém, a pessoa recebe um aviso e o primeiro da fila entra no lugar.</p>' : ''}
           <p>Escolha o <strong>lembrete</strong>: os membros com notificação ativada recebem 1 hora, 2 horas, 3 horas ou 1 dia antes. Editar ou excluir um evento que se repete vale para todas as semanas.</p>`,
        ]]
      : []),
    ...(features('avisos')
      ? [[
          'Publicar avisos',
          `<p>Em <a href="#/avisos">Avisos</a>, toque no botão <strong>+</strong>, embaixo à direita. Você pode <strong>fixar no topo</strong> e escolher <strong>até quando</strong> ele aparece (depois some para os membros, mas a liderança continua vendo).</p>
           <p>Marque <strong>Mandar notificação para os membros</strong> só nos avisos importantes. Isso só pode ser escolhido ao publicar.</p>`,
        ]]
      : []),
    ...(features('visitantes')
      ? [[
          'Visitantes',
          `<p>Em <a href="#/visitantes">Menu &gt; Visitantes</a>, toque no botão do <strong>QR Code</strong>, embaixo à direita, e projete no telão ou imprima. O visitante aponta a câmera, preenche um cadastro rápido (sem precisar de conta) e autoriza a igreja a guardar os dados.</p>
           <p>A cada visitante, a liderança (ou a equipe do ministério de Acolhimento, se houver) recebe uma notificação. Abra o cadastro para <strong>chamar no WhatsApp</strong> (a mensagem já vem escrita), mudar a situação (<em>Novo, Contatado, Acompanhando, Virou membro, Sem interesse</em>) e anotar o acompanhamento. <em>Cadastrar como membro</em> leva os dados para o cadastro de membros.</p>
           <p>O administrador muda a mensagem do WhatsApp na tela do QR Code. Quem não virou membro é apagado sozinho 12 meses depois do cadastro.</p>`,
        ]]
      : []),
    ...(features('relatorios')
      ? [[
          'Relatórios',
          '<p>Em <a href="#/relatorios">Menu &gt; Relatórios</a>, escolha o período (3, 6 ou 12 meses, ou o ano) e veja os números da igreja: membros (novos por mês, faixa etária, quem usa o app), visitantes e quantos viraram membros, frequência das células, crianças no infantil, confirmações nas escalas, inscrições nos eventos e a participação no app. Cada parte tem <em>Baixar planilha</em>, que abre no Excel ou no Google Planilhas.</p><p>O relatório mostra só totais. <em>Lista de membros completa</em> baixa o cadastro de todos (nome, contato, nascimento, papel e situação): guarde a planilha com cuidado, porque tem dados pessoais.</p>',
        ]]
      : []),
    ...(features('financeiro')
      ? [[
          'Financeiro (tesouraria)',
          `<p>O administrador marca quem cuida do dinheiro: no cadastro da pessoa, em <a href="#/membros">Membros</a>, marque <strong>Tesouraria</strong>. Só o administrador e a tesouraria veem o <a href="#/financeiro">Menu &gt; Financeiro</a>.</p>
           <p>Lá, toque no botão <strong>+</strong>, embaixo à direita, e em <em>Novo lançamento</em> para lançar uma <strong>entrada</strong> (dízimos, ofertas…), uma <strong>saída</strong> (aluguel, luz…) ou uma <strong>transferência</strong> entre contas (ex.: o dinheiro do culto depositado no banco). As setas trocam o mês; a tela mostra os totais e o saldo de cada conta. Arraste um lançamento para a esquerda para apagar.</p>
           <p>Para lançar muita coisa de uma vez, toque no <strong>+</strong> e em <a href="#/financeiro/importar">Importar planilha</a>: baixe o modelo, preencha no Excel ou no Google Planilhas e salve como CSV. O app mostra os erros de cada linha antes de gravar e pula o que já foi lançado (importar de novo não duplica). <em>Baixar planilha do mês</em> traz os lançamentos no mesmo formato, para o contador. Importou errado? <em>Apagar os lançamentos do mês</em> tira todos de uma vez (com Desfazer).</p>
           <p>Em <em>Contas e categorias</em>, mude os nomes, crie outras e informe o <strong>saldo inicial</strong> de cada conta (o que ela tinha antes do primeiro lançamento). O app só registra: o dinheiro não passa por ele.</p>
           <p>No fim do mês, toque em <strong>Fechar e publicar o mês</strong> (dá para deixar um recado, como "reforma do telhado concluída"). Os lançamentos do mês ficam travados e todos os membros recebem um aviso para ver a <a href="#/prestacao">Prestação de contas</a>: só os totais por categoria, nunca os lançamentos nem as descrições. Antes de fechar, toque em <em>Prévia</em> para ver como vai ficar. Para corrigir depois, toque em <em>Reabrir o mês</em>: ele sai da prestação até você fechar de novo.</p>`,
        ]]
      : []),
    ...(features('escalas')
      ? [[
          'Organizar os ministérios',
          `<p>Em <a href="#/escalas">Menu &gt; Ministérios e escalas</a>, toque no botão <strong>+</strong>, embaixo à direita (há sugestões prontas: Louvor, Acolhimento, Infantil e Mídia). Depois, abra o ministério, coloque a equipe buscando pelo nome e escolha quem é <strong>Líder</strong>: qualquer pessoa do cadastro pode liderar um ministério e montar as escalas dele.</p>
           <p>Os pedidos de troca aparecem no alto da tela de escalas.${features('visitantes') ? ' Marque <strong>Recebe os avisos de visitantes</strong> no ministério de Acolhimento: a equipe dele passa a receber o aviso de cada visitante e a ver os cadastros para o acompanhamento. Sem esse ministério, o aviso vai para a liderança.' : ''}</p>`,
        ]]
      : []),
    ...(features('celulas')
      ? [[
          'Organizar as células',
          `<p>Em <a href="#/celulas">Menu &gt; Células</a>, toque no botão <strong>+</strong>, embaixo à direita, e preencha o nome, o dia, o horário e o local. Depois, abra a célula e coloque os participantes buscando pelo nome. Ao lado de cada pessoa, escolha quem é <strong>Líder</strong> ou <strong>Auxiliar</strong>: qualquer pessoa do cadastro pode liderar uma célula, mesmo sem outro papel na igreja.</p>
           <p>A lista de células mostra o número de participantes e a <strong>frequência</strong> (a média de presença nos 4 últimos encontros). Embaixo ficam os <strong>membros sem célula</strong>, para encaminhar. Quando uma célula encerrar, desmarque <em>Célula ativa</em> na edição: o histórico fica guardado.</p>`,
        ]]
      : []),
    ...(features('devocional')
      ? [[
          'Escrever o devocional e criar planos de leitura',
          `${
            isPastoral()
              ? `<p>Em <a href="#/devocional">Devocional</a>, toque no botão <strong>+</strong>, embaixo à direita. Escolha o dia em que ele aparece (um por dia), o título, o versículo-base e a mensagem; a imagem é opcional. Dá para deixar vários prontos: os <strong>agendados</strong> só aparecem para os membros no dia marcado. Marque <em>Avisar os membros às 7h</em> para mandar a notificação.</p>`
              : '<p>Os devocionais são escritos pelo pastor (administrador) e pelos líderes.</p>'
          }
           <p>Em <a href="#/leitura">Plano de leitura</a>, toque no botão <strong>+</strong>, embaixo à direita, escolha um dos planos prontos e a data de início: todos leem a mesma parte no mesmo dia. Dentro do plano, a liderança vê quantas pessoas estão lendo e o progresso médio (nunca o de uma pessoa), muda a data de início ou encerra o plano.</p>
           <p>O app não traz o texto da Bíblia (as traduções têm direitos autorais): os links abrem a YouVersion na tradução escolhida em <em>Configurar a igreja &gt; Bíblia</em>.</p>`,
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
         <li><strong>Funcionalidades:</strong> ligue ou desligue a agenda, os avisos, os aniversariantes, as datas especiais, os pedidos de oração, as células, as escalas de ministérios, as inscrições em eventos (precisa da agenda), o check-in infantil, a carteirinha digital, os relatórios, a galeria de fotos, o chat (e se os membros conversam entre si), o cadastro de visitantes o financeiro com a prestação de contas e os dízimos e ofertas (este precisa da chave Pix).</li>
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
async function loadProfile(id) {
  const { data, error } = await sb.from('members').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function viewProfile(ctx) {
  if (!requireLogin('/perfil')) return;
  const me = myMember();
  if (!me?.consent_at) return navigate('/');
  const cached = screenCached('perfil');
  const m = cached && cached.id === me.id ? cached : await screenFetch('perfil', () => loadProfile(me.id));
  if (!ctx.alive()) return;
  if (m === cached) formFresh(ctx, cached, () => screenFetch('perfil', () => loadProfile(me.id)), () => {});
  const photoUrl = photoNow(m.photo_path);
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
      ${
        featureOn('chat')
          ? `<label class="check"><input type="checkbox" name="chat_enabled" ${m.chat_enabled !== false ? 'checked' : ''}> Receber mensagens pelo chat
              <small class="hint">Desligado, ninguém começa conversa nova com você nem escreve nas antigas. Você continua vendo e respondendo as conversas que já tem.</small></label>`
          : ''
      }
      <button class="btn primary big">Salvar</button>
      <p class="hint">Para trocar o e-mail, fale com a secretaria da igreja.</p>
    </form>`;
  const form = document.getElementById('profile');
  photoLater(ctx, form, m.name, m.photo_path);
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
        ...(form.chat_enabled ? { chat_enabled: form.chat_enabled.checked } : {}),
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
      screenForget('perfil');
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
    form.dataset.photoRemoved = '1';
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

const MEMBER_COLUMNS = 'id, church_id, name, email, phone, birth_date, role, status, treasury, user_id, consent_at, photo_path, show_birthday, show_phone, wedding_date, baptism_date, show_wedding, show_baptism, member_since';

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
      <label class="search">${icon.search}<input type="search" id="q" placeholder="Buscar por nome, e-mail ou telefone" aria-label="Buscar membros"></label>
      <div class="chips filters">
        ${[['ativo', 'Ativos'], ['inativo', 'Inativos'], ['todos', 'Todos']]
          .map(([k, label]) => `<a class="chip ${filter === k ? 'active' : ''}" href="#/membros?ver=${k}">${label}</a>`)
          .join('')}
      </div>
      <p class="hint" id="count"></p>
      <p class="hint swipe-hint" id="swipe-hint">Arraste um membro para a esquerda para ${
        { ativo: 'inativar', inativo: 'reativar' }[filter] || 'inativar ou reativar'
      }.</p>
      <div class="list" id="members"></div>
      ${fabMenu('Adicionar membros', [['#/membros/novo', 'Novo membro'], ['#/membros/importar', 'Importar planilha']])}
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
    document.getElementById('swipe-hint').hidden = !rows.length;
    list.innerHTML = rows.length
      ? rows
          .map((m) => {
            const st = accountStatus(m);
            const off = m.status === 'inativo';
            // O próprio cadastro não arrasta: inativar a si mesmo tira o acesso.
            const me = m.user_id === state.user.id;
            const row = `
          <a class="member-row ${off ? 'inactive' : ''} ${me ? '' : 'swipe-row'}" href="#/membros/${m.id}" draggable="false">
            ${avatar(m.name, m.photo_path && minis[miniOf(m.photo_path)])}
            <span><strong>${esc(m.name)}</strong><small>${esc(m.email || fmtPhone(m.phone) || '')}</small></span>
            <span class="tags">
              ${m.role !== 'membro' ? `<span class="tag role">${esc(ROLES[m.role])}</span>` : ''}
              <span class="tag ${st.cls}">${st.label}</span>
            </span>
          </a>`;
            return me
              ? row
              : `<div class="swipe" data-id="${m.id}"><span class="swipe-bg ${off ? 'ok' : ''}" aria-hidden="true">${off ? 'Reativar' : 'Inativar'}</span>${row}</div>`;
          })
          .join('')
      : `<div class="empty"><p>${members.length ? 'Ninguém encontrado.' : 'Nenhum membro cadastrado ainda.'}</p></div>`;
  };
  q.addEventListener('input', draw);

  // Arrastar para a esquerda inativa (ou reativa quem está inativo), com "Desfazer" no aviso.
  // Quem pode mudar a situação, e a proteção do último admin, ficam no banco.
  const setStatus = async (m, status) => {
    const { data, error } = await sb.from('members').update({ status }).eq('id', m.id).select('id');
    if (error) throw error;
    if (!data.length) throw new Error('Você não tem permissão para mudar este cadastro.');
    m.status = status;
    membersCache.set(churchId, members);
    if (ctx.alive()) draw();
  };
  swipeLeft(list, async (wrap) => {
    const m = members.find((x) => x.id === wrap.dataset.id);
    const was = m.status;
    try {
      await setStatus(m, was === 'ativo' ? 'inativo' : 'ativo');
    } catch (err) {
      toast(errorText(err), 'error');
      return false;
    }
    toast(was === 'ativo' ? `${m.name} foi para Inativos.` : `${m.name} voltou para Ativos.`, '', {
      label: 'Desfazer',
      run: () => setStatus(m, was).catch((err) => toast(errorText(err), 'error')),
    });
    return true;
  });
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
    const data = await editItem(
      ctx,
      membersCache.get(state.church.id)?.find((x) => x.id === id),
      async () => {
        const { data: row, error } = await sb.from('members').select(MEMBER_COLUMNS).eq('id', id).maybeSingle();
        if (error) throw error;
        return row;
      },
      () => forgetMembers(),
    );
    if (!data) {
      $view.innerHTML = `<div class="empty"><h2>Cadastro não encontrado</h2><a class="btn" href="#/membros">Voltar aos membros</a></div>`;
      return;
    }
    m = data;
    photoUrl = photoNow(m.photo_path);
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
      ${featureOn('carteirinha') ? `<label>Membro desde (opcional)<input name="member_since" type="date" min="1900-01-02" value="${esc(m.member_since || '')}"><small class="hint">Aparece na carteirinha digital.</small></label>` : ''}
      <label>Papel na igreja
        <select name="role" ${admin ? '' : 'disabled'}>
          ${Object.entries(ROLES).map(([k, label]) => `<option value="${k}" ${m.role === k ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        ${admin ? '' : '<small class="hint">Só o administrador muda o papel.</small>'}
      </label>
      ${
        admin && featureOn('financeiro')
          ? `<label class="check"><input type="checkbox" name="treasury" ${m.treasury ? 'checked' : ''}> Tesouraria
              <small class="hint">Lança as entradas e as saídas no Financeiro e publica a prestação de contas.</small></label>`
          : ''
      }
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
  if (!isNew) photoLater(ctx, form, m.name, m.photo_path);
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
      if (form.member_since) row.member_since = form.member_since.value || null;
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
      // Tesouraria: só o administrador marca (no banco, por set_treasury).
      if (form.treasury && form.treasury.checked !== !!m.treasury) {
        const { error: err } = await sb.rpc('set_treasury', { p_member: memberId, p_on: form.treasury.checked });
        if (err) throw err;
      }
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
    if (!await ask(`Desligar a conta de ${m.name} do app? O cadastro continua, mas a pessoa perde o acesso até entrar de novo e aceitar o convite.`)) return;
    const { error } = await sb.rpc('unlink_member_account', { p_member: m.id });
    if (error) return toast(errorText(error), 'error');
    forgetMembers();
    toast('Conta desligada.');
    render();
  });

  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask(`Excluir o cadastro de ${m.name}? Os dados e a foto são apagados e não dá para desfazer.`)) return;
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

// Linhas → CSV com ";" (Excel em português). Texto que começa com = + - @ ganha um apóstrofo,
// para o Excel não tratar como fórmula.
const csvText = (rows) =>
  rows
    .map((line) =>
      line
        .map((v) => {
          const s = String(v ?? '');
          return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
        })
        .join(';'),
    )
    .join('\r\n');

const IMPORT_MAX = 1000;

async function viewImport(ctx) {
  if (!requireLeader('/membros/importar')) return;
  // A lista de membros já está na memória quando se vem da tela Membros: abre na hora.
  const existing = membersCache.get(state.church.id) ?? (await fetchMembers(state.church.id));
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
  const c = state.church;
  formFresh(
    ctx,
    c,
    async () => {
      const { data, error } = await sb.from('churches').select('*').eq('id', c.id).single();
      if (error) throw error;
      return data;
    },
    (fresh) => {
      state.church = fresh;
      saveBootCache();
    },
  );
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
        ${pinField(c)}
        <small class="hint">Com o alfinete no mapa, a página da igreja mostra o mapa e a rota pelo Google Maps e pelo Waze.</small>
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
        <legend>${icon.book} Bíblia</legend>
        <label>Tradução usada nos links "Ler na Bíblia"
          <select name="bible_version">
            ${Object.entries(BIBLE_VERSIONS).map(([k, [label]]) => `<option value="${k}" ${k === (c.bible_version || 'NVI') ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select>
        </label>
        <p class="hint">Vale para o devocional e o plano de leitura. Os links abrem o texto no app ou no site da YouVersion.</p>
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
  bindPinField(form, { address: () => [form.address.value.trim(), form.city.value.trim()].filter(Boolean).join(', ') });
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
        ...pinValues(form),
        social: newSocial,
        pix_key,
        pix_name: pix_key ? form.pix_name.value.trim() || null : null,
        features,
        bible_version: form.bible_version.value,
        privacy_email: form.privacy_email.value.trim() || null,
        privacy_text: form.privacy_text.value.trim() || null,
      };

      // Logo nova ou fundo do ícone diferente: gera os ícones do app de novo. Igreja que ainda não
      // tem o ícone da barra de notificações (criado depois): gera a partir da logo que já existe e
      // grava a logo de novo, para o site ser publicado com o ícone novo.
      let source = logoFile;
      let refresh = false;
      if (!source && c.logo_url) {
        const iconsUrl = `${CONFIG.SUPABASE_URL}/storage/v1/object/public/igrejas/${c.id}/icons/badge-96.png`;
        const needsBadge = await fetch(iconsUrl, { method: 'HEAD', cache: 'no-store' })
          .then((r) => !r.ok)
          .catch(() => false);
        if (patch.icon_background !== c.icon_background || needsBadge) {
          const res = await fetch(c.logo_url);
          if (res.ok) {
            source = await res.blob();
            refresh = needsBadge;
          }
        }
      }
      if (source) {
        const bucket = sb.storage.from('igrejas');
        if (logoFile || refresh) {
          const logo = await resizeLogo(source);
          const ext = logo.type === 'image/png' ? 'png' : 'webp';
          const path = `${c.id}/logo-${Date.now()}.${ext}`;
          const up = await bucket.upload(path, logo, { contentType: logo.type, cacheControl: '31536000' });
          if (up.error) throw up.error;
          patch.logo_url = bucket.getPublicUrl(path).data.publicUrl;
        }
        const icons = await makeIconSet(source, patch.icon_background);
        // Logo que não vira um desenho (ex.: foto): o ícone da barra de notificações fica o padrão do app.
        if (!icons['badge-96.png']) {
          const res = await fetch('icons/badge-96.png');
          if (res.ok) icons['badge-96.png'] = await res.blob();
        }
        for (const [name, blob] of Object.entries(icons)) {
          const up = await bucket.upload(`${c.id}/icons/${name}`, blob, { contentType: 'image/png', cacheControl: '300', upsert: true });
          if (up.error) throw up.error;
        }
      }

      const { data: saved, error: err } = await sb.from('churches').update(patch).eq('id', c.id).select().single();
      if (err) throw err;

      // A logo antiga não é mais usada.
      const oldPath = c.logo_url?.split('/object/public/igrejas/')[1];
      if ((logoFile || refresh) && oldPath) await sb.storage.from('igrejas').remove([decodeURIComponent(oldPath)]);

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
      await ask('O celular não deixou copiar sozinho. Toque e segure no texto abaixo para copiar:', { input: 'text', value: text, readonly: true });
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
        ${ev.repeat_weekly ? '<small>Toda semana</small>' : ''}${regTag(ev.event_id)}</span>
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

// Cartões do Início: usam os mesmos dados guardados da Agenda e dos Avisos (assim as duas
// telas também abrem na hora). Desenham com o guardado e de novo com o que vier do banco.
async function homeCard(el, name, fetcher, html, changed) {
  if (!isActiveMember()) return;
  let last = null;
  const draw = (data) => {
    const out = html(data);
    if (!el.isConnected || out === last) return;
    last = out;
    el.innerHTML = out;
    changed();
  };
  const cached = screenCached(name);
  if (cached) draw(cached);
  draw(await screenFetch(name, fetcher));
}

function homeEventsCard(el, changed) {
  return homeCard(el, 'agenda', loadAgenda, (all) => {
    const now = Date.now();
    const until = addDays(new Date(), 8).getTime();
    const rows = all
      .filter((ev) => {
        const start = new Date(ev.starts_at).getTime();
        return start < until && new Date(ev.ends_at || start + 2 * 3600e3).getTime() > now;
      })
      .slice(0, 3);
    if (!rows.length) return '';
    return `
    <section class="card">
      <h2>${icon.calendar} Próximos eventos</h2>
      <div class="list">${rows
        .map(
          (ev) => `
        <a class="event-card" href="#/agenda/${ev.event_id}?em=${encodeURIComponent(ev.starts_at)}">
          <span><strong>${esc(ev.title)}</strong><small>${esc(fmtEventWhen(ev))}</small>${regTag(ev.event_id)}</span>${icon.chevron}
        </a>`,
        )
        .join('')}</div>
      <a href="#/agenda">Ver a agenda</a>
    </section>`;
  }, changed);
}

function homeNoticesCard(el, changed) {
  return homeCard(el, 'avisos', loadAnnouncements, (all) => {
    const today = isoLocal(new Date());
    const rows = all.filter((a) => !a.visible_until || a.visible_until >= today).slice(0, 2);
    if (!rows.length) return '';
    return `
    <section class="card">
      <h2>${icon.megaphone} Avisos</h2>
      ${rows
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
  }, changed);
}

const agendaStart = () => {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  return from;
};
const loadAgenda = () => fetchEvents(agendaStart(), addDays(agendaStart(), 90));

async function viewAgenda(ctx) {
  if (!requireMemberFeature('/agenda', 'agenda')) return;
  await screenShow(ctx, 'agenda', loadAgenda, (all) => drawAgenda(all));
}

function drawAgenda(all) {
  // O guardado pode ser de outro dia: tira o que já terminou.
  const now = Date.now();
  const rows = all.filter((ev) => new Date(ev.ends_at || new Date(ev.starts_at).getTime() + 2 * 3600e3).getTime() > now);
  const byDay = new Map();
  for (const ev of rows) {
    const day = isoLocal(new Date(ev.starts_at));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(ev);
  }
  $view.innerHTML = `
    <div class="page">
      <h1>Agenda</h1>
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
      ${isLeaderRole(myRole()) ? fab('#/agenda/novo', 'Novo evento') : ''}
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

// Detalhes dos eventos que ainda vão acontecer (os semanais, sempre): guardados juntos, para
// a tela do evento abrir na hora a partir da agenda.
async function loadEventDetails() {
  const since = new Date(Date.now() - 2 * 864e5).toISOString();
  const { data, error } = await sb
    .from('events')
    .select('*')
    .eq('church_id', state.church.id)
    .or(`repeat_weekly.eq.true,starts_at.gte.${since}`)
    .order('starts_at')
    .limit(300);
  if (error) throw error;
  return data;
}

async function viewEvent(ctx, id) {
  if (!requireMemberFeature(`/agenda/${id}`, 'agenda')) return;
  const cached = screenCached('eventos')?.find((e) => e.id === id) ?? null;
  if (cached) drawEvent(ctx, cached);
  let ev;
  try {
    ev = (await screenFetch('eventos', loadEventDetails)).find((e) => e.id === id) ?? null;
    if (!ev) {
      // Evento antigo (ex.: aberto por uma notificação): busca só ele.
      const { data, error } = await sb.from('events').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      ev = data;
    }
  } catch (err) {
    if (cached) return;
    throw err;
  }
  if (ctx.alive() && JSON.stringify(ev) !== JSON.stringify(cached)) drawEvent(ctx, ev);
}

function drawEvent(ctx, ev) {
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
      ${ev.location ? `<p class="meta">${icon.pin}${esc(ev.location)}</p>` : ''}
      ${placeBlock({ lat: ev.lat, lng: ev.lng, address: ev.location })}
      ${ev.repeat_weekly ? `<p class="hint">Repete toda semana${ev.repeat_until ? ` até ${esc(fmtDate(ev.repeat_until))}` : ''}.</p>` : ''}
      ${ev.description ? `<div class="card"><p class="pre">${esc(ev.description)}</p></div>` : ''}
      ${ev.registration && regsOn() ? '<section class="card" id="reg-box"></section>' : ''}
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
  if (ev.registration && regsOn()) mountRegistration(ctx, ev);
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask(ev.repeat_weekly ? `Excluir "${ev.title}" e todas as repetições?` : `Excluir "${ev.title}"?`)) return;
    const { data, error: err } = await sb.from('events').delete().eq('id', ev.id).select('id');
    if (err || !data.length) return toast(err ? errorText(err) : 'Você não tem permissão para excluir.', 'error');
    screenForget('agenda');
    screenForget('eventos');
    toast('Evento excluído.');
    navigate('/agenda');
  });
}

// ---------------------------------------------------------------------
// Inscrição em eventos: vagas, lista de espera e a lista de inscritos da liderança
// ---------------------------------------------------------------------
const regsOn = () => featureOn('agenda') && featureOn('inscricoes');

async function loadRegistrations() {
  const { data, error } = await sb.rpc('event_registration_summary', { p_church: state.church.id });
  if (error) throw error;
  return data;
}

// Etiqueta da situação da pessoa nos cartões da Agenda e do Início (do que já está guardado).
function regTag(eventId) {
  if (!regsOn()) return '';
  const row = (screenCached('inscricoes') || []).find((r) => r.event_id === eventId);
  if (row?.my_status === 'confirmada') return '<span class="tag ok">Inscrito</span>';
  if (row?.my_status === 'espera') return '<span class="tag wait">Na lista de espera</span>';
  return '';
}

// Quadro de inscrição da página do evento: desenha com o guardado e de novo com o banco.
function mountRegistration(ctx, ev) {
  const box = document.getElementById('reg-box');
  if (!box) return;
  const draw = (list) => {
    if (ctx.alive() && box.isConnected) drawRegistration(ctx, box, ev, (list || []).find((r) => r.event_id === ev.id));
  };
  const cached = screenCached('inscricoes');
  draw(cached);
  screenFetch('inscricoes', loadRegistrations)
    .then((fresh) => JSON.stringify(fresh) !== JSON.stringify(cached) && draw(fresh))
    .catch(() => {});
}

function drawRegistration(ctx, box, ev, row) {
  const leader = isLeaderRole(myRole());
  if (!row) {
    box.innerHTML = `<h2>${icon.users} Inscrições</h2><p class="hint">Carregando as inscrições…</p>`;
    return;
  }
  const started = new Date(ev.starts_at) <= new Date();
  const left = row.capacity == null ? null : Math.max(row.capacity - row.confirmed, 0);
  const vagas =
    left == null ? 'Sem limite de vagas.' : left ? `${left === 1 ? 'Resta 1 vaga' : `Restam ${left} vagas`} de ${row.capacity}.` : `Vagas esgotadas (${row.capacity}).`;
  const until = row.registration_until
    ? `Inscrições até ${new Date(row.registration_until).toLocaleString('pt-BR', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}.`
    : '';
  let mine;
  if (row.my_status === 'confirmada') {
    mine = `<p class="reg-status ok">✅ Você está inscrito.</p>
      ${started ? '' : '<button class="btn danger-outline" data-reg="out">Cancelar minha inscrição</button>'}`;
  } else if (row.my_status === 'espera') {
    mine = `<p class="reg-status wait">⏳ Você está na lista de espera: posição ${row.my_position}. Se abrir uma vaga, ela é sua e você recebe um aviso.</p>
      ${started ? '' : '<button class="btn danger-outline" data-reg="out">Sair da lista de espera</button>'}`;
  } else if (!row.open) {
    mine = '<p class="hint">As inscrições estão encerradas.</p>';
  } else if (left === 0 && !row.waitlist) {
    mine = '<button class="btn primary big" disabled>Vagas esgotadas</button>';
  } else {
    mine = `<button class="btn primary big" data-reg="in">${left === 0 ? 'Entrar na lista de espera' : 'Quero me inscrever'}</button>`;
  }
  box.innerHTML = `
    <h2>${icon.users} Inscrições</h2>
    <p>${esc(vagas)} ${esc(until)}${row.waiting ? ` ${row.waiting} na lista de espera.` : ''}</p>
    ${mine}
    ${leader ? `<a class="btn" href="#/agenda/${ev.id}/inscritos">Ver inscritos (${row.confirmed}${row.waiting ? ` + ${row.waiting} na espera` : ''})</a>` : ''}`;

  box.querySelector('[data-reg]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const joining = btn.dataset.reg === 'in';
    const confirmed = row.my_status === 'confirmada';
    if (
      !joining &&
      !(await ask(confirmed ? 'Cancelar a sua inscrição? A vaga passa para a próxima pessoa da fila.' : 'Sair da lista de espera?', {
        ok: confirmed ? 'Cancelar inscrição' : 'Sair da lista',
        danger: true,
      }))
    )
      return;
    btn.disabled = true;
    const { data: status, error } = joining
      ? await sb.rpc('event_register', { p_event: ev.id })
      : await sb.rpc('event_unregister', { p_event: ev.id });
    if (error) {
      btn.disabled = false;
      return toast(errorText(error), 'error');
    }
    screenForget(`inscritos:${ev.id}`);
    toast(
      !joining
        ? 'Inscrição cancelada.'
        : status === 'confirmada'
          ? 'Inscrição confirmada! Você recebe a confirmação no app e por e-mail.'
          : 'Você entrou na lista de espera.',
    );
    try {
      const fresh = await loadRegistrations();
      screenUpdate('inscricoes', fresh);
      if (ctx.alive() && box.isConnected) drawRegistration(ctx, box, ev, fresh.find((r) => r.event_id === ev.id));
    } catch {
      screenForget('inscricoes');
      render();
    }
  });
}

async function loadRegistrants(id) {
  const [evRes, listRes] = await Promise.all([
    sb.from('events').select('id, title, starts_at, ends_at, capacity').eq('id', id).maybeSingle(),
    sb.rpc('event_registrants', { p_event: id }),
  ]);
  if (evRes.error) throw evRes.error;
  if (listRes.error) throw listRes.error;
  return { ev: evRes.data, list: listRes.data };
}

async function viewRegistrants(ctx, id) {
  if (!requireMemberFeature(`/agenda/${id}/inscritos`, 'inscricoes')) return;
  if (!isLeaderRole(myRole())) return navigate(`/agenda/${id}`);
  await screenShow(ctx, `inscritos:${id}`, () => loadRegistrants(id), (d) => drawRegistrants(id, d));
}

function drawRegistrants(id, { ev, list }) {
  if (!ev) {
    $view.innerHTML = `<div class="empty"><h2>Evento não encontrado</h2><a class="btn" href="#/agenda">Voltar à agenda</a></div>`;
    return;
  }
  const confirmed = list.filter((r) => r.status === 'confirmada');
  const waiting = list.filter((r) => r.status === 'espera');
  const when = (iso) => new Date(iso).toLocaleString('pt-BR', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const row = (r, i) => `
    <div class="member-row" data-reg-id="${r.id}">
      <span class="avatar">${r.status === 'espera' ? i + 1 : icon.user}</span>
      <span><strong>${esc(r.name)}</strong>
        <small>${[r.phone ? `<a href="tel:+${esc(r.phone)}">${esc(fmtPhone(r.phone))}</a>` : '', r.email ? esc(r.email) : '', `inscrição em ${esc(when(r.created_at))}`].filter(Boolean).join(' · ')}</small></span>
      <span class="tags"><button class="btn small danger-outline" data-remove aria-label="Tirar ${esc(r.name)} da lista">Tirar</button></span>
    </div>`;
  $view.innerHTML = `
    <div class="page">
      <a href="#/agenda/${id}" class="back">← ${esc(ev.title)}</a>
      <h1>Inscritos</h1>
      <p class="hint">${esc(ev.title)} · ${esc(fmtEventWhen(ev))}</p>
      <div class="actions-row"><button class="btn" id="csv" ${list.length ? '' : 'disabled'}>${icon.upload} Baixar planilha</button></div>
      <h2>Confirmados (${confirmed.length}${ev.capacity ? ` de ${ev.capacity}` : ''})</h2>
      <div class="list">${confirmed.map(row).join('') || '<div class="empty"><p>Ninguém inscrito ainda.</p></div>'}</div>
      ${waiting.length ? `<h2>Lista de espera (${waiting.length})</h2><div class="list">${waiting.map(row).join('')}</div>` : ''}
      <p class="hint">Quem cancela ou é tirado libera a vaga: o primeiro da lista de espera entra sozinho e recebe um aviso.</p>
    </div>`;

  document.getElementById('csv').onclick = () => {
    const cell = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const lines = [
      ['Situação', 'Posição na espera', 'Nome', 'Telefone', 'E-mail', 'Inscrição em'],
      ...confirmed.map((r) => ['Confirmada', '', r.name, r.phone ? fmtPhone(r.phone) : '', r.email, when(r.created_at)]),
      ...waiting.map((r, i) => ['Lista de espera', i + 1, r.name, r.phone ? fmtPhone(r.phone) : '', r.email, when(r.created_at)]),
    ];
    downloadFile(`inscritos-${slugify(ev.title)}.csv`, lines.map((l) => l.map(cell).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
  };
  $view.querySelectorAll('[data-reg-id]').forEach((el) => {
    el.querySelector('[data-remove]').onclick = async () => {
      const name = el.querySelector('strong').textContent;
      if (!await ask(`Tirar ${name} da lista? A pessoa recebe um aviso, e a vaga passa para a lista de espera.`)) return;
      const { error } = await sb.rpc('event_registration_remove', { p_registration: el.dataset.regId });
      if (error) return toast(errorText(error), 'error');
      screenForget(`inscritos:${id}`);
      screenForget('inscricoes');
      toast(`${name} saiu da lista.`);
      render();
    };
  });
}

const timeValue = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// Campo de horário com duas listas (hora e minutos), no lugar do campo de hora do navegador: a janela de
// horas do Android corta o botão "Definir" com letra grande, e as listas se ajustam a qualquer tela.
// O valor ("19:30" ou "") fica num campo escondido com o mesmo nome, para o formulário ler igual.
const pad2 = (n) => String(n).padStart(2, '0');
function timeField(name, label, value = '', { required = false } = {}) {
  const [h, m] = value ? value.slice(0, 5).split(':') : ['', ''];
  const minutes = Array.from({ length: 12 }, (_, i) => pad2(i * 5));
  if (m && !minutes.includes(m)) minutes.push(m), minutes.sort();
  return `
    <div class="time-field" role="group" aria-labelledby="time-${name}">
      <span class="field-label" id="time-${name}">${esc(label)}</span>
      <div class="time-pick">
        <select data-time="${name}" data-part="h" aria-label="${esc(label)}: hora" ${required ? 'required' : ''}>
          <option value="">--</option>
          ${Array.from({ length: 24 }, (_, i) => pad2(i)).map((x) => `<option value="${x}" ${x === h ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
        <span aria-hidden="true">:</span>
        <select data-time="${name}" data-part="m" aria-label="${esc(label)}: minutos">
          ${minutes.map((x) => `<option value="${x}" ${x === (m || '00') ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
      </div>
      <input type="hidden" name="${name}" value="${h ? `${h}:${m || '00'}` : ''}">
    </div>`;
}
function bindTimeFields(form) {
  form.querySelectorAll('select[data-time]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const name = sel.dataset.time;
      const h = form.querySelector(`select[data-time="${name}"][data-part="h"]`).value;
      const m = form.querySelector(`select[data-time="${name}"][data-part="m"]`).value;
      form[name].value = h ? `${h}:${m}` : '';
    });
  });
}

async function viewEventForm(ctx, id) {
  if (!requireMemberFeature(id ? `/agenda/${id}/editar` : '/agenda/novo', 'agenda')) return;
  if (!isLeaderRole(myRole())) return navigate('/agenda');
  let ev = { title: '', description: '', location: '', starts_at: null, ends_at: null, repeat_weekly: false, repeat_until: null, remind_minutes: 120, registration: false, capacity: null, registration_until: null, waitlist: true };
  if (id) {
    const data = await editItem(
      ctx,
      screenCached('eventos')?.find((e) => e.id === id),
      async () => {
        const { data: row, error } = await sb.from('events').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        return row;
      },
      () => screenForget('eventos'),
    );
    if (!data) return navigate('/agenda');
    ev = data;
  }
  if (!ctx.alive()) return;
  const s = ev.starts_at ? new Date(ev.starts_at) : null;
  const e = ev.ends_at ? new Date(ev.ends_at) : null;
  const ru = ev.registration_until ? new Date(ev.registration_until) : null;

  $view.innerHTML = `
    <form id="event" class="form page">
      <a href="${id ? `#/agenda/${id}` : '#/agenda'}" class="back">← ${id ? 'Evento' : 'Agenda'}</a>
      <h1>${id ? 'Editar evento' : 'Novo evento'}</h1>
      <label>Título<input name="title" required minlength="3" maxlength="120" value="${esc(ev.title)}" placeholder="Culto de domingo"></label>
      <label>Data<input name="date" type="date" required value="${s ? isoLocal(s) : ''}"></label>
      <div class="colors">
        ${timeField('start', 'Começa', s ? timeValue(s) : '', { required: true })}
        ${timeField('end', 'Termina (opcional)', e ? timeValue(e) : '')}
      </div>
      <label>Local (opcional)<input name="location" maxlength="200" value="${esc(ev.location || '')}" placeholder="Templo principal"></label>
      ${pinField(ev)}
      <label>Descrição (opcional)<textarea name="description" rows="4" maxlength="2000">${esc(ev.description || '')}</textarea></label>
      <label class="check"><input type="checkbox" name="repeat_weekly" ${ev.repeat_weekly ? 'checked' : ''}> Repetir toda semana</label>
      <label id="until-box" ${ev.repeat_weekly ? '' : 'hidden'}>Repetir até (opcional)<input name="repeat_until" type="date" value="${esc(ev.repeat_until || '')}"></label>
      <label>Lembrete por notificação
        <select name="remind_minutes">${REMIND_OPTIONS.map(([m, label]) => `<option value="${m}" ${ev.remind_minutes === m ? 'selected' : ''}>${label}</option>`).join('')}</select>
      </label>
      ${id && ev.repeat_weekly ? '<p class="hint">As mudanças valem para todas as repetições.</p>' : ''}
      ${
        regsOn()
          ? `<fieldset id="reg-fields" ${ev.repeat_weekly ? 'hidden' : ''}>
              <legend>Inscrições</legend>
              <label class="check"><input type="checkbox" name="registration" ${ev.registration ? 'checked' : ''}> Abrir inscrições
                <small class="hint">Para retiros, cursos e conferências. Os membros se inscrevem pelo app.</small></label>
              <div id="reg-options" ${ev.registration ? '' : 'hidden'}>
                <label>Vagas (em branco: sem limite)<input name="capacity" type="number" min="1" max="5000" inputmode="numeric" value="${ev.capacity ?? ''}"></label>
                <div class="colors">
                  <label>Inscrições até (opcional)<input name="reg_date" type="date" value="${ru ? isoLocal(ru) : ''}"></label>
                  ${timeField('reg_time', 'Hora', ru ? timeValue(ru) : '')}
                </div>
                <label class="check"><input type="checkbox" name="waitlist" ${ev.waitlist ? 'checked' : ''}> Lista de espera quando as vagas acabarem
                  <small class="hint">Se alguém cancelar, o primeiro da fila entra sozinho.</small></label>
              </div>
            </fieldset>`
          : ''
      }
      <button class="btn primary big">${id ? 'Salvar' : 'Criar evento'}</button>
    </form>`;

  const form = document.getElementById('event');
  bindTimeFields(form);
  bindPinField(form, { address: () => form.location.value.trim(), near: churchPin() });
  form.repeat_weekly.addEventListener('change', () => {
    document.getElementById('until-box').hidden = !form.repeat_weekly.checked;
    // Inscrição só em evento que não se repete.
    const regBox = document.getElementById('reg-fields');
    if (regBox) regBox.hidden = form.repeat_weekly.checked;
  });
  form.registration?.addEventListener('change', () => (document.getElementById('reg-options').hidden = !form.registration.checked));
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
      ...pinValues(form),
      starts_at: start.toISOString(),
      ends_at: end ? end.toISOString() : null,
      repeat_weekly: weekly,
      repeat_until: until,
      remind_minutes: Number(form.remind_minutes.value),
    };
    if (form.registration) {
      const on = form.registration.checked && !weekly;
      const until = on && form.reg_date.value ? new Date(`${form.reg_date.value}T${form.reg_time.value || '23:59'}`) : null;
      if (until && until > start) return toast('O prazo das inscrições precisa ser antes do início do evento.', 'error');
      Object.assign(row, {
        registration: on,
        capacity: on && form.capacity.value ? Number(form.capacity.value) : null,
        registration_until: until ? until.toISOString() : null,
        waitlist: form.waitlist.checked,
      });
    }
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = id
      ? await sb.from('events').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id).select('id').single()
      : await sb.from('events').insert({ ...row, church_id: state.church.id }).select('id').single();
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    screenForget('agenda');
    screenForget('eventos');
    screenForget('inscricoes');
    toast(id ? 'Evento salvo.' : 'Evento criado.');
    navigate(`/agenda/${data.id}`);
  });
}

async function loadAnnouncements() {
  const { data, error } = await sb
    .from('announcements')
    .select('id, title, body, pinned, visible_until, push, created_at')
    .eq('church_id', state.church.id)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data;
}

async function viewAnnouncements(ctx) {
  if (!requireMemberFeature('/avisos', 'avisos')) return;
  await screenShow(ctx, 'avisos', loadAnnouncements, drawAnnouncements);
}

function drawAnnouncements(all) {
  const leader = isLeaderRole(myRole());
  const today = isoLocal(new Date());
  // O guardado pode ser de outro dia: para os membros, some o que venceu.
  const rows = leader ? all : all.filter((a) => !a.visible_until || a.visible_until >= today);
  $view.innerHTML = `
    <div class="page">
      <h1>Avisos</h1>
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
      ${leader ? fab('#/avisos/novo', 'Novo aviso') : ''}
    </div>`;
  $view.querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = async () => {
      if (!await ask('Excluir este aviso?')) return;
      const { data, error: err } = await sb.from('announcements').delete().eq('id', b.dataset.delete).select('id');
      if (err || !data.length) return toast(err ? errorText(err) : 'Você não tem permissão para excluir.', 'error');
      screenForget('avisos');
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
    const data = await editItem(
      ctx,
      screenCached('avisos')?.find((x) => x.id === id),
      async () => {
        const { data: row, error } = await sb
          .from('announcements')
          .select('id, title, body, pinned, visible_until, push, created_at')
          .eq('id', id)
          .maybeSingle();
        if (error) throw error;
        return row;
      },
      () => screenForget('avisos'),
    );
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
    screenForget('avisos');
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

async function loadPrayerWall() {
  const { data, error } = await sb.rpc('prayer_wall', { p_church: state.church.id });
  if (error) throw error;
  return data;
}

async function viewPrayers(ctx) {
  if (!requireMemberFeature('/oracao', 'oracao')) return;
  await screenShow(ctx, 'mural', loadPrayerWall, drawPrayerWall);
}

function drawPrayerWall(rows) {
  $view.innerHTML = `
    <div class="page">
      <h1>Pedidos de oração</h1>
      ${prayerTabs('/oracao')}
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
      ${fab('#/oracao/novo', 'Fazer um pedido')}
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
      screenForget('mural');
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
    screenForget('meus-pedidos');
    toast(audience === 'igreja' ? 'Pedido enviado. Ele vai para o mural depois da aprovação.' : 'Pedido enviado aos pastores.');
    navigate('/oracao/meus');
  });
}

async function loadMyPrayers() {
  const { data, error } = await sb
    .from('prayer_requests')
    .select('id, body, audience, anonymous, status, moderated_at, answered_at, created_at')
    .eq('church_id', state.church.id)
    .eq('user_id', state.user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data;
}

async function viewMyPrayers(ctx) {
  if (!requireMemberFeature('/oracao/meus', 'oracao')) return;
  await screenShow(ctx, 'meus-pedidos', loadMyPrayers, drawMyPrayers);
}

function drawMyPrayers(rows) {
  $view.innerHTML = `
    <div class="page">
      <h1>Pedidos de oração</h1>
      ${prayerTabs('/oracao/meus')}
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
          : `<div class="empty"><p>Você ainda não fez nenhum pedido. Toque no <strong>+</strong> para fazer o primeiro.</p></div>`
      }
      ${fab('#/oracao/novo', 'Fazer um pedido')}
    </div>`;
  $view.querySelectorAll('[data-answered]').forEach((b) => {
    b.onclick = async () => {
      const { error: err } = await sb.from('prayer_requests').update({ answered_at: new Date().toISOString() }).eq('id', b.dataset.answered);
      if (err) return toast(errorText(err), 'error');
      screenForget('meus-pedidos');
      screenForget('mural');
      toast('Glória a Deus! 🙌');
      render();
    };
  });
  $view.querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = async () => {
      if (!await ask('Apagar este pedido? Ele sai também do mural.')) return;
      const { error: err } = await sb.from('prayer_requests').delete().eq('id', b.dataset.delete);
      if (err) return toast(errorText(err), 'error');
      screenForget('meus-pedidos');
      screenForget('mural');
      toast('Pedido apagado.');
      render();
    };
  });
}

async function viewPrayerModeration(ctx) {
  if (!requireMemberFeature('/oracao/moderar', 'oracao')) return;
  if (!isPastoral()) return navigate('/oracao');
  const tab = ['pendente', 'privado', 'aprovado'].includes(ctx.params.get('ver')) ? ctx.params.get('ver') : 'pendente';
  await screenShow(ctx, `moderar:${tab}`, () => loadModeration(tab), ({ rows, people }) => drawModeration(tab, rows, people));
}

async function loadModeration(tab) {
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
  return { rows, people: people || [] };
}

function drawModeration(tab, rows, people) {
  const nameOf = new Map(people.map((m) => [m.user_id, m.name]));
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
    for (const t of ['pendente', 'privado', 'aprovado']) screenForget(`moderar:${t}`);
    screenForget('mural');
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
    card.querySelector('[data-remove]')?.addEventListener('click', async () => {
      if (!await ask('Tirar este pedido do mural? Quem pediu continua vendo em "Meus pedidos".')) return;
      update(card, { status: 'recusado' }, 'Pedido tirado do mural.');
    });
  });
}

// ---------------------------------------------------------------------
// Visitantes: cadastro rápido pelo QR Code do culto (sem login) e acompanhamento pela liderança
// ---------------------------------------------------------------------
const VISITOR_STATUS = {
  novo: ['Novo', 'wait'],
  contatado: ['Contatado', ''],
  acompanhando: ['Acompanhando', 'role'],
  membro: ['Virou membro', 'ok'],
  sem_interesse: ['Sem interesse', ''],
};
const VISITOR_SOURCES = { amigos: 'Amigos ou família', redes: 'Redes sociais', passando: 'Passando na frente', outro: 'Outro' };
const VISITOR_WHATSAPP_DEFAULT =
  'Olá, {primeiro_nome}! Aqui é da {igreja}. Foi uma alegria ter você com a gente! Se precisar de algo ou quiser conversar, é só responder esta mensagem. 🙏';
const visitorUrl = () => `${PAGE_URL}#/visitante`;
const whatsappLink = (phone, text) => `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
const visitorWhatsapp = (v) =>
  whatsappLink(v.phone, renderMessage(state.church.visitor_whatsapp_text || VISITOR_WHATSAPP_DEFAULT, { name: v.name, church: state.church.name }));

// Formulário público: funciona sem entrar no app.
async function viewVisitorForm() {
  const c = state.church;
  if (!featureOn('visitantes')) {
    $view.innerHTML = `<div class="empty"><h2>Cadastro de visitantes desligado</h2><a class="btn" href="#/">Ir para o início</a></div>`;
    return;
  }
  $view.innerHTML = `
    <form id="visitor" class="form page">
      <section class="church-hero">
        <img src="${esc(c.logo_url || 'icons/icon-192.png')}" alt="" width="72" height="72">
        <h1>Seja bem-vindo!</h1>
        <p>Que bom ter você na ${esc(c.name)}. Deixe o seu contato para a gente te conhecer melhor.</p>
      </section>
      <label>Seu nome<input name="name" required minlength="2" maxlength="120" autocomplete="name"></label>
      <label>WhatsApp<input name="phone" type="tel" inputmode="tel" placeholder="(61) 99999-9999" autocomplete="tel"></label>
      <label>E-mail (opcional)<input name="email" type="email" maxlength="160" autocomplete="email"></label>
      <fieldset>
        <legend>É a sua primeira vez aqui?</legend>
        <label class="check"><input type="radio" name="first_time" value="sim" checked> Sim</label>
        <label class="check"><input type="radio" name="first_time" value="nao"> Não, já vim antes</label>
      </fieldset>
      <label>Como conheceu a igreja?
        <select name="source"><option value="">—</option>${Object.entries(VISITOR_SOURCES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      </label>
      <label class="check"><input type="checkbox" name="wants_contact" checked> Quero que alguém da igreja fale comigo</label>
      <label>Mensagem ou pedido de oração (opcional)<textarea name="message" rows="3" maxlength="1000"></textarea></label>
      <label class="hp" aria-hidden="true">Site<input name="website" tabindex="-1" autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="consent" required> Autorizo a ${esc(c.name)} a guardar estes dados para entrar em contato comigo.
        <small class="hint">Só a liderança da igreja vê. Se você não virar membro, os dados são apagados em 12 meses. <a href="#/privacidade">Privacidade</a></small></label>
      <button class="btn primary big">Enviar</button>
    </form>`;
  const form = document.getElementById('visitor');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawPhone = form.phone.value.trim();
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) return toast('Confira o WhatsApp: com DDD, como (61) 99999-9999.', 'error');
    const email = form.email.value.trim();
    if (email && !EMAIL_RE.test(email)) return toast('Confira o e-mail.', 'error');
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { error } = await sb.rpc('register_visitor', {
      p_church: c.id,
      p_name: form.name.value.trim(),
      p_phone: phone,
      p_email: email || null,
      p_first_time: form.first_time.value === 'sim',
      p_source: form.source.value || null,
      p_wants_contact: form.wants_contact.checked,
      p_message: form.message.value.trim() || null,
      p_consent: form.consent.checked,
      p_website: form.website.value,
    });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    window.scrollTo(0, 0);
    $view.innerHTML = `
      <div class="page">
        <section class="church-hero">
          <img src="${esc(c.logo_url || 'icons/icon-192.png')}" alt="" width="72" height="72">
          <h1>Obrigado, ${esc(firstName(form.name.value))}!</h1>
          <p>${esc(c.welcome_text || `É uma alegria ter você na ${c.name}.`)}</p>
        </section>
        ${form.wants_contact.checked ? '<p class="center">Em breve alguém da igreja vai falar com você.</p>' : ''}
        ${aboutCard(c)}
      </div>`;
    mountPlaceMaps($view).catch(() => {});
  });
}

async function loadVisitors() {
  const { data, error } = await sb
    .from('visitors')
    .select('id, name, phone, email, first_time, source, wants_contact, message, status, notes, member_id, created_at')
    .eq('church_id', state.church.id)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  return data;
}

function requireVisitorsTeam(next) {
  if (!requireMemberFeature(next, 'visitantes')) return false;
  if (visitorTeam()) return true;
  navigate('/');
  return false;
}

async function viewVisitors(ctx) {
  if (!requireVisitorsTeam('/visitantes')) return;
  const filter = Object.keys(VISITOR_STATUS).includes(ctx.params.get('ver')) ? ctx.params.get('ver') : null;
  await screenShow(ctx, 'visitantes', loadVisitors, (all) => {
    const rows = filter ? all.filter((v) => v.status === filter) : all.filter((v) => !['membro', 'sem_interesse'].includes(v.status));
    const count = (s) => all.filter((v) => v.status === s).length;
    $view.innerHTML = `
      <div class="page">
        <h1>Visitantes</h1>
        <div class="chips filters">
          <a class="chip ${filter ? '' : 'active'}" href="#/visitantes">Em andamento</a>
          ${Object.entries(VISITOR_STATUS)
            .map(([k, [label]]) => `<a class="chip ${filter === k ? 'active' : ''}" href="#/visitantes?ver=${k}">${label}${count(k) ? ` (${count(k)})` : ''}</a>`)
            .join('')}
        </div>
        ${
          rows.length
            ? `<div class="list">${rows
                .map((v) => {
                  const [label, cls] = VISITOR_STATUS[v.status];
                  return `
              <a class="member-row" href="#/visitantes/${v.id}">
                ${avatar(v.name, null)}
                <span><strong>${esc(v.name)}</strong>
                  <small>${esc(fmtDayMonth(v.created_at))}${v.first_time ? ' · primeira vez' : ''}${v.wants_contact ? ' · quer contato' : ''}</small></span>
                <span class="tags"><span class="tag ${cls}">${label}</span></span>
              </a>`;
                })
                .join('')}</div>`
            : `<div class="empty"><p>${filter ? 'Ninguém nesta situação.' : 'Nenhum visitante em andamento. Mostre o QR Code no culto!'}</p></div>`
        }
        <p class="hint">Quem não virou membro é apagado sozinho 12 meses depois do cadastro.</p>
        <a class="fab" href="#/visitantes/qr" aria-label="QR Code para o culto" title="QR Code para o culto">${icon.qr}</a>
      </div>`;
  });
}

async function viewVisitor(ctx, id) {
  if (!requireVisitorsTeam(`/visitantes/${id}`)) return;
  await screenShow(ctx, 'visitantes', loadVisitors, (all) => drawVisitor(all.find((v) => v.id === id)));
}

function drawVisitor(v) {
  if (!v) {
    $view.innerHTML = `<div class="empty"><h2>Visitante não encontrado</h2><a class="btn" href="#/visitantes">Voltar</a></div>`;
    return;
  }
  $view.innerHTML = `
    <form id="visit" class="form page">
      <a href="#/visitantes" class="back">← Visitantes</a>
      <h1>${esc(v.name)}</h1>
      <p class="hint">Cadastro em ${esc(new Date(v.created_at).toLocaleDateString('pt-BR'))}${v.first_time ? ' · primeira vez' : ' · já tinha vindo antes'}${v.source ? ` · ${esc(VISITOR_SOURCES[v.source])}` : ''}</p>
      <p>${v.wants_contact ? '✅ Quer que alguém da igreja fale com ele.' : 'Não pediu contato.'}</p>
      ${v.phone ? `<p class="meta">📱 <a href="tel:+${esc(v.phone)}">${esc(fmtPhone(v.phone))}</a></p>` : ''}
      ${v.email ? `<p class="meta">✉️ <a href="mailto:${esc(v.email)}">${esc(v.email)}</a></p>` : ''}
      ${v.message ? `<div class="card"><h2>Mensagem</h2><p class="pre">${esc(v.message)}</p></div>` : ''}
      ${v.phone ? `<a class="btn primary" href="${esc(visitorWhatsapp(v))}" target="_blank" rel="noopener">Chamar no WhatsApp</a>` : ''}
      <label>Situação
        <select name="status">${Object.entries(VISITOR_STATUS)
          .map(([k, [label]]) => `<option value="${k}" ${v.status === k ? 'selected' : ''} ${k === 'membro' && !v.member_id ? 'disabled' : ''}>${label}</option>`)
          .join('')}</select>
      </label>
      <label>Anotações do acompanhamento<textarea name="notes" rows="4" maxlength="4000" placeholder="Ex.: liguei dia 10, vem no domingo">${esc(v.notes || '')}</textarea></label>
      <button class="btn primary big">Salvar</button>
      ${
        !isLeaderRole(myRole())
          ? '<p class="hint">Cadastrar como membro e apagar o cadastro: com a liderança da igreja.</p>'
          : v.member_id
            ? `<a class="btn" href="#/membros/${v.member_id}">Ver o cadastro de membro</a>`
            : '<button class="btn" type="button" id="to-member">Cadastrar como membro</button>'
      }
      ${isLeaderRole(myRole()) ? '<button class="btn danger-outline" type="button" id="delete">Apagar este visitante</button>' : ''}
    </form>`;
  const form = document.getElementById('visit');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = await sb
      .from('visitors')
      .update({ status: form.status.value, notes: form.notes.value.trim() || null, updated_at: new Date().toISOString() })
      .eq('id', v.id)
      .select('id');
    btn.disabled = false;
    if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para isso.', 'error');
    screenForget('visitantes');
    toast('Salvo.');
    navigate('/visitantes');
  });
  document.getElementById('to-member')?.addEventListener('click', async () => {
    if (!await ask(`Cadastrar ${v.name} como membro da igreja? O nome, o WhatsApp e o e-mail vão para o cadastro de membros.`)) return;
    const { data: memberId, error } = await sb.rpc('visitor_to_member', { p_visitor: v.id });
    if (error) return toast(errorText(error), 'error');
    screenForget('visitantes');
    forgetMembers();
    toast('Cadastrado como membro. Confira os dados na ficha.');
    navigate(`/membros/${memberId}`);
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask(`Apagar o cadastro de ${v.name}? Não dá para desfazer.`)) return;
    const { data, error } = await sb.from('visitors').delete().eq('id', v.id).select('id');
    if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para isso.', 'error');
    screenForget('visitantes');
    toast('Visitante apagado.');
    navigate('/visitantes');
  });
}

// QR Code para projetar no telão ou imprimir, e a mensagem pronta do WhatsApp.
async function viewVisitorQr() {
  if (!requireVisitorsTeam('/visitantes/qr')) return;
  const url = visitorUrl();
  const c = state.church;
  $view.innerHTML = `
    <div class="page visitor-qr">
      <a href="#/visitantes" class="back no-print">← Visitantes</a>
      <h1>Visitou a ${esc(c.name)}?</h1>
      <p class="center">Aponte a câmera do celular e deixe o seu contato.</p>
      <div class="qr" id="visitor-qr"><p class="hint center">Gerando o QR Code…</p></div>
      <div class="copy-row no-print"><code>${esc(url)}</code><button class="btn small" type="button" id="copy">Copiar</button></div>
      <div class="actions-row no-print">
        <button class="btn" id="print">${icon.print} Imprimir</button>
        <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Abrir o cadastro</a>
      </div>
      <form id="wa" class="form card no-print">
              <h2>Mensagem pronta do WhatsApp</h2>
              <label>Mensagem<textarea name="text" rows="4" maxlength="500">${esc(c.visitor_whatsapp_text || VISITOR_WHATSAPP_DEFAULT)}</textarea></label>
              <p class="hint">Use {primeiro_nome}, {nome} e {igreja}. Ela já vem escrita ao tocar em "Chamar no WhatsApp".</p>
              ${myRole() === 'admin' ? '<button class="btn primary">Salvar mensagem</button>' : '<p class="hint">Só o administrador muda o texto.</p>'}
      </form>
    </div>`;
  qrSvg(url)
    .then((svg) => {
      const box = document.getElementById('visitor-qr');
      if (box) box.innerHTML = svg;
    })
    .catch(() => {});
  document.getElementById('print').onclick = () => window.print();
  document.getElementById('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Endereço copiado.');
    } catch {
      toast('Não deu para copiar. Selecione o endereço e copie.', 'error');
    }
  };
  const wa = document.getElementById('wa');
  wa?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = wa.text.value.trim() || null;
    const { data, error } = await sb.from('churches').update({ visitor_whatsapp_text: text }).eq('id', c.id).select().single();
    if (error) return toast(errorText(error), 'error');
    state.church = data;
    saveBootCache();
    toast('Mensagem salva.');
  });
}

// ---------------------------------------------------------------------
// Devocional do dia (o pastor e os líderes escrevem) e planos de leitura da Bíblia
// ---------------------------------------------------------------------
const DEVOTIONAL_MAX = 6000;
const bibleVersion = () => state.church?.bible_version || 'NVI';
const devotionalImage = (path) => (path ? sb.storage.from('igrejas').getPublicUrl(path).data.publicUrl : null);
const fmtLongDay = (iso) => parseIso(iso).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const daysFrom = (fromIso, toIso) => Math.round((parseIso(toIso) - parseIso(fromIso)) / 864e5);
const externalLink = (href, label) => `<a class="btn small" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;

// Botão "Ler na Bíblia" do versículo-base.
function verseLink(d) {
  if (!d.verse_book) return '';
  const verse = d.verse_from ? `${d.verse_from}${d.verse_to && d.verse_to !== d.verse_from ? `-${d.verse_to}` : ''}` : '';
  return externalLink(bibleUrl(bibleVersion(), d.verse_book, d.verse_chapter, verse), `${icon.book} Ler na Bíblia`);
}

function devotionalTabs(active) {
  const tabs = [
    ['/devocional', 'Devocional'],
    ['/leitura', 'Plano de leitura'],
  ];
  return `<div class="chips filters">${tabs
    .map(([href, label]) => `<a class="chip ${href === active ? 'active' : ''}" href="#${href}">${label}</a>`)
    .join('')}</div>`;
}

async function loadDevotionals() {
  const { data, error } = await sb.rpc('devotional_list', { p_church: state.church.id });
  if (error) throw error;
  return data;
}

async function loadDevotional(id) {
  const { data, error } = await sb.rpc('devotional_list', { p_church: state.church.id, p_id: id });
  if (error) throw error;
  return data[0] ?? null;
}

async function viewDevotionals(ctx) {
  if (!requireMemberFeature('/devocional', 'devocional')) return;
  await screenShow(ctx, 'devocionais', loadDevotionals, drawDevotionals);
}

function drawDevotionals(all) {
  const today = isoLocal(new Date());
  const pastor = isPastoral();
  // O guardado pode ser de ontem: para os membros, só o que já chegou ao dia.
  const past = all.filter((d) => d.publish_date <= today);
  const scheduled = pastor ? all.filter((d) => d.publish_date > today).reverse() : [];
  const current = past[0]?.publish_date === today ? past[0] : null;
  const older = current ? past.slice(1) : past;
  const row = (d, note) => `
    <a class="event-card" href="#/devocional/${d.id}">
      <span><strong>${esc(d.title)}</strong><small>${esc(note)}${d.verse_book ? ` · ${esc(verseRef(d))}` : ''}</small></span>${icon.chevron}
    </a>`;
  $view.innerHTML = `
    <div class="page">
      <h1>Devocional</h1>
      ${devotionalTabs('/devocional')}
      ${
        current
          ? `<a class="card devotional-today" href="#/devocional/${current.id}">
              <span class="tag role">Hoje</span>
              <h2>${esc(current.title)}</h2>
              ${current.verse_book ? `<p class="verse-ref">${esc(verseRef(current))}</p>` : ''}
              <p class="pre clamp">${esc(current.body)}</p>
              <span class="link-like">Ler o devocional</span>
            </a>`
          : `<div class="empty"><p>Nenhum devocional para hoje${older.length ? '. Os anteriores estão abaixo.' : '.'}</p></div>`
      }
      ${
        scheduled.length
          ? `<section class="card"><h2>${icon.clock} Agendados</h2><p class="hint">Só o pastor e os líderes veem antes do dia.</p>
              <div class="list">${scheduled.map((d) => row(d, `Para ${fmtDate(d.publish_date)}`)).join('')}</div></section>`
          : ''
      }
      ${older.length ? `<section class="card"><h2>Anteriores</h2><div class="list">${older.map((d) => row(d, fmtDayMonth(`${d.publish_date}T12:00`))).join('')}</div></section>` : ''}
      ${pastor ? fab('#/devocional/novo', 'Novo devocional') : ''}
    </div>`;
}

async function viewDevotional(ctx, id) {
  if (!requireMemberFeature(`/devocional/${id}`, 'devocional')) return;
  const name = `devocional:${id}`;
  // Abre na hora com o que veio na lista; o banco só redesenha se algo mudou.
  const fromList = screenCached('devocionais')?.find((d) => d.id === id);
  if (fromList && !screenCached(name)) screenUpdate(name, fromList);
  await screenShow(ctx, name, () => loadDevotional(id), drawDevotional);
}

function drawDevotional(d) {
  if (!d) {
    $view.innerHTML = `<div class="empty"><h2>Devocional não encontrado</h2><a class="btn" href="#/devocional">Voltar</a></div>`;
    return;
  }
  const today = isoLocal(new Date());
  const published = d.publish_date <= today;
  const amenText = (on, n) => `🙏 Amém${n ? ` · ${n}` : ''}`;
  const img = devotionalImage(d.image_path);
  $view.innerHTML = `
    <article class="page devotional">
      <a href="#/devocional" class="back">← Devocional</a>
      ${img ? `<img class="devotional-img" src="${esc(img)}" alt="">` : ''}
      <p class="hint">${published ? '' : '<span class="tag wait">Agendado</span> '}${esc(fmtLongDay(d.publish_date))}</p>
      <h1>${esc(d.title)}</h1>
      ${
        d.verse_book
          ? `<blockquote class="verse">
              ${d.verse_text ? `<p class="pre">${esc(d.verse_text)}</p>` : ''}
              <cite>${esc(verseRef(d))}</cite>
            </blockquote>
            <div class="actions-row">${verseLink(d)}</div>`
          : ''
      }
      <p class="pre devotional-body">${esc(d.body)}</p>
      <div class="actions-row">
        ${published ? `<button class="btn ${d.i_amen ? 'primary' : ''}" id="amen" aria-pressed="${d.i_amen}">${amenText(d.i_amen, d.amens)}</button>` : ''}
        ${
          isPastoral()
            ? `<a class="btn" href="#/devocional/${d.id}/editar">Editar</a><button class="btn danger-outline" id="delete">Excluir</button>`
            : ''
        }
      </div>
      ${isPastoral() && published ? `<p class="hint">Ninguém vê quem tocou em Amém, só o total.</p>` : ''}
    </article>`;
  const amen = document.getElementById('amen');
  if (amen)
    amen.onclick = async () => {
      amen.disabled = true;
      const { data, error } = await sb.rpc('devotional_amen', { p_devotional: d.id });
      amen.disabled = false;
      if (error) return toast(errorText(error), 'error');
      const { amens, i_amen: on } = data[0];
      amen.classList.toggle('primary', on);
      amen.setAttribute('aria-pressed', String(on));
      amen.textContent = amenText(on, amens);
      Object.assign(d, { amens, i_amen: on });
      screenUpdate(`devocional:${d.id}`, d);
      screenForget('devocionais');
    };
  const del = document.getElementById('delete');
  if (del)
    del.onclick = async () => {
      if (!await ask('Excluir este devocional?')) return;
      const { data, error } = await sb.from('devotionals').delete().eq('id', d.id).select('id');
      if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para excluir.', 'error');
      if (d.image_path) await sb.storage.from('igrejas').remove([d.image_path]);
      screenForget(`devocional:${d.id}`);
      screenForget('devocionais');
      toast('Devocional excluído.');
      navigate('/devocional');
    };
}

async function viewDevotionalForm(ctx, id) {
  if (!requireMemberFeature(id ? `/devocional/${id}/editar` : '/devocional/novo', 'devocional')) return;
  if (!isPastoral()) return navigate('/devocional');
  const list = screenCached('devocionais') || [];
  let d = { title: '', body: '', publish_date: '', verse_book: '', verse_chapter: null, verse_from: null, verse_to: null, verse_text: '', image_path: null, push: true };
  if (id) {
    const data = await editItem(ctx, list.find((x) => x.id === id), () => loadDevotional(id), () => screenForget('devocionais'));
    if (!data) return navigate('/devocional');
    d = data;
  } else {
    // Sugere o primeiro dia sem devocional, a partir de hoje.
    const taken = new Set(list.map((x) => x.publish_date));
    let day = new Date();
    while (taken.has(isoLocal(day))) day = addDays(day, 1);
    d.publish_date = isoLocal(day);
  }
  if (!ctx.alive()) return;
  const img = devotionalImage(d.image_path);
  $view.innerHTML = `
    <form id="devotional" class="form page">
      <a href="${id ? `#/devocional/${id}` : '#/devocional'}" class="back">← Devocional</a>
      <h1>${id ? 'Editar devocional' : 'Novo devocional'}</h1>
      <label>Dia em que aparece<input name="publish_date" type="date" required value="${esc(d.publish_date)}">
        <small class="hint">Um devocional por dia. Os membros só veem a partir desse dia.</small></label>
      <label>Título<input name="title" required minlength="3" maxlength="120" value="${esc(d.title)}"></label>
      <fieldset class="card">
        <legend>Versículo-base (opcional)</legend>
        <div class="verse-pick">
          <label>Livro
            <select name="verse_book">
              <option value="">—</option>
              ${BOOKS.map(([code, name]) => `<option value="${code}" ${code === d.verse_book ? 'selected' : ''}>${esc(name)}</option>`).join('')}
            </select>
          </label>
          <label>Capítulo<input name="verse_chapter" type="number" inputmode="numeric" min="1" max="150" value="${esc(d.verse_chapter ?? '')}"></label>
          <label>Do versículo<input name="verse_from" type="number" inputmode="numeric" min="1" max="176" value="${esc(d.verse_from ?? '')}"></label>
          <label>Até<input name="verse_to" type="number" inputmode="numeric" min="1" max="176" value="${esc(d.verse_to ?? '')}"></label>
        </div>
        <label>Texto do versículo<textarea name="verse_text" rows="3" maxlength="1000" placeholder="Copie aqui o texto, se quiser que apareça no devocional">${esc(d.verse_text || '')}</textarea>
          <small class="hint">O botão <em>Ler na Bíblia</em> abre o trecho na YouVersion, na tradução da igreja (${esc(BIBLE_VERSIONS[bibleVersion()][0])}).</small></label>
      </fieldset>
      <label>Mensagem<textarea name="body" required rows="10" maxlength="${DEVOTIONAL_MAX}">${esc(d.body)}</textarea>
        <small class="hint" id="count">${d.body.length} de ${DEVOTIONAL_MAX} letras</small></label>
      <fieldset class="card">
        <legend>Imagem (opcional)</legend>
        <div class="bday-image" id="image-box">${img ? `<img src="${esc(img)}" alt="">` : '<p class="hint">Sem imagem.</p>'}</div>
        <div class="actions-row">
          <label class="btn small">${img ? 'Trocar a imagem' : 'Escolher imagem'}<input type="file" name="image" accept="image/*" hidden></label>
          <button type="button" class="btn link small" id="image-remove" ${img ? '' : 'hidden'}>Remover imagem</button>
        </div>
      </fieldset>
      <label class="check"><input type="checkbox" name="push" ${d.push ? 'checked' : ''}> Avisar os membros às 7h do dia
        <small class="hint">Vai para a central de notificações de todos e para o celular de quem ativou as notificações.</small></label>
      <button class="btn primary big">${id ? 'Salvar' : 'Publicar devocional'}</button>
    </form>`;
  const form = document.getElementById('devotional');
  const count = document.getElementById('count');
  form.body.addEventListener('input', () => (count.textContent = `${form.body.value.length} de ${DEVOTIONAL_MAX} letras`));
  let imageFile = null;
  let removeImage = false;
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
    const num = (name) => (form[name].value ? Number(form[name].value) : null);
    const book = form.verse_book.value || null;
    const row = {
      publish_date: form.publish_date.value,
      title: form.title.value.trim(),
      verse_book: book,
      verse_chapter: book ? num('verse_chapter') : null,
      verse_from: book ? num('verse_from') : null,
      verse_to: book ? num('verse_to') : null,
      verse_text: book ? form.verse_text.value.trim() || null : null,
      body: form.body.value.trim(),
      push: form.push.checked,
    };
    if (book && !row.verse_chapter) return toast('Escolha o capítulo do versículo.', 'error');
    if (book && row.verse_chapter > bookChapters(book)) return toast(`${bookName(book)} tem ${bookChapters(book)} capítulos.`, 'error');
    if (row.verse_to && !row.verse_from) return toast('Preencha também o primeiro versículo.', 'error');
    if (row.verse_to && row.verse_to < row.verse_from) return toast('O último versículo vem depois do primeiro.', 'error');
    btn.disabled = true;
    try {
      const bucket = sb.storage.from('igrejas');
      if (imageFile) {
        const img = await resizeImage(imageFile, 1080, 0.82);
        const path = `${state.church.id}/devocionais/${Date.now()}.${img.type === 'image/webp' ? 'webp' : 'jpg'}`;
        const up = await bucket.upload(path, img, { contentType: img.type, cacheControl: '31536000' });
        if (up.error) throw up.error;
        row.image_path = path;
      } else if (removeImage) row.image_path = null;
      const { data, error } = id
        ? await sb.from('devotionals').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id).select('id').single()
        : await sb.from('devotionals').insert({ ...row, church_id: state.church.id }).select('id').single();
      if (error) {
        if (row.image_path) await bucket.remove([row.image_path]);
        throw /duplicate key/i.test(error.message) ? new Error(`Já existe um devocional para ${fmtDate(row.publish_date)}. Escolha outro dia.`) : error;
      }
      // A imagem antiga não é mais usada.
      if ((imageFile || removeImage) && d.image_path) await bucket.remove([d.image_path]);
      screenForget('devocionais');
      screenForget(`devocional:${data.id}`);
      toast(id ? 'Devocional salvo.' : row.publish_date > isoLocal(new Date()) ? `Devocional agendado para ${fmtDate(row.publish_date)}.` : 'Devocional publicado.');
      navigate(`/devocional/${data.id}`);
    } catch (err) {
      toast(errorText(err), 'error');
      btn.disabled = false;
    }
  });
}

// Planos de leitura: os da igreja, os que eu entrei, os dias que eu li e os números de cada plano.
async function loadReading() {
  const [plans, mine, progress, stats] = await Promise.all([
    sb.from('reading_plans').select('id, plan_key, start_date, active').eq('church_id', state.church.id).order('start_date', { ascending: false }),
    sb.from('reading_plan_members').select('plan_id, remind'),
    sb.from('reading_progress').select('plan_id, day'),
    sb.rpc('reading_plan_stats', { p_church: state.church.id }),
  ]);
  for (const r of [plans, mine, progress, stats]) if (r.error) throw r.error;
  const ids = new Set(plans.data.map((p) => p.id));
  const done = {};
  for (const r of progress.data) if (ids.has(r.plan_id)) (done[r.plan_id] ||= []).push(r.day);
  for (const k of Object.keys(done)) done[k].sort((a, b) => a - b);
  return {
    plans: plans.data,
    mine: Object.fromEntries(mine.data.filter((m) => ids.has(m.plan_id)).map((m) => [m.plan_id, { remind: m.remind }])),
    done,
    stats: Object.fromEntries(stats.data.map((s) => [s.plan_id, s])),
  };
}

// Situação de um plano hoje: o dia de hoje (0 antes de começar; maior que o total depois de terminar).
function planStatus(p, data) {
  const meta = READING_PLANS[p.plan_key];
  const today = daysFrom(p.start_date, isoLocal(new Date())) + 1;
  const done = new Set(data.done[p.id] || []);
  const upTo = Math.min(today, meta.days);
  const late = [];
  for (let day = 1; day < upTo; day++) if (!done.has(day)) late.push(day);
  return { meta, today, done, late, joined: !!data.mine[p.id], finished: today > meta.days };
}
const planDate = (p, day) => isoLocal(addDays(parseIso(p.start_date), day - 1));

function planWhen(p, s) {
  if (s.today < 1) return `Começa em ${fmtDate(p.start_date)}`;
  if (s.finished) return `Terminou em ${fmtDate(planDate(p, s.meta.days))}`;
  return `Dia ${s.today} de ${s.meta.days}`;
}

// Um dia do plano: os trechos (cada um abre na Bíblia) e o botão "Li".
function readingDay(p, day, done, title = `Dia ${day}`) {
  const parts = planReading(p.plan_key, day);
  return `
    <div class="reading-day ${done ? 'done' : ''}">
      <button type="button" class="reading-check" data-plan="${p.id}" data-day="${day}" aria-pressed="${done}"
        aria-label="${done ? `Desmarcar o dia ${day}` : `Marcar o dia ${day} como lido`}">${done ? '✓' : ''}</button>
      <span><strong>${esc(title)}</strong> <small class="hint">${esc(fmtDayMonth(`${planDate(p, day)}T12:00`))}</small>
        <span class="passages">${parts
          .map((x) => `<a href="${esc(bibleUrl(bibleVersion(), x.book, x.from))}" target="_blank" rel="noopener">${esc(passageLabel(x))}</a>`)
          .join('')}</span></span>
    </div>`;
}

function progressBar(doneCount, total) {
  const pct = Math.round((100 * doneCount) / total);
  return `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${doneCount}" aria-label="Progresso">
      <span style="width:${pct}%"></span></div>
    <p class="hint">${doneCount} de ${total} dias lidos (${pct}%)</p>`;
}

// Marca ou desmarca um dia. Quem ainda não está no plano entra nele ao marcar o primeiro dia.
async function toggleReadingDay(data, planId, day) {
  const done = new Set(data.done[planId] || []);
  if (done.has(day)) {
    const { error } = await sb.from('reading_progress').delete().eq('plan_id', planId).eq('user_id', state.user.id).eq('day', day);
    if (error) throw error;
    done.delete(day);
  } else {
    if (!data.mine[planId]) await joinReadingPlan(data, planId);
    const { error } = await sb.from('reading_progress').insert({ plan_id: planId, day });
    if (error && !/duplicate key/i.test(error.message)) throw error;
    done.add(day);
  }
  data.done[planId] = [...done].sort((a, b) => a - b);
  screenUpdate('leitura', data);
}

async function joinReadingPlan(data, planId) {
  const { error } = await sb.from('reading_plan_members').insert({ plan_id: planId });
  if (error && !/duplicate key/i.test(error.message)) throw error;
  data.mine[planId] = { remind: true };
  const st = (data.stats[planId] ||= { plan_id: planId, readers: 0, avg_percent: null });
  st.readers += 1;
  screenUpdate('leitura', data);
}

// Liga os botões "Li" e "Entrar no plano" da tela; depois de cada um, desenha de novo.
function bindReading(data, redraw) {
  $view.querySelectorAll('.reading-check').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await toggleReadingDay(data, b.dataset.plan, Number(b.dataset.day));
        redraw(data);
      } catch (err) {
        toast(errorText(err), 'error');
        b.disabled = false;
      }
    };
  });
  $view.querySelectorAll('[data-join]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await joinReadingPlan(data, b.dataset.join);
        toast('Você entrou no plano. Boa leitura!');
        redraw(data);
      } catch (err) {
        toast(errorText(err), 'error');
        b.disabled = false;
      }
    };
  });
}

async function viewReading(ctx) {
  if (!requireMemberFeature('/leitura', 'devocional')) return;
  await screenShow(ctx, 'leitura', loadReading, drawReading);
}

function drawReading(data) {
  const leader = isLeaderRole(myRole());
  const plans = data.plans.filter((p) => p.active || leader);
  $view.innerHTML = `
    <div class="page">
      <h1>Plano de leitura</h1>
      ${devotionalTabs('/leitura')}
      ${
        plans.length
          ? plans
              .map((p) => {
                const s = planStatus(p, data);
                const st = data.stats[p.id];
                const readers = st?.readers ? `${st.readers} ${st.readers === 1 ? 'pessoa lendo' : 'pessoas lendo'}` : 'Ninguém entrou ainda';
                return `
            <section class="card reading-plan">
              <div class="tags-row">
                ${p.active ? '' : '<span class="tag">Encerrado (só a liderança vê)</span>'}
                ${s.joined ? '<span class="tag ok">Você está lendo</span>' : ''}
              </div>
              <h2>${icon.book} ${esc(s.meta.title)}</h2>
              <p class="hint">${esc(planWhen(p, s))} · ${esc(readers)}${leader && st?.avg_percent != null ? ` · progresso médio ${st.avg_percent}%` : ''}</p>
              ${
                s.joined
                  ? `${progressBar(s.done.size, s.meta.days)}
                     ${s.today >= 1 && !s.finished ? readingDay(p, s.today, s.done.has(s.today), 'Leitura de hoje') : ''}
                     ${s.late.length ? `<p class="late">${s.late.length === 1 ? '1 leitura atrasada' : `${s.late.length} leituras atrasadas`}</p>` : ''}`
                  : `<p>${esc(s.meta.about)}</p>${p.active ? `<button class="btn primary" data-join="${p.id}">Entrar no plano</button>` : ''}`
              }
              <a href="#/leitura/${p.id}">${s.joined ? 'Abrir o plano' : 'Ver as leituras'}</a>
            </section>`;
              })
              .join('')
          : `<div class="empty"><p>A igreja ainda não escolheu um plano de leitura.${leader ? ' Toque no <strong>+</strong> para começar.' : ''}</p></div>`
      }
      ${leader ? fab('#/leitura/novo', 'Novo plano') : ''}
    </div>`;
  bindReading(data, drawReading);
}

async function viewReadingPlan(ctx, id) {
  if (!requireMemberFeature(`/leitura/${id}`, 'devocional')) return;
  await screenShow(ctx, 'leitura', loadReading, (data) => drawReadingPlan(data, id));
}

function drawReadingPlan(data, id) {
  const p = data.plans.find((x) => x.id === id);
  const leader = isLeaderRole(myRole());
  if (!p || (!p.active && !leader)) {
    $view.innerHTML = `<div class="empty"><h2>Plano não encontrado</h2><a class="btn" href="#/leitura">Voltar</a></div>`;
    return;
  }
  const s = planStatus(p, data);
  const st = data.stats[p.id];
  const all = Array.from({ length: s.meta.days }, (_, i) => i + 1);
  $view.innerHTML = `
    <div class="page">
      <a href="#/leitura" class="back">← Plano de leitura</a>
      <h1>${esc(s.meta.title)}</h1>
      <p class="hint">${esc(planWhen(p, s))} · começou em ${esc(fmtDate(p.start_date))}${st?.readers ? ` · ${st.readers} ${st.readers === 1 ? 'pessoa lendo' : 'pessoas lendo'}` : ''}</p>
      ${
        s.joined
          ? progressBar(s.done.size, s.meta.days)
          : `<p>${esc(s.meta.about)}</p>${p.active ? `<div class="actions-row"><button class="btn primary" data-join="${p.id}">Entrar no plano</button></div>` : ''}`
      }
      ${s.today >= 1 && !s.finished ? `<section class="card">${readingDay(p, s.today, s.done.has(s.today), 'Leitura de hoje')}</section>` : ''}
      ${
        s.late.length
          ? `<section class="card"><h2>Para pôr em dia</h2>
              <div class="list">${s.late.slice(0, 30).map((day) => readingDay(p, day, false)).join('')}</div>
              ${s.late.length > 30 ? `<p class="hint">E mais ${s.late.length - 30} em <em>Todos os dias</em>.</p>` : ''}</section>`
          : ''
      }
      <details class="card">
        <summary>Todos os dias</summary>
        <div class="list">${all.map((day) => readingDay(p, day, s.done.has(day))).join('')}</div>
      </details>
      <p class="hint">Os links abrem a leitura na YouVersion (${esc(BIBLE_VERSIONS[bibleVersion()][0])}). Ninguém vê o seu progresso: a liderança vê só o total de pessoas e a média.</p>
      ${
        s.joined
          ? `<section class="card">
              <h2>Minha participação</h2>
              <label class="check"><input type="checkbox" id="remind" ${data.mine[p.id].remind ? 'checked' : ''}> Lembrete às 7h, se eu ainda não tiver lido</label>
              <button class="btn danger-outline small" id="leave-plan">Sair do plano</button>
            </section>`
          : ''
      }
      ${
        leader
          ? `<form class="card form" id="plan-admin">
              <h2>Liderança</h2>
              ${st?.avg_percent != null ? `<p>Progresso médio de quem está lendo: <strong>${st.avg_percent}%</strong>.</p>` : ''}
              <label>Data de início<input type="date" name="start_date" required value="${esc(p.start_date)}"></label>
              <label class="check"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Plano ativo
                <small class="hint">Desmarque para encerrar: o plano some para os membros e os lembretes param.</small></label>
              <div class="actions-row"><button class="btn primary">Salvar</button><button type="button" class="btn danger-outline" id="delete-plan">Excluir o plano</button></div>
            </form>`
          : ''
      }
    </div>`;
  const redraw = (d) => drawReadingPlan(d, id);
  bindReading(data, redraw);
  const remind = document.getElementById('remind');
  remind?.addEventListener('change', async () => {
    const { error } = await sb.from('reading_plan_members').update({ remind: remind.checked }).eq('plan_id', p.id).eq('user_id', state.user.id);
    if (error) {
      remind.checked = !remind.checked;
      return toast(errorText(error), 'error');
    }
    data.mine[p.id].remind = remind.checked;
    screenUpdate('leitura', data);
    toast(remind.checked ? 'Lembrete ligado.' : 'Lembrete desligado.');
  });
  document.getElementById('leave-plan')?.addEventListener('click', async () => {
    if (!await ask('Sair do plano? Os dias que você marcou como lidos serão apagados.')) return;
    const { error } = await sb.from('reading_plan_members').delete().eq('plan_id', p.id).eq('user_id', state.user.id);
    if (error) return toast(errorText(error), 'error');
    screenForget('leitura');
    toast('Você saiu do plano.');
    navigate('/leitura');
  });
  const admin = document.getElementById('plan-admin');
  admin?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { data: rows, error } = await sb
      .from('reading_plans')
      .update({ start_date: admin.start_date.value, active: admin.active.checked })
      .eq('id', p.id)
      .select('id');
    if (error || !rows.length) return toast(error ? errorText(error) : 'Você não tem permissão para mudar o plano.', 'error');
    screenForget('leitura');
    toast('Plano salvo.');
    render();
  });
  document.getElementById('delete-plan')?.addEventListener('click', async () => {
    if (!await ask('Excluir o plano? O progresso de todos que estão lendo será apagado.')) return;
    const { data: rows, error } = await sb.from('reading_plans').delete().eq('id', p.id).select('id');
    if (error || !rows.length) return toast(error ? errorText(error) : 'Você não tem permissão para excluir.', 'error');
    screenForget('leitura');
    toast('Plano excluído.');
    navigate('/leitura');
  });
}

async function viewReadingForm() {
  if (!requireMemberFeature('/leitura/novo', 'devocional')) return;
  if (!isLeaderRole(myRole())) return navigate('/leitura');
  $view.innerHTML = `
    <form id="plan" class="form page">
      <a href="#/leitura" class="back">← Plano de leitura</a>
      <h1>Novo plano de leitura</h1>
      <fieldset>
        <legend>Plano</legend>
        ${Object.entries(READING_PLANS)
          .map(
            ([key, p], i) => `
          <label class="check"><input type="radio" name="plan_key" value="${key}" ${i === 0 ? 'checked' : ''}> ${esc(p.title)}
            <small class="hint">${esc(p.about)} Dia 1: ${esc(readingLabel(planReading(key, 1)))}.</small></label>`,
          )
          .join('')}
      </fieldset>
      <label>Data de início<input type="date" name="start_date" required value="${esc(isoLocal(new Date()))}">
        <small class="hint">Todos leem a mesma parte no mesmo dia. Quem entrar depois pode pôr em dia as leituras atrasadas.</small></label>
      <button class="btn primary big">Criar plano</button>
    </form>`;
  const form = document.getElementById('plan');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = await sb
      .from('reading_plans')
      .insert({ church_id: state.church.id, plan_key: form.plan_key.value, start_date: form.start_date.value })
      .select('id')
      .single();
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    screenForget('leitura');
    toast('Plano criado. Os membros já podem entrar.');
    navigate(`/leitura/${data.id}`);
  });
}

// Cartões do Início: o devocional de hoje e a leitura de hoje dos planos em que entrei.
function homeDevotionalCard(el, changed) {
  return homeCard(el, 'devocionais', loadDevotionals, (all) => {
    const d = all.find((x) => x.publish_date === isoLocal(new Date()));
    if (!d) return '';
    return `
    <section class="card">
      <h2>${icon.book} Devocional de hoje</h2>
      <a class="devotional-mini" href="#/devocional/${d.id}">
        <strong>${esc(d.title)}</strong>
        ${d.verse_book ? `<small class="verse-ref">${esc(verseRef(d))}</small>` : ''}
        <p class="pre clamp">${esc(d.body)}</p>
      </a>
      <a href="#/devocional/${d.id}">Ler o devocional</a>
    </section>`;
  }, changed);
}

function homeReadingCard(el, changed) {
  return homeCard(el, 'leitura', loadReading, (data) => {
    const rows = data.plans
      .filter((p) => p.active && data.mine[p.id])
      .map((p) => [p, planStatus(p, data)])
      .filter(([, s]) => s.today >= 1 && !s.finished);
    if (!rows.length) return '';
    return `
    <section class="card">
      <h2>${icon.book} Leitura de hoje</h2>
      ${rows
        .map(
          ([p, s]) => `
        <a class="event-card" href="#/leitura/${p.id}">
          <span><strong>${esc(readingLabel(planReading(p.plan_key, s.today)))}</strong>
            <small>${esc(s.meta.title)} · ${s.done.has(s.today) ? 'lida ✓' : `dia ${s.today}`}${s.late.length ? ` · ${s.late.length} atrasada${s.late.length > 1 ? 's' : ''}` : ''}</small></span>${icon.chevron}
        </a>`,
        )
        .join('')}
      <a href="#/leitura">Ver o plano de leitura</a>
    </section>`;
  }, changed);
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

async function loadCells() {
  const { data: cells, error } = await sb
    .from('cells')
    .select('id, name, weekday, meets_at, location, active, cell_members(member_id, role)')
    .eq('church_id', state.church.id)
    .order('name');
  if (error) throw error;
  if (!isLeaderRole(myRole())) return { cells };
  // Liderança: a frequência dos últimos encontros e quem está sem célula.
  const since = isoLocal(addDays(new Date(), -60));
  const [meetings, people] = await Promise.all([
    sb.from('cell_meetings').select('cell_id, meeting_date, cell_attendance(count)').gte('meeting_date', since).order('meeting_date', { ascending: false }),
    sb.from('members').select('id, name, role, status').eq('church_id', state.church.id).eq('status', 'ativo').order('name'),
  ]);
  if (meetings.error) throw meetings.error;
  if (people.error) throw people.error;
  return { cells, meetings: meetings.data, people: people.data };
}

const forgetCell = (id) => {
  screenForget('celulas');
  screenForget(`celula:${id}`);
};

async function viewCells(ctx) {
  if (!requireMemberFeature('/celulas', 'celulas')) return;
  await screenShow(ctx, 'celulas', loadCells, (data) => drawCells(ctx, data));
}

function drawCells(ctx, { cells, meetings, people }) {
  if (!isLeaderRole(myRole()) || !people) {
    const mine = cells.filter((c) => c.active);
    if (mine.length === 1) return navigate(`/celulas/${mine[0].id}`);
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
  const nameOf = new Map(people.map((m) => [m.id, m.name]));
  const inCell = new Set(cells.filter((c) => c.active).flatMap((c) => c.cell_members.map((x) => x.member_id)));
  const without = people.filter((m) => !inCell.has(m.id));
  const freq = (c) => {
    const last = meetings.filter((e) => e.cell_id === c.id).slice(0, 4);
    const size = c.cell_members.length;
    if (!last.length || !size) return null;
    return Math.round((100 * last.reduce((n, e) => n + (e.cell_attendance[0]?.count || 0), 0)) / (last.length * size));
  };
  $view.innerHTML = `
    <div class="page">
      <h1>Células</h1>
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
          : '<div class="empty"><p>Nenhuma célula ainda. Toque no <strong>+</strong> para criar a primeira.</p></div>'
      }
      <section class="card">
        <h2>${icon.users} Membros sem célula (${without.length})</h2>
        ${
          without.length
            ? `<p class="pre">${without.map((m) => esc(m.name)).join('\n')}</p>`
            : '<p>Todos os membros ativos estão em alguma célula.</p>'
        }
      </section>
      ${fab('#/celulas/nova', 'Nova célula')}
    </div>`;
}

async function viewCellForm(ctx, id) {
  if (!requireMemberFeature(id ? `/celulas/${id}/editar` : '/celulas/nova', 'celulas')) return;
  if (!isLeaderRole(myRole())) return navigate('/celulas');
  let c = { name: '', weekday: null, meets_at: null, location: '', description: '', active: true };
  if (id) {
    const data = await editItem(
      ctx,
      screenCached(`celula:${id}`)?.c,
      async () => {
        const { data: row, error } = await sb.from('cells').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        return row;
      },
      () => forgetCell(id),
    );
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
        ${timeField('meets_at', 'Horário', c.meets_at || '')}
      </div>
      <label>Local (opcional)<input name="location" maxlength="200" value="${esc(c.location || '')}" placeholder="Rua das Flores, 10 · ou: on-line"></label>
      ${pinField(c)}
      <label>Descrição (opcional)<textarea name="description" rows="3" maxlength="1000">${esc(c.description || '')}</textarea></label>
      ${id ? `<label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Célula ativa
        <small class="hint">Desmarque quando a célula encerrar: ela some para os participantes, e o histórico fica guardado.</small></label>` : ''}
      ${id ? '' : '<p class="hint">Depois de criar, abra a célula para escolher o líder e colocar os participantes.</p>'}
      <button class="btn primary big">${id ? 'Salvar' : 'Criar célula'}</button>
      ${id ? '<button class="btn danger-outline" type="button" id="delete">Excluir célula</button>' : ''}
    </form>`;
  const form = document.getElementById('cell');
  bindTimeFields(form);
  bindPinField(form, { address: () => form.location.value.trim(), near: churchPin() });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {
      name: form.name.value.trim(),
      weekday: form.weekday.value === '' ? null : Number(form.weekday.value),
      meets_at: form.meets_at.value || null,
      location: form.location.value.trim() || null,
      ...pinValues(form),
      description: form.description.value.trim() || null,
    };
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = id
      ? await sb.from('cells').update({ ...row, active: form.active.checked, updated_at: new Date().toISOString() }).eq('id', id).select('id').single()
      : await sb.from('cells').insert({ ...row, church_id: state.church.id }).select('id').single();
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    forgetCell(id || data.id);
    toast(id ? 'Célula salva.' : 'Célula criada. Agora escolha o líder e os participantes.');
    navigate(`/celulas/${data.id}`);
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask(`Excluir a célula "${c.name}"? O histórico de encontros e presenças também é apagado. Para guardar o histórico, prefira desmarcar "Célula ativa".`)) return;
    const { data, error } = await sb.from('cells').delete().eq('id', id).select('id');
    if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para excluir.', 'error');
    forgetCell(id);
    toast('Célula excluída.');
    navigate('/celulas');
  });
}

async function loadCell(id) {
  const [cellRes, rosterRes, manageRes] = await Promise.all([
    sb.from('cells').select('*').eq('id', id).maybeSingle(),
    sb.rpc('cell_roster', { p_cell: id }),
    sb.rpc('can_manage_cell', { p_cell: id }),
  ]);
  if (cellRes.error) throw cellRes.error;
  if (rosterRes.error) throw rosterRes.error;
  const manage = !!manageRes.data;
  let meetings = [];
  if (cellRes.data && manage) {
    const { data, error } = await sb
      .from('cell_meetings')
      .select('id, meeting_date, topic, visitors, cell_attendance(count)')
      .eq('cell_id', id)
      .order('meeting_date', { ascending: false })
      .limit(20);
    if (error) throw error;
    meetings = data;
  }
  return { c: cellRes.data, roster: rosterRes.data, manage, meetings };
}

async function viewCell(ctx, id) {
  if (!requireMemberFeature(`/celulas/${id}`, 'celulas')) return;
  await screenShowWithPhotos(
    ctx,
    `celula:${id}`,
    () => loadCell(id),
    (d) => d.roster.map((p) => p.photo_path),
    (d, photos) => drawCell(id, d, photos),
  );
}

function drawCell(id, { c, roster, manage, meetings }, photos) {
  if (!c) {
    $view.innerHTML = `<div class="empty"><h2>Célula não encontrada</h2><a class="btn" href="#/celulas">Voltar</a></div>`;
    return;
  }
  const leader = isLeaderRole(myRole());

  $view.innerHTML = `
    <div class="page">
      <a href="#/celulas" class="back">← ${leader ? 'Células' : 'Minha célula'}</a>
      <h1>${esc(c.name)}</h1>
      ${!c.active ? '<p class="notice">Esta célula está encerrada.</p>' : ''}
      ${cellWhen(c) ? `<p class="meta">${icon.clock}${esc(cellWhen(c))}</p>` : ''}
      ${c.location ? `<p class="meta">${icon.pin}${esc(c.location)}</p>` : ''}
      ${placeBlock({ lat: c.lat, lng: c.lng, address: c.location })}
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
      forgetCell(id);
      toast('Papel na célula salvo.');
    });
    row.querySelector('[data-remove]')?.addEventListener('click', async () => {
      const name = row.querySelector('strong').textContent;
      if (!await ask(`Tirar ${name} da célula? As presenças dela continuam no histórico.`)) return;
      const { data, error } = await sb.from('cell_members').delete().eq('cell_id', id).eq('member_id', memberId).select('member_id');
      if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para isso.', 'error');
      forgetCell(id);
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
            forgetCell(id);
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
  const load = async () => {
    const [cellRes, rosterRes, meetRes] = await Promise.all([
      sb.from('cells').select('id, name').eq('id', id).maybeSingle(),
      sb.rpc('cell_roster', { p_cell: id }),
      sb.from('cell_meetings').select('id, topic, notes, visitors, cell_attendance(member_id)').eq('cell_id', id).eq('meeting_date', date).maybeSingle(),
    ]);
    if (cellRes.error) throw cellRes.error;
    if (rosterRes.error) throw rosterRes.error;
    if (meetRes.error) throw meetRes.error;
    return { name: cellRes.data?.name ?? null, roster: rosterRes.data, meeting: meetRes.data };
  };
  // Encontro novo: abre na hora com a célula guardada (participantes); um encontro já
  // registrado (para corrigir) espera o banco, por causa da lista de presença.
  const saved = screenCached(`celula:${id}`);
  const fresh =
    saved?.c && saved.manage && !saved.meetings.some((e) => e.meeting_date === date)
      ? { name: saved.c.name, roster: saved.roster, meeting: null }
      : null;
  const { name, roster, meeting } = await editItem(ctx, fresh, load, () => forgetCell(id));
  if (!ctx.alive()) return;
  if (!name) return navigate('/celulas');
  const present = new Set((meeting?.cell_attendance || []).map((a) => a.member_id));
  const cellRes = { data: { name } };
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
    forgetCell(id);
    toast('Encontro salvo.');
    navigate(`/celulas/${id}`);
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask('Apagar este encontro e a lista de presença dele?')) return;
    const { error } = await sb.from('cell_meetings').delete().eq('id', meeting.id);
    if (error) return toast(errorText(error), 'error');
    forgetCell(id);
    toast('Encontro apagado.');
    navigate(`/celulas/${id}`);
  });
}

// ---------------------------------------------------------------------
// Ministérios e escalas: a liderança cria os ministérios, o líder monta as escalas e o
// voluntário confirma ou pede troca
// ---------------------------------------------------------------------
const MINISTRY_ROLES = { lider: 'Líder', membro: 'Equipe' };
const SLOT_STATUS = { pendente: ['Falta confirmar', 'wait'], confirmado: ['Confirmado', 'ok'], troca: ['Pediu troca', 'warn'] };
const MINISTRY_SUGGESTIONS = [
  ['Louvor', 'Música e ministração nos cultos.'],
  ['Acolhimento', 'Recebe quem chega e acompanha os visitantes.'],
  ['Infantil', 'Cuida das crianças durante os cultos e faz o check-in.'],
  ['Mídia', 'Som, projeção, transmissão, redes sociais e fotos.'],
];
// "domingo, 8/11 às 19h"
const scheduleWhen = (s) =>
  `${parseIso(s.service_date).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'numeric' })}${s.service_time ? ` às ${fmtTime(s.service_time)}` : ''}`;

async function loadSchedules() {
  const [mine, ministries] = await Promise.all([
    sb.rpc('my_schedules', { p_church: state.church.id }),
    sb.rpc('ministry_overview', { p_church: state.church.id }),
  ]);
  if (mine.error) throw mine.error;
  if (ministries.error) throw ministries.error;
  return { mine: mine.data, ministries: ministries.data };
}

async function loadMinistry(id) {
  const [miRes, rosterRes, schedRes, manageRes] = await Promise.all([
    sb.from('ministries').select('id, name, description, receives_visitors, kids_checkin, gallery_publish, active').eq('id', id).maybeSingle(),
    sb.rpc('ministry_roster', { p_ministry: id }),
    sb.rpc('ministry_schedules', { p_ministry: id }),
    sb.rpc('can_manage_ministry', { p_ministry: id }),
  ]);
  for (const r of [miRes, rosterRes, schedRes, manageRes]) if (r.error) throw r.error;
  return { mi: miRes.data, roster: rosterRes.data, schedules: schedRes.data, manage: !!manageRes.data };
}

const forgetMinistry = (id) => {
  screenForget('escalas');
  if (id) screenForget(`ministerio:${id}`);
};

// A escala de hoje ainda aparece; as que já passaram, não (o guardado pode ser de ontem).
const upcoming = (rows) => rows.filter((s) => s.service_date >= isoLocal(new Date()));

function homeSchedulesCard(el, changed) {
  return homeCard(el, 'escalas', loadSchedules, (data) => {
    const rows = upcoming(data.mine).slice(0, 3);
    if (!rows.length) return '';
    return `
    <section class="card">
      <h2>${icon.clipboard} Sua próxima escala</h2>
      <div class="list">${rows
        .map(
          (s) => `
        <a class="event-card" href="#/escalas">
          <span><strong>${esc(s.ministry_name)}${s.task ? ` · ${esc(s.task)}` : ''}</strong>
            <small>${esc(scheduleWhen(s))}${s.title ? ` · ${esc(s.title)}` : ''} · ${SLOT_STATUS[s.status][0]}</small></span>${icon.chevron}
        </a>`,
        )
        .join('')}</div>
    </section>`;
  }, changed);
}

async function viewSchedules(ctx) {
  if (!requireMemberFeature('/escalas', 'escalas')) return;
  await screenShow(ctx, 'escalas', loadSchedules, drawSchedules);
}

function drawSchedules(data) {
  const leader = isLeaderRole(myRole());
  const mine = upcoming(data.mine);
  const swaps = data.ministries.filter((mi) => mi.swaps);
  $view.innerHTML = `
    <div class="page">
      <h1>Escalas</h1>
      ${swaps
        .map((mi) => `<a class="notice" href="#/ministerios/${mi.id}"><strong>${mi.swaps} ${mi.swaps === 1 ? 'pedido' : 'pedidos'} de troca em ${esc(mi.name)}.</strong> Toque para escolher quem entra no lugar.</a>`)
        .join('')}
      <h2>Minhas escalas</h2>
      ${
        mine.length
          ? `<div class="list">${mine
              .map((s) => {
                const [label, cls] = SLOT_STATUS[s.status];
                return `
          <div class="card schedule-mine" data-slot="${s.slot_id}">
            <p><strong>${esc(s.ministry_name)}${s.task ? ` · ${esc(s.task)}` : ''}</strong> <span class="tag ${cls}">${label}</span></p>
            <p class="meta">${icon.clock}${esc(scheduleWhen(s))}${s.title ? ` · ${esc(s.title)}` : ''}</p>
            ${s.status === 'troca' && s.swap_reason ? `<p class="hint">Motivo: ${esc(s.swap_reason)}</p>` : ''}
            <div class="actions-row">
              ${s.status !== 'confirmado' ? '<button class="btn primary small" data-confirm>Confirmo</button>' : ''}
              ${s.status !== 'troca' ? '<button class="btn small" data-swap>Pedir troca</button>' : ''}
              <a class="btn small" href="#/ministerios/${s.ministry_id}">Ver a escala</a>
            </div>
          </div>`;
              })
              .join('')}</div>`
          : '<div class="empty"><p>Você não está em nenhuma escala nos próximos dias.</p></div>'
      }
      <h2>Ministérios</h2>
      ${
        data.ministries.length
          ? `<div class="list">${data.ministries
              .map(
                (mi) => `
          <a class="member-row ${mi.active ? '' : 'inactive'}" href="#/ministerios/${mi.id}">
            <span class="avatar">${icon.clipboard}</span>
            <span><strong>${esc(mi.name)}</strong>
              <small>${esc(
                mi.team == null
                  ? mi.description || ''
                  : [mi.leaders ? `Líder: ${mi.leaders}` : 'Sem líder', `${mi.team} ${mi.team === 1 ? 'pessoa' : 'pessoas'}`, mi.next_date ? `próxima escala ${fmtDate(mi.next_date).slice(0, 5)}` : '']
                      .filter(Boolean)
                      .join(' · '),
              )}</small></span>
            <span class="tags">
              ${mi.my_role ? `<span class="tag role">${mi.my_role === 'lider' ? 'Você lidera' : 'Você participa'}</span>` : ''}
              ${mi.receives_visitors ? '<span class="tag">Visitantes</span>' : ''}
              ${!mi.active ? '<span class="tag">Desativado</span>' : ''}
            </span>
          </a>`,
              )
              .join('')}</div>`
          : `<div class="empty"><p>${leader ? 'Nenhum ministério ainda. Toque no <strong>+</strong> para criar o primeiro.' : 'Nenhum ministério ainda.'}</p></div>`
      }
      ${leader ? '' : '<p class="hint">Quer servir num ministério? Fale com o líder dele ou com a liderança da igreja.</p>'}
      ${leader ? fab('#/ministerios/novo', 'Novo ministério') : ''}
    </div>`;

  $view.querySelectorAll('[data-slot]').forEach((card) => {
    const s = data.mine.find((x) => x.slot_id === card.dataset.slot);
    const answer = async (confirmed, reason, btn) => {
      btn.disabled = true;
      const { data: status, error } = await sb.rpc('schedule_answer', { p_slot: s.slot_id, p_confirm: confirmed, p_reason: reason });
      if (error) {
        btn.disabled = false;
        return toast(errorText(error), 'error');
      }
      Object.assign(s, { status, swap_reason: confirmed ? null : reason || null });
      screenUpdate('escalas', data);
      screenForget(`ministerio:${s.ministry_id}`);
      toast(confirmed ? 'Presença confirmada. Obrigado por servir!' : 'Pedido de troca enviado ao líder do ministério.');
      drawSchedules(data);
    };
    card.querySelector('[data-confirm]')?.addEventListener('click', (e) => answer(true, null, e.currentTarget));
    card.querySelector('[data-swap]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const reason = await ask('Pedir troca: o líder do ministério recebe o pedido. Quer dizer o motivo? (opcional)', {
        input: 'text',
        ok: 'Pedir troca',
        placeholder: 'Motivo (opcional)',
      });
      if (reason === null) return;
      answer(false, reason.trim().slice(0, 200), btn);
    });
  });
}

async function viewMinistryForm(ctx, id) {
  if (!requireMemberFeature(id ? `/ministerios/${id}/editar` : '/ministerios/novo', 'escalas')) return;
  if (!isLeaderRole(myRole())) return navigate('/escalas');
  let mi = { name: '', description: '', receives_visitors: false, kids_checkin: false, gallery_publish: false, active: true };
  if (id) {
    const data = await editItem(
      ctx,
      screenCached(`ministerio:${id}`)?.mi,
      async () => {
        const { data: row, error } = await sb.from('ministries').select('id, name, description, receives_visitors, kids_checkin, gallery_publish, active').eq('id', id).maybeSingle();
        if (error) throw error;
        return row;
      },
      () => forgetMinistry(id),
    );
    if (!data) return navigate('/escalas');
    mi = data;
  }
  if (!ctx.alive()) return;
  const taken = new Set((screenCached('escalas')?.ministries || []).map((x) => fold(x.name)));
  const suggestions = id ? [] : MINISTRY_SUGGESTIONS.filter(([name]) => !taken.has(fold(name)));
  $view.innerHTML = `
    <form id="ministry" class="form page">
      <a href="${id ? `#/ministerios/${id}` : '#/escalas'}" class="back">← ${id ? esc(mi.name) : 'Escalas'}</a>
      <h1>${id ? 'Editar ministério' : 'Novo ministério'}</h1>
      ${
        suggestions.length
          ? `<div class="chips">${suggestions.map(([name]) => `<button type="button" class="chip" data-suggest="${esc(name)}">${esc(name)}</button>`).join('')}</div>`
          : ''
      }
      <label>Nome<input name="name" required minlength="2" maxlength="60" value="${esc(mi.name)}" placeholder="Louvor"></label>
      <label>Descrição (opcional)<textarea name="description" rows="3" maxlength="500">${esc(mi.description || '')}</textarea></label>
      ${
        featureOn('visitantes')
          ? `<label class="check"><input type="checkbox" name="receives_visitors" ${mi.receives_visitors ? 'checked' : ''}> Recebe os avisos de visitantes
              <small class="hint">A equipe deste ministério recebe o aviso de cada visitante e vê os cadastros para fazer o acompanhamento, mesmo quem não é da liderança. Só um ministério por igreja. Sem ele, o aviso vai para a liderança.</small></label>`
          : ''
      }
      ${
        featureOn('infantil')
          ? `<label class="check"><input type="checkbox" name="kids_checkin" ${mi.kids_checkin ? 'checked' : ''}> Faz o check-in das crianças
              <small class="hint">A equipe deste ministério faz a entrada e a retirada no infantil e vê o cadastro das crianças (com alergias e cuidados). Só um ministério por igreja. Sem ele, só a liderança faz o check-in.</small></label>`
          : ''
      }
      ${
        featureOn('galeria')
          ? `<label class="check"><input type="checkbox" name="gallery_publish" ${mi.gallery_publish ? 'checked' : ''}> Publica fotos na galeria
              <small class="hint">A equipe deste ministério cria álbuns, envia e apaga fotos. Só um ministério por igreja. Sem ele, só a liderança publica.</small></label>`
          : ''
      }
      ${id ? `<label class="check"><input type="checkbox" name="active" ${mi.active ? 'checked' : ''}> Ministério ativo
        <small class="hint">Desmarque para guardar o ministério sem que ele apareça para os membros.</small></label>` : ''}
      ${id ? '' : '<p class="hint">Depois de criar, abra o ministério para escolher o líder e a equipe.</p>'}
      <button class="btn primary big">${id ? 'Salvar' : 'Criar ministério'}</button>
      ${id ? '<button class="btn danger-outline" type="button" id="delete">Excluir ministério</button>' : ''}
    </form>`;
  const form = document.getElementById('ministry');
  form.querySelectorAll('[data-suggest]').forEach((b) => {
    b.onclick = () => {
      const [name, about] = MINISTRY_SUGGESTIONS.find(([n]) => n === b.dataset.suggest);
      form.name.value = name;
      form.description.value = about;
      if (form.receives_visitors) form.receives_visitors.checked = name === 'Acolhimento';
      if (form.kids_checkin) form.kids_checkin.checked = name === 'Infantil';
      if (form.gallery_publish) form.gallery_publish.checked = name === 'Mídia';
    };
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {
      name: form.name.value.trim(),
      description: form.description.value.trim() || null,
      ...(form.receives_visitors ? { receives_visitors: form.receives_visitors.checked } : {}),
      ...(form.kids_checkin ? { kids_checkin: form.kids_checkin.checked } : {}),
      ...(form.gallery_publish ? { gallery_publish: form.gallery_publish.checked } : {}),
    };
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = id
      ? await sb.from('ministries').update({ ...row, active: form.active.checked, updated_at: new Date().toISOString() }).eq('id', id).select('id').single()
      : await sb.from('ministries').insert({ ...row, church_id: state.church.id }).select('id').single();
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    forgetMinistry(id || data.id);
    if (row.receives_visitors !== mi.receives_visitors) screenForget('visitantes');
    toast(id ? 'Ministério salvo.' : 'Ministério criado. Agora escolha o líder e a equipe.');
    navigate(`/ministerios/${data.id}`);
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask(`Excluir o ministério "${mi.name}"? A equipe e todas as escalas dele também são apagadas. Para guardar o histórico, prefira desmarcar "Ministério ativo".`)) return;
    const { data, error } = await sb.from('ministries').delete().eq('id', id).select('id');
    if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para excluir.', 'error');
    forgetMinistry(id);
    toast('Ministério excluído.');
    navigate('/escalas');
  });
}

async function viewMinistry(ctx, id) {
  if (!requireMemberFeature(`/ministerios/${id}`, 'escalas')) return;
  await screenShowWithPhotos(
    ctx,
    `ministerio:${id}`,
    () => loadMinistry(id),
    (d) => d.roster.map((p) => p.photo_path),
    (d, photos) => drawMinistry(id, d, photos),
  );
}

function drawMinistry(id, { mi, roster, schedules, manage }, photos) {
  if (!mi) {
    $view.innerHTML = `<div class="empty"><h2>Ministério não encontrado</h2><a class="btn" href="#/escalas">Voltar</a></div>`;
    return;
  }
  const leader = isLeaderRole(myRole());
  const team = manage || roster.some((p) => p.is_me);
  const today = isoLocal(new Date());
  const next = schedules.filter((s) => s.service_date >= today);
  const past = schedules.filter((s) => s.service_date < today).reverse();
  const scheduleCard = (s) => `
    <div class="card schedule">
      <p><strong>${esc(scheduleWhen(s))}</strong>${s.title ? ` · ${esc(s.title)}` : ''}</p>
      ${s.notes ? `<p class="hint pre">${esc(s.notes)}</p>` : ''}
      <ul class="slots">${
        s.slots
          .map((p) => {
            const [label, cls] = SLOT_STATUS[p.status];
            return `<li><span>${esc(p.name)}${p.is_me ? ' (você)' : ''}${p.task ? ` <small class="hint">· ${esc(p.task)}</small>` : ''}
              ${p.swap_reason ? `<small class="hint">Motivo: ${esc(p.swap_reason)}</small>` : ''}
              ${manage && !p.has_account ? '<small class="hint">Sem o app: avise pessoalmente</small>' : ''}</span>
              <span class="tag ${cls}">${label}</span></li>`;
          })
          .join('') || '<li class="hint">Ninguém escalado ainda.</li>'
      }</ul>
      ${manage && s.service_date >= today ? `<a class="btn small" href="#/ministerios/${id}/escala/${s.id}">Editar escala</a>` : ''}
    </div>`;

  $view.innerHTML = `
    <div class="page">
      <a href="#/escalas" class="back">← Escalas</a>
      <h1>${esc(mi.name)}</h1>
      ${!mi.active ? '<p class="notice">Este ministério está desativado.</p>' : ''}
      ${mi.description ? `<p>${esc(mi.description)}</p>` : ''}
      ${mi.receives_visitors && featureOn('visitantes') ? '<p class="hint">Esta equipe recebe os avisos de visitantes e faz o acompanhamento em Menu &gt; Visitantes.</p>' : ''}
      ${mi.kids_checkin && featureOn('infantil') ? '<p class="hint">Esta equipe faz o check-in das crianças em Menu &gt; Check-in infantil.</p>' : ''}
      ${
        manage || leader
          ? `<div class="actions-row">
              ${manage ? `<a class="btn primary" href="#/ministerios/${id}/escala">${icon.plus} Nova escala</a>` : ''}
              ${leader ? `<a class="btn" href="#/ministerios/${id}/editar">Editar ministério</a>` : ''}
            </div>`
          : ''
      }
      ${
        !team
          ? '<p class="hint">Quer servir aqui? Fale com a liderança da igreja.</p>'
          : `<h2>Próximas escalas</h2>
             ${next.length ? next.map(scheduleCard).join('') : '<div class="empty"><p>Nenhuma escala marcada.</p></div>'}
             <h2>Equipe (${roster.length})</h2>
             <div class="list">${
               roster
                 .map(
                   (p) => `
               <div class="member-row" data-member="${p.member_id}">
                 ${avatar(p.name, p.photo_path && photos[miniOf(p.photo_path)])}
                 <span><strong>${esc(p.name)}${p.is_me ? ' (você)' : ''}</strong>
                   ${p.phone ? `<small><a href="tel:+${esc(p.phone)}">${esc(fmtPhone(p.phone))}</a></small>` : ''}</span>
                 <span class="tags">
                   ${
                     leader
                       ? `<select data-role aria-label="Papel de ${esc(p.name)} no ministério">${Object.entries(MINISTRY_ROLES)
                           .map(([k, label]) => `<option value="${k}" ${p.role === k ? 'selected' : ''}>${label}</option>`)
                           .join('')}</select>`
                       : p.role === 'lider'
                         ? '<span class="tag role">Líder</span>'
                         : ''
                   }
                   ${manage && (leader || p.role === 'membro') ? `<button class="btn small danger-outline" data-remove aria-label="Tirar ${esc(p.name)} da equipe">Tirar</button>` : ''}
                 </span>
               </div>`,
                 )
                 .join('') || '<div class="empty"><p>Ninguém na equipe ainda.</p></div>'
             }</div>
             ${
               manage
                 ? `<form id="add-member" class="form card">
                     <label>Colocar na equipe<input name="q" type="search" placeholder="Digite o nome de alguém do cadastro" autocomplete="off"></label>
                     <div id="candidates" class="list"></div>
                     <p class="hint">Quem ainda não está no cadastro precisa ser cadastrado pela secretaria.</p>
                   </form>`
                 : ''
             }
             ${past.length ? `<details class="card"><summary>Escalas anteriores (${past.length})</summary>${past.map(scheduleCard).join('')}</details>` : ''}`
      }
    </div>`;

  $view.querySelectorAll('[data-member]').forEach((row) => {
    const memberId = row.dataset.member;
    row.querySelector('[data-role]')?.addEventListener('change', async (e) => {
      const { data, error } = await sb.from('ministry_members').update({ role: e.target.value }).eq('ministry_id', id).eq('member_id', memberId).select('role');
      if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para isso.', 'error');
      forgetMinistry(id);
      toast('Papel no ministério salvo.');
    });
    row.querySelector('[data-remove]')?.addEventListener('click', async () => {
      const name = row.querySelector('strong').textContent;
      if (!await ask(`Tirar ${name} da equipe? A pessoa também sai das próximas escalas deste ministério.`)) return;
      const { data, error } = await sb.from('ministry_members').delete().eq('ministry_id', id).eq('member_id', memberId).select('member_id');
      if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para isso.', 'error');
      forgetMinistry(id);
      toast('Tirado da equipe.');
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
        const { data } = await sb.rpc('ministry_candidates', { p_ministry: id, p_search: term });
        if (addForm.q.value.trim() !== term) return;
        box.innerHTML = data?.length
          ? data.map((m) => `<button type="button" class="menu-row" data-add="${m.member_id}">${icon.plus}<span>${esc(m.name)}</span></button>`).join('')
          : '<p class="hint">Ninguém encontrado (ou já está na equipe).</p>';
        box.querySelectorAll('[data-add]').forEach((b) => {
          b.onclick = async () => {
            b.disabled = true;
            const { error } = await sb.from('ministry_members').insert({ ministry_id: id, member_id: b.dataset.add });
            if (error) {
              b.disabled = false;
              return toast(errorText(error), 'error');
            }
            forgetMinistry(id);
            toast(`${b.textContent.trim()} entrou na equipe.`);
            render();
          };
        });
      }, 250);
    });
  }
}

// Montar ou corrigir uma escala: data, horário e quem serve (da equipe), com a função de cada um.
async function viewScheduleForm(ctx, id, scheduleId) {
  if (!requireMemberFeature(`/ministerios/${id}/escala${scheduleId ? `/${scheduleId}` : ''}`, 'escalas')) return;
  const saved = screenCached(`ministerio:${id}`);
  const d = await editItem(ctx, saved?.mi ? saved : null, () => loadMinistry(id), () => forgetMinistry(id));
  if (!ctx.alive()) return;
  if (!d.mi || !d.manage) return navigate(`/ministerios/${id}`);
  const s = scheduleId ? d.schedules.find((x) => x.id === scheduleId) : null;
  if (scheduleId && !s) return navigate(`/ministerios/${id}`);
  const slotOf = new Map((s?.slots || []).map((p) => [p.member_id, p]));
  // Quem está na escala mas saiu da equipe continua aparecendo para o líder decidir.
  const people = [...d.roster.map((p) => ({ member_id: p.member_id, name: p.name })), ...(s?.slots || []).filter((p) => !d.roster.some((r) => r.member_id === p.member_id))];
  const tasks = [...new Set(d.schedules.flatMap((x) => x.slots.map((p) => p.task)).filter(Boolean))].sort();
  const date = s?.service_date || isoLocal(addDays(new Date(), 7 - new Date().getDay()));
  $view.innerHTML = `
    <form id="schedule" class="form page">
      <a href="#/ministerios/${id}" class="back">← ${esc(d.mi.name)}</a>
      <h1>${s ? 'Editar escala' : 'Nova escala'}</h1>
      <div class="colors">
        <label>Data<input name="date" type="date" required value="${date}" min="${isoLocal(new Date())}"></label>
        ${timeField('time', 'Horário', s?.service_time || '')}
      </div>
      <label>Culto ou evento (opcional)<input name="title" maxlength="80" value="${esc(s?.title || '')}" placeholder="Culto de domingo"></label>
      <fieldset>
        <legend>Quem serve: marque e escreva a função</legend>
        ${
          people.length
            ? people
                .map((p) => {
                  const slot = slotOf.get(p.member_id);
                  return `
          <div class="slot-pick">
            <label class="check"><input type="checkbox" name="pick" value="${p.member_id}" ${slot ? 'checked' : ''}> ${esc(p.name)}
              ${slot ? `<span class="tag ${SLOT_STATUS[slot.status][1]}">${SLOT_STATUS[slot.status][0]}</span>` : ''}</label>
            <input name="task-${p.member_id}" maxlength="40" list="tasks" value="${esc(slot?.task || '')}" placeholder="Função (ex.: Vocal)" aria-label="Função de ${esc(p.name)}">
          </div>`;
                })
                .join('')
            : `<p class="hint">Ninguém na equipe ainda. <a href="#/ministerios/${id}">Coloque as pessoas na equipe</a> primeiro.</p>`
        }
        <datalist id="tasks">${tasks.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
        <small class="hint" id="pick-count"></small>
      </fieldset>
      <label>Observação (opcional)<textarea name="notes" rows="2" maxlength="500" placeholder="Ex.: chegar 30 minutos antes para o ensaio">${esc(s?.notes || '')}</textarea></label>
      <p class="hint">Quem você marcar recebe um aviso no app e um lembrete na véspera. Se mudar a data ou o horário, todos precisam confirmar de novo.</p>
      <button class="btn primary big">${s ? 'Salvar escala' : 'Criar escala'}</button>
      ${s ? '<button class="btn danger-outline" type="button" id="delete">Apagar esta escala</button>' : ''}
    </form>`;
  const form = document.getElementById('schedule');
  bindTimeFields(form);
  const counter = document.getElementById('pick-count');
  const picked = () => [...form.querySelectorAll('[name=pick]:checked')].map((i) => i.value);
  const count = () => (counter.textContent = `${picked().length} ${picked().length === 1 ? 'pessoa escalada' : 'pessoas escaladas'}`);
  form.addEventListener('change', count);
  // Escrever a função já marca a pessoa.
  form.addEventListener('input', (e) => {
    const m = e.target.name?.match(/^task-(.+)$/);
    if (m && e.target.value.trim()) form.querySelector(`[name=pick][value="${m[1]}"]`).checked = true;
    count();
  });
  count();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { error } = await sb.rpc('save_schedule', {
      p_ministry: id,
      p_id: s?.id ?? null,
      p_date: form.date.value,
      p_time: form.time.value || null,
      p_title: form.title.value,
      p_notes: form.notes.value,
      p_slots: picked().map((member_id) => ({ member_id, task: form[`task-${member_id}`].value.trim() })),
    });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    forgetMinistry(id);
    toast(s ? 'Escala salva.' : 'Escala criada. A equipe já recebeu o aviso.');
    navigate(`/ministerios/${id}`);
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask('Apagar esta escala? Quem estava nela não recebe aviso; se preciso, avise a equipe.')) return;
    const { data, error } = await sb.from('schedules').delete().eq('id', s.id).select('id');
    if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para isso.', 'error');
    forgetMinistry(id);
    toast('Escala apagada.');
    navigate(`/ministerios/${id}`);
  });
}

// ---------------------------------------------------------------------
// Check-in do ministério infantil: o responsável cadastra os filhos; a equipe faz a entrada
// (com o código de retirada) e a retirada (só com o código certo)
// ---------------------------------------------------------------------
// Faz o check-in: a liderança e a equipe do ministério marcado "Faz o check-in das crianças".
const kidsTeam = () => featureOn('infantil') && (isLeaderRole(myRole()) || (isActiveMember() && !!myMember().kids_team));
const SUGGESTED_ROOMS = [
  ['Berçário', 0, 2],
  ['Maternal', 3, 5],
  ['Kids', 6, 10],
  ['Juniores', 11, 12],
];

function ageOf(birth) {
  if (!birth) return null;
  const b = parseIso(birth);
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
  return age;
}
const ageText = (birth) => {
  const a = ageOf(birth);
  return a == null ? '' : a < 1 ? 'menos de 1 ano' : a === 1 ? '1 ano' : `${a} anos`;
};
const roomAges = (r) =>
  r.min_age == null && r.max_age == null ? '' : r.max_age == null ? `${r.min_age}+ anos` : `${r.min_age ?? 0} a ${r.max_age} anos`;
// Sala sugerida pela idade.
function roomFor(rooms, birth) {
  const a = ageOf(birth);
  if (a == null) return null;
  return rooms.find((r) => (r.min_age == null || a >= r.min_age) && (r.max_age == null || a <= r.max_age)) ?? null;
}
const kidTime = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

// Os filhos da pessoa e as entradas de hoje.
async function loadMyKids() {
  const { data: kids, error } = await sb
    .from('children')
    .select('id, name, birth_date, care_notes')
    .eq('guardian_member_id', myMember().id)
    .order('name');
  if (error) throw error;
  if (!kids.length) return { kids, checkins: [] };
  const { data: checkins, error: err } = await sb
    .from('kids_checkins')
    .select('id, child_id, room_name, code, checkin_date, checked_in_at, checked_out_at')
    .in('child_id', kids.map((k) => k.id))
    .gte('checkin_date', isoLocal(addDays(new Date(), -1)))
    .order('checked_in_at', { ascending: false });
  if (err) throw err;
  return { kids, checkins };
}

// A entrada de hoje da criança (o guardado pode ser de ontem).
const todayCheckin = (checkins, childId) => checkins.find((k) => k.child_id === childId && k.checkin_date === isoLocal(new Date())) ?? null;

function homeKidsCard(el, changed) {
  return homeCard(el, 'filhos', loadMyKids, ({ kids, checkins }) => {
    const inside = kids.map((k) => [k, todayCheckin(checkins, k.id)]).filter(([, c]) => c && !c.checked_out_at);
    if (!inside.length) return '';
    return `
    <section class="card">
      <h2>${icon.child} No infantil agora</h2>
      ${inside
        .map(
          ([k, c]) => `
        <a class="event-card" href="#/filhos">
          <span><strong>${esc(firstName(k.name))}${c.room_name ? ` · ${esc(c.room_name)}` : ''}</strong>
            <small>Código de retirada: <strong class="kid-code-inline">${esc(c.code)}</strong></small></span>${icon.chevron}
        </a>`,
        )
        .join('')}
    </section>`;
  }, changed);
}

async function viewMyKids(ctx) {
  if (!requireMemberFeature('/filhos', 'infantil')) return;
  await screenShow(ctx, 'filhos', loadMyKids, drawMyKids);
}

function drawMyKids({ kids, checkins }) {
  $view.innerHTML = `
    <div class="page">
      <h1>Meus filhos</h1>
      <p class="hint">Cadastre os seus filhos para o check-in do ministério infantil. Na entrada, você recebe aqui o código para buscar.</p>
      ${
        kids.length
          ? kids
              .map((k) => {
                const c = todayCheckin(checkins, k.id);
                return `
          <section class="card kid-card">
            <h2>${esc(k.name)}</h2>
            <p class="hint">${esc([ageText(k.birth_date), k.care_notes ? `⚠️ ${k.care_notes}` : ''].filter(Boolean).join(' · '))}</p>
            ${
              c && !c.checked_out_at
                ? `<div class="kid-inside">
                    <p>🟢 No infantil${c.room_name ? ` (${esc(c.room_name)})` : ''} desde ${esc(kidTime(c.checked_in_at))}</p>
                    <p class="kid-code" aria-label="Código de retirada">${esc(c.code)}</p>
                    <p class="hint">Mostre este código para buscar ${esc(firstName(k.name))}.</p>
                  </div>`
                : c
                  ? `<p>✅ Retirado às ${esc(kidTime(c.checked_out_at))}.</p>`
                  : ''
            }
            <a class="btn small" href="#/filhos/${k.id}">Editar</a>
          </section>`;
              })
              .join('')
          : '<div class="empty"><p>Nenhum filho cadastrado. Toque no <strong>+</strong> para cadastrar.</p></div>'
      }
      ${fab('#/filhos/novo', 'Cadastrar filho')}
    </div>`;
}

// Cadastro da criança: pelo responsável (/filhos) ou pela equipe na recepção (/infantil/crianca).
async function viewChildForm(ctx, id) {
  const team = ctx.path.startsWith('/infantil');
  const back = team ? '/infantil' : '/filhos';
  if (!requireMemberFeature(ctx.path, 'infantil')) return;
  if (team && !kidsTeam()) return navigate('/filhos');
  let c = { name: '', birth_date: null, care_notes: '', guardian_member_id: null, guardian_name: '', guardian_phone: '' };
  if (id) {
    const fromList = team ? screenCached('infantil')?.kids.find((k) => k.id === id) : screenCached('filhos')?.kids.find((k) => k.id === id);
    const data = await editItem(
      ctx,
      fromList && !team ? fromList : null,
      async () => {
        const { data: row, error } = await sb
          .from('children')
          .select('id, name, birth_date, care_notes, guardian_member_id, guardian_name, guardian_phone')
          .eq('id', id)
          .maybeSingle();
        if (error) throw error;
        return row;
      },
      () => (screenForget('filhos'), screenForget('infantil')),
    );
    if (!data) return navigate(back);
    c = { ...c, ...data };
  }
  if (!ctx.alive()) return;
  const desk = team && !c.guardian_member_id && (!id || c.guardian_name);
  const canDelete = !team || isLeaderRole(myRole());
  $view.innerHTML = `
    <form id="child" class="form page">
      <a href="#${back}" class="back">← ${team ? 'Check-in infantil' : 'Meus filhos'}</a>
      <h1>${id ? 'Editar criança' : team ? 'Cadastrar criança' : 'Cadastrar filho'}</h1>
      <label>Nome da criança<input name="name" required minlength="2" maxlength="120" value="${esc(c.name)}" autocomplete="off"></label>
      <label>Data de nascimento<input name="birth_date" type="date" value="${esc(c.birth_date || '')}" max="${isoLocal(new Date())}"></label>
      <label>Alergias e cuidados (opcional)<textarea name="care_notes" rows="2" maxlength="300" placeholder="Ex.: alergia a amendoim; usa bombinha">${esc(c.care_notes || '')}</textarea>
        <small class="hint">Aparece com ⚠️ na etiqueta e para a equipe do infantil.</small></label>
      ${
        desk
          ? `<label>Nome do responsável<input name="guardian_name" required minlength="2" maxlength="120" value="${esc(c.guardian_name || '')}"></label>
             <label>WhatsApp do responsável<input name="guardian_phone" type="tel" inputmode="tel" value="${c.guardian_phone ? esc(fmtPhone(c.guardian_phone)) : ''}" placeholder="(61) 99999-0000"></label>`
          : team && id
            ? '<p class="hint">O responsável usa o app: só ele muda os dados de contato.</p>'
            : ''
      }
      ${
        id
          ? ''
          : `<label class="check"><input type="checkbox" name="consent" required> ${
              team ? 'O responsável autorizou a igreja a guardar estes dados para o check-in.' : 'Autorizo a igreja a guardar estes dados do meu filho para o check-in do infantil.'
            }
            <small class="hint">Só o responsável, a equipe do infantil e a liderança veem. O histórico de entradas é apagado em 12 meses.</small></label>`
      }
      <button class="btn primary big">${id ? 'Salvar' : 'Cadastrar'}</button>
      ${id && canDelete ? '<button class="btn danger-outline" type="button" id="delete">Excluir cadastro da criança</button>' : ''}
    </form>`;
  const form = document.getElementById('child');
  const forget = () => {
    screenForget('filhos');
    screenForget('infantil');
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {
      name: form.name.value.trim(),
      birth_date: form.birth_date.value || null,
      care_notes: form.care_notes.value.trim() || null,
    };
    if (desk) {
      const phone = form.guardian_phone.value.trim() ? normalizePhone(form.guardian_phone.value) : null;
      if (form.guardian_phone.value.trim() && !phone) return toast('WhatsApp inválido. Use DDD + número.', 'error');
      Object.assign(row, { guardian_name: form.guardian_name.value.trim(), guardian_phone: phone });
    }
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { error } = id
      ? await sb.from('children').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id).select('id').single()
      : await sb
          .from('children')
          .insert({ ...row, church_id: state.church.id, ...(team ? {} : { guardian_member_id: myMember().id }) })
          .select('id')
          .single();
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    forget();
    toast(id ? 'Salvo.' : 'Criança cadastrada.');
    navigate(back);
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask(`Excluir o cadastro de ${c.name}? O histórico de entradas também é apagado.`)) return;
    const { data, error } = await sb.from('children').delete().eq('id', id).select('id');
    if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para excluir.', 'error');
    forget();
    toast('Cadastro excluído.');
    navigate(back);
  });
}

// Recepção do infantil: todas as crianças, quem está em cada sala e os botões de entrada e retirada.
async function loadKids() {
  const [kids, rooms] = await Promise.all([
    sb.rpc('kids_roster', { p_church: state.church.id }),
    sb.from('kids_rooms').select('id, name, min_age, max_age').eq('church_id', state.church.id).order('min_age', { nullsFirst: false }),
  ]);
  if (kids.error) throw kids.error;
  if (rooms.error) throw rooms.error;
  return { kids: kids.data, rooms: rooms.data, day: isoLocal(new Date()) };
}

function requireKidsTeam(next) {
  if (!requireMemberFeature(next, 'infantil')) return false;
  if (kidsTeam()) return true;
  navigate('/filhos');
  return false;
}

async function viewKids(ctx) {
  if (!requireKidsTeam('/infantil')) return;
  await screenShow(ctx, 'infantil', loadKids, (d) => drawKids(ctx, d));
}

function drawKids(ctx, { kids, rooms, day }) {
  // O guardado pode ser de outro dia: as entradas de ontem não contam.
  const today = day === isoLocal(new Date());
  const open = today ? kids.filter((k) => k.checkin_id && !k.checked_out_at) : [];
  const byRoom = new Map();
  for (const k of open) {
    const r = k.room_name || 'Sem sala';
    if (!byRoom.has(r)) byRoom.set(r, []);
    byRoom.get(r).push(k);
  }
  const term = fold(ctx.params.get('busca') || '');
  const list = term ? kids.filter((k) => fold(k.name).includes(term) || fold(k.guardian).includes(term)) : kids;
  const status = (k) =>
    !today || !k.checkin_id
      ? ''
      : k.checked_out_at
        ? `<span class="tag">Retirado ${esc(kidTime(k.checked_out_at))}</span>`
        : `<span class="tag ok">${esc(k.room_name || 'No infantil')} · ${esc(k.code)}</span>`;
  $view.innerHTML = `
    <div class="page">
      <h1>Check-in infantil</h1>
      <p class="hint">${esc(fmtLongDay(isoLocal(new Date())))}</p>
      <div class="actions-row">
        <a class="btn primary" href="#/infantil/retirada">Retirada por código</a>
      </div>
      ${rooms.length ? '' : `<p class="notice">Nenhuma sala criada ainda. ${isLeaderRole(myRole()) ? '<a href="#/infantil/salas">Criar as salas</a>' : 'Peça à liderança para criar as salas.'}</p>`}
      <h2>Nas salas agora (${open.length})</h2>
      ${
        open.length
          ? [...byRoom]
              .map(
                ([room, list]) => `
          <section class="card">
            <h3>${esc(room)} (${list.length})</h3>
            <ul class="kids-in">${list
              .map(
                (k) => `<li><span>${esc(k.name)}${k.care_notes ? ` <span class="kid-alert" title="${esc(k.care_notes)}">⚠️ ${esc(k.care_notes)}</span>` : ''}</span>
                  ${k.phone ? `<a class="btn small" href="${esc(whatsappLink(k.phone, ''))}" target="_blank" rel="noopener" aria-label="WhatsApp do responsável por ${esc(k.name)}">WhatsApp</a>` : ''}</li>`,
              )
              .join('')}</ul>
          </section>`,
              )
              .join('')
          : '<div class="empty"><p>Nenhuma criança nas salas.</p></div>'
      }
      <h2>Crianças (${kids.length})</h2>
      <form id="kid-search" class="form"><label>Buscar<input name="q" type="search" value="${esc(ctx.params.get('busca') || '')}" placeholder="Nome da criança ou do responsável" autocomplete="off"></label></form>
      <div class="list">${
        list
          .map(
            (k) => `
        <div class="member-row" data-kid="${k.id}">
          ${avatar(k.name, null)}
          <span><strong>${esc(k.name)}</strong>
            <small>${esc([ageText(k.birth_date), k.guardian ? `resp.: ${k.guardian}` : ''].filter(Boolean).join(' · '))}${k.care_notes ? ' · ⚠️' : ''}</small></span>
          <span class="tags">
            ${status(k)}
            ${
              today && k.checkin_id && !k.checked_out_at
                ? `<a class="btn small" href="#/infantil/retirada?id=${k.checkin_id}">Retirada</a>`
                : `<a class="btn small primary" href="#/infantil/entrada/${k.id}">Entrada</a>`
            }
          </span>
        </div>`,
          )
          .join('') || `<div class="empty"><p>${term ? 'Ninguém com esse nome.' : 'Nenhuma criança cadastrada.'}</p></div>`
      }</div>
      ${
        // A retirada fica no topo (é a mais usada); o "+" cadastra e, para a liderança, leva às salas.
        isLeaderRole(myRole())
          ? fabMenu('Cadastrar criança ou salas', [['#/infantil/crianca/nova', 'Cadastrar criança'], ['#/infantil/salas', 'Salas']])
          : fab('#/infantil/crianca/nova', 'Cadastrar criança')
      }
    </div>`;
  const search = document.getElementById('kid-search');
  search.addEventListener('submit', (e) => e.preventDefault());
  let timer;
  search.q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!ctx.alive()) return; // já foi para outra tela (ex.: tocou em Entrada)
      const q = search.q.value.trim();
      history.replaceState(null, '', `#/infantil${q ? `?busca=${encodeURIComponent(q)}` : ''}`);
      ctx.params.set('busca', q);
      const pos = search.q.selectionStart;
      drawKids(ctx, { kids, rooms, day });
      const input = document.getElementById('kid-search').q;
      input.focus();
      input.setSelectionRange(pos, pos);
    }, 200);
  });
}

// Entrada: confirma a sala (sugerida pela idade) e gera o código.
async function viewKidCheckin(ctx, childId) {
  if (!requireKidsTeam(`/infantil/entrada/${childId}`)) return;
  const saved = screenCached('infantil');
  const d = await editItem(ctx, saved?.kids.some((k) => k.id === childId) ? saved : null, loadKids, () => screenForget('infantil'));
  if (!ctx.alive()) return;
  const k = d.kids.find((x) => x.id === childId);
  if (!k) return navigate('/infantil');
  const suggested = roomFor(d.rooms, k.birth_date);
  $view.innerHTML = `
    <form id="checkin" class="form page">
      <a href="#/infantil" class="back">← Check-in infantil</a>
      <h1>Entrada: ${esc(k.name)}</h1>
      <p class="hint">${esc([ageText(k.birth_date), k.guardian ? `Responsável: ${k.guardian}` : ''].filter(Boolean).join(' · '))}</p>
      ${k.care_notes ? `<p class="notice kid-warning">⚠️ <strong>Atenção:</strong> ${esc(k.care_notes)}</p>` : ''}
      <label>Sala
        <select name="room">
          ${d.rooms.map((r) => `<option value="${esc(r.name)}" ${suggested?.id === r.id ? 'selected' : ''}>${esc(r.name)}${roomAges(r) ? ` (${esc(roomAges(r))})` : ''}</option>`).join('')}
          <option value="" ${d.rooms.length && suggested ? '' : 'selected'}>Sem sala</option>
        </select>
      </label>
      ${k.has_app ? '<p class="hint">O responsável recebe o código de retirada no app.</p>' : '<p class="hint">O responsável não usa o app: entregue a segunda etiqueta (ou anote o código para ele).</p>'}
      <button class="btn primary big">Confirmar entrada</button>
    </form>`;
  const form = document.getElementById('checkin');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = await sb.rpc('kids_checkin', { p_child: k.id, p_room: form.room.value });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    const [row] = data;
    // Guarda a entrada na hora: a etiqueta abre sem esperar o banco.
    Object.assign(k, { checkin_id: row.checkin_id, code: row.code, room_name: row.room_name, checked_in_at: new Date().toISOString(), checked_out_at: null });
    screenUpdate('infantil', { ...d, day: isoLocal(new Date()) });
    navigate(`/infantil/etiqueta/${row.checkin_id}`);
  });
}

// Etiquetas: uma para a criança e outra (com o código) para o responsável.
async function viewKidLabel(ctx, checkinId) {
  if (!requireKidsTeam(`/infantil/etiqueta/${checkinId}`)) return;
  await screenShow(ctx, 'infantil', loadKids, ({ kids }) => {
    const k = kids.find((x) => x.checkin_id === checkinId);
    if (!k) {
      $view.innerHTML = `<div class="empty"><h2>Entrada não encontrada</h2><a class="btn" href="#/infantil">Voltar</a></div>`;
      return;
    }
    const day = new Date(k.checked_in_at).toLocaleDateString('pt-BR');
    $view.innerHTML = `
      <div class="page kid-labels">
        <a href="#/infantil" class="back no-print">← Check-in infantil</a>
        <h1 class="no-print">Entrada confirmada</h1>
        <p class="no-print">Código de retirada de ${esc(firstName(k.name))}:</p>
        <p class="kid-code no-print">${esc(k.code)}</p>
        <div class="actions-row no-print">
          <button class="btn primary" id="print">${icon.print} Imprimir etiquetas</button>
          <a class="btn" href="#/infantil">Próxima criança</a>
        </div>
        <p class="hint no-print">Sem impressora? Escreva o código num adesivo para a criança e outro para o responsável.</p>
        <div class="kid-label">
          <p class="kid-label-name">${esc(k.name)}</p>
          <p>${esc([k.room_name, ageText(k.birth_date)].filter(Boolean).join(' · '))}</p>
          ${k.care_notes ? `<p class="kid-label-alert">⚠️ ${esc(k.care_notes)}</p>` : ''}
          <p class="kid-label-code">${esc(k.code)}</p>
          <p class="kid-label-foot">${esc(state.church.name)} · ${esc(day)}</p>
        </div>
        <div class="kid-label">
          <p class="kid-label-name">Retirada</p>
          <p>${esc(k.name)}${k.room_name ? ` · ${esc(k.room_name)}` : ''}</p>
          <p class="kid-label-code">${esc(k.code)}</p>
          <p class="kid-label-foot">Mostre este código para buscar a criança · ${esc(day)}</p>
        </div>
      </div>`;
    document.getElementById('print').onclick = () => window.print();
  });
}

// Retirada: pelo código (a equipe digita o que o responsável mostra) ou a partir da lista.
async function viewKidCheckout(ctx) {
  if (!requireKidsTeam('/infantil/retirada')) return;
  const fromList = ctx.params.get('id');
  const k = fromList ? screenCached('infantil')?.kids.find((x) => x.checkin_id === fromList) : null;
  $view.innerHTML = `
    <form id="checkout" class="form page">
      <a href="#/infantil" class="back">← Check-in infantil</a>
      <h1>Retirada</h1>
      ${k ? `<p><strong>${esc(k.name)}</strong>${k.room_name ? ` · ${esc(k.room_name)}` : ''}${k.guardian ? `<br><span class="hint">Responsável: ${esc(k.guardian)}</span>` : ''}</p>` : ''}
      <label>Código de retirada<input name="code" required minlength="4" maxlength="4" autocomplete="off" autocapitalize="characters" class="code-input" placeholder="K7P3"></label>
      <p class="hint">Peça ao responsável o código da etiqueta ou do app.</p>
      <div id="found"></div>
      <button class="btn primary big">${k ? 'Confirmar retirada' : 'Conferir código'}</button>
    </form>`;
  const form = document.getElementById('checkout');
  const found = document.getElementById('found');
  let checkinId = fromList;
  const done = async (code) => {
    const { data: name, error } = await sb.rpc('kids_checkout', { p_checkin: checkinId, p_code: code });
    if (error) return toast(errorText(error), 'error');
    screenForget('infantil');
    toast(`${firstName(name)} foi retirado.`);
    navigate('/infantil');
  };
  form.code.addEventListener('input', () => {
    form.code.value = form.code.value.toUpperCase();
    if (!fromList) {
      checkinId = null;
      found.innerHTML = '';
      form.querySelector('button.primary').textContent = 'Conferir código';
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    const code = form.code.value.trim().toUpperCase();
    btn.disabled = true;
    try {
      if (checkinId) return await done(code);
      const { data, error } = await sb.rpc('kids_lookup_code', { p_church: state.church.id, p_code: code });
      if (error) return toast(errorText(error), 'error');
      if (!data.length) return toast('Nenhuma criança no infantil com esse código hoje.', 'error');
      const [x] = data;
      checkinId = x.checkin_id;
      found.innerHTML = `<p class="notice"><strong>${esc(x.child_name)}</strong>${x.room_name ? ` · ${esc(x.room_name)}` : ''}<br>Responsável: ${esc(x.guardian || '—')} · entrou às ${esc(kidTime(x.checked_in_at))}</p>`;
      btn.textContent = 'Confirmar retirada';
    } finally {
      btn.disabled = false;
    }
  });
}

// Salas por idade (a liderança cria e apaga).
async function loadRooms() {
  const { data, error } = await sb.from('kids_rooms').select('id, name, min_age, max_age').eq('church_id', state.church.id).order('min_age', { nullsFirst: false });
  if (error) throw error;
  return data;
}

async function viewKidRooms(ctx) {
  if (!requireKidsTeam('/infantil/salas')) return;
  if (!isLeaderRole(myRole())) return navigate('/infantil');
  await screenShow(ctx, 'salas', loadRooms, drawKidRooms);
}

function drawKidRooms(rooms) {
  const ageOpts = (v) => `<option value="">—</option>${Array.from({ length: 18 }, (_, i) => `<option value="${i}" ${v === i ? 'selected' : ''}>${i}</option>`).join('')}`;
  $view.innerHTML = `
    <div class="page">
      <a href="#/infantil" class="back">← Check-in infantil</a>
      <h1>Salas</h1>
      <p class="hint">Na entrada, o app sugere a sala pela idade da criança.</p>
      ${
        rooms.length
          ? `<div class="list">${rooms
              .map(
                (r) => `
          <div class="member-row">
            <span><strong>${esc(r.name)}</strong><small>${esc(roomAges(r) || 'qualquer idade')}</small></span>
            <span class="tags"><button class="btn small danger-outline" data-del="${r.id}" aria-label="Apagar a sala ${esc(r.name)}">Apagar</button></span>
          </div>`,
              )
              .join('')}</div>`
          : `<div class="empty"><p>Nenhuma sala ainda.</p><button class="btn" id="suggest">Criar as salas sugeridas</button>
             <p class="hint">${SUGGESTED_ROOMS.map(([n, a, b]) => `${n} (${a} a ${b} anos)`).join(', ')}</p></div>`
      }
      <form id="room" class="form card">
        <h2>Nova sala</h2>
        <label>Nome<input name="name" required minlength="2" maxlength="40" placeholder="Kids"></label>
        <div class="colors">
          <label>Idade de<select name="min_age">${ageOpts(null)}</select></label>
          <label>até<select name="max_age">${ageOpts(null)}</select></label>
        </div>
        <button class="btn primary">Criar sala</button>
      </form>
    </div>`;
  const done = (msg) => {
    screenForget('salas');
    screenForget('infantil');
    toast(msg);
    render();
  };
  const insert = (rows) => sb.from('kids_rooms').insert(rows.map((r) => ({ ...r, church_id: state.church.id })));
  document.getElementById('suggest')?.addEventListener('click', async () => {
    const { error } = await insert(SUGGESTED_ROOMS.map(([name, min_age, max_age]) => ({ name, min_age, max_age })));
    if (error) return toast(errorText(error), 'error');
    done('Salas criadas.');
  });
  const form = document.getElementById('room');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const num = (v) => (v === '' ? null : Number(v));
    const row = { name: form.name.value.trim(), min_age: num(form.min_age.value), max_age: num(form.max_age.value) };
    if (row.min_age != null && row.max_age != null && row.min_age > row.max_age) return toast('A idade inicial precisa ser menor que a final.', 'error');
    const { error } = await insert([row]);
    if (error) return toast(errorText(error), 'error');
    done('Sala criada.');
  });
  $view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!await ask('Apagar esta sala? As entradas antigas continuam no histórico.')) return;
      const { data, error } = await sb.from('kids_rooms').delete().eq('id', b.dataset.del).select('id');
      if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para isso.', 'error');
      done('Sala apagada.');
    };
  });
}

// ---------------------------------------------------------------------
// Carteirinha digital: o próprio cadastro (guardado no aparelho) com o QR Code de conferência
// ---------------------------------------------------------------------
const cardUrl = (token) => `${PAGE_URL}#/carteirinha/verificar/${token}`;
const fmtLongDate = (iso) => parseIso(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
const cardLines = (m) =>
  [
    m.member_since ? ['Membro desde', fmtLongDate(m.member_since)] : null,
    m.baptism_date ? ['Batismo', fmtLongDate(m.baptism_date)] : null,
  ].filter(Boolean);

async function viewCard(ctx) {
  if (!requireMemberFeature('/carteirinha', 'carteirinha')) return;
  const me = myMember();
  // Mesmo guardado do "Meu cadastro": abre na hora, até sem internet.
  await screenShowWithPhotos(
    ctx,
    'perfil',
    () => loadProfile(me.id),
    (m) => [m.photo_path],
    (m, photos) => drawCard(ctx, m, photos),
  );
}

function drawCard(ctx, m, photos) {
  const c = state.church;
  const photo = m.photo_path && photos[miniOf(m.photo_path)];
  $view.innerHTML = `
    <div class="page">
      <h1>Minha carteirinha</h1>
      <div class="member-card" style="--card: ${esc(c.primary_color || DEFAULT_COLOR)}; --card-ink: ${esc(inkOn(c.primary_color || DEFAULT_COLOR))}">
        <div class="member-card-head">
          <img src="${esc(c.logo_url || 'icons/icon-192.png')}" alt="" width="40" height="40">
          <span>${esc(c.name)}</span>
        </div>
        <div class="member-card-body">
          ${avatar(m.name, photo, 'big')}
          <div>
            <p class="member-card-name">${esc(m.name)}</p>
            <p class="member-card-role">${esc(ROLES[m.role])}</p>
            ${cardLines(m).map(([k, v]) => `<p><small>${esc(k)}</small> ${esc(v)}</p>`).join('')}
          </div>
        </div>
        <div class="member-card-qr" id="card-qr" aria-label="QR Code para conferir a carteirinha"></div>
        <p class="member-card-foot">Aponte a câmera para conferir</p>
      </div>
      <div class="actions-row">
        <button class="btn primary" id="card-save">${icon.upload} Salvar imagem</button>
        <button class="btn" id="card-rotate">Gerar novo QR Code</button>
      </div>
      <p class="hint">Quem ler o QR Code vê se você é membro ativo da igreja, com o nome, o papel e "membro desde". A foto, o telefone e o e-mail não aparecem. Se alguém copiou a sua carteirinha, gere um novo QR Code: o anterior deixa de valer.</p>
      ${m.member_since ? '' : '<p class="hint">"Membro desde" é preenchido pela secretaria ou pela liderança.</p>'}
    </div>`;
  qrSvg(cardUrl(m.card_token))
    .then((svg) => {
      const box = document.getElementById('card-qr');
      if (box && ctx.alive()) box.innerHTML = svg;
    })
    .catch(() => {});

  const saveBtn = document.getElementById('card-save');
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const blob = await cardImage(m, photo);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: `carteirinha-${slugify(firstName(m.name))}.png` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Imagem salva.');
    } catch {
      toast('Não foi possível gerar a imagem.', 'error');
    } finally {
      saveBtn.disabled = false;
    }
  };
  document.getElementById('card-rotate').onclick = async () => {
    if (!await ask('Gerar um novo QR Code? O anterior (e as imagens salvas com ele) deixa de valer.')) return;
    const { data: token, error } = await sb.rpc('rotate_card_token', { p_church: c.id });
    if (error) return toast(errorText(error), 'error');
    Object.assign(m, { card_token: token, card_token_at: new Date().toISOString() });
    screenUpdate('perfil', m);
    toast('Novo QR Code gerado.');
    drawCard(ctx, m, photos);
  };
}

// Carteirinha como imagem (PNG), desenhada no aparelho.
async function cardImage(m, photoUrl) {
  const c = state.church;
  const color = c.primary_color || DEFAULT_COLOR;
  const ink = inkOn(color);
  const W = 1000;
  const H = 1400;
  const cv = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = cv.getContext('2d');
  const load = (src) =>
    new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = color;
  g.fillRect(0, 0, W, 300);
  const [logo, photo, qr] = await Promise.all([load(c.logo_url || 'icons/icon-192.png'), load(photoUrl), qrImage(cardUrl(m.card_token), 14)]);
  if (logo) g.drawImage(logo, 60, 60, 120, 120);
  g.fillStyle = ink;
  g.font = 'bold 52px system-ui, sans-serif';
  g.fillText(c.name.slice(0, 26), 210, 140);
  g.font = '32px system-ui, sans-serif';
  g.fillText('Carteirinha de membro', 210, 195);
  // Foto (ou as iniciais) num círculo
  g.save();
  g.beginPath();
  g.arc(W / 2, 400, 150, 0, Math.PI * 2);
  g.closePath();
  g.fillStyle = '#e9ecf5';
  g.fill();
  g.clip();
  if (photo) g.drawImage(photo, W / 2 - 150, 250, 300, 300);
  else {
    g.fillStyle = '#5f6475';
    g.font = 'bold 110px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(initials(m.name), W / 2, 440);
  }
  g.restore();
  g.textAlign = 'center';
  g.fillStyle = '#1b1e27';
  g.font = 'bold 56px system-ui, sans-serif';
  g.fillText(m.name.slice(0, 32), W / 2, 640);
  g.fillStyle = '#5f6475';
  g.font = '38px system-ui, sans-serif';
  g.fillText(ROLES[m.role], W / 2, 700);
  let y = 770;
  for (const [k, v] of cardLines(m)) {
    g.fillText(`${k}: ${v}`, W / 2, y);
    y += 52;
  }
  g.drawImage(qr, W / 2 - 220, 880, 440, 440);
  g.font = '28px system-ui, sans-serif';
  g.fillText('Aponte a câmera para conferir', W / 2, 1360);
  return new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error('imagem'))), 'image/png'));
}

// Conferência pública (sem login): o banco responde só pelo código exato da carteirinha.
async function viewCardVerify(ctx, token) {
  $view.innerHTML = '<div class="page card-verify"><p class="hint center">Conferindo a carteirinha…</p></div>';
  const { data, error } = await sb.rpc('verify_member_card', { p_token: token });
  if (!ctx.alive()) return;
  if (error) throw error;
  const r = data?.[0];
  const now = new Date().toLocaleString('pt-BR', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  $view.innerHTML = `
    <div class="page card-verify">
      ${
        !r
          ? `<div class="verify-result bad"><p class="verify-icon">❌</p><h1>Carteirinha não reconhecida</h1>
               <p>O QR Code pode ter sido trocado por um novo, ou a igreja não usa mais a carteirinha digital.</p></div>`
          : `<div class="verify-result ${r.active ? 'ok' : 'warn'}">
               <img src="${esc(r.logo_url || 'icons/icon-192.png')}" alt="" width="64" height="64">
               <p class="verify-icon">${r.active ? '✅' : '⚠️'}</p>
               <h1>${r.active ? 'Membro ativo' : 'Este cadastro não está ativo'}</h1>
               <p class="verify-church">${esc(r.church_name)}</p>
               <p class="member-card-name">${esc(r.name)}</p>
               <p>${esc(ROLES[r.role] || '')}</p>
               ${r.member_since ? `<p>Membro desde ${esc(fmtLongDate(r.member_since))}</p>` : ''}
             </div>`
      }
      <p class="hint center">Conferido em ${esc(now)} pelo ${esc(CONFIG.APP_NAME)}.</p>
    </div>`;
}

// ---------------------------------------------------------------------
// Relatórios da liderança: só totais, calculados no banco (church_report)
// ---------------------------------------------------------------------
const REPORT_PERIODS = [
  ['3', 'Últimos 3 meses'],
  ['6', 'Últimos 6 meses'],
  ['12', 'Últimos 12 meses'],
];
const AGE_GROUPS = [
  ['criancas', 'Crianças (0–11)'],
  ['adolescentes', 'Adolescentes (12–17)'],
  ['jovens', 'Jovens (18–29)'],
  ['adultos', 'Adultos (30–59)'],
  ['idosos', 'Idosos (60+)'],
  ['sem_data', 'Sem data de nascimento'],
];
const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// Período escolhido: "3", "6" ou "12" meses até hoje, ou um ano ("2026").
function reportPeriod(key) {
  const today = new Date();
  if (/^\d{4}$/.test(key)) {
    const y = Number(key);
    const end = y === today.getFullYear() ? today : new Date(y, 11, 31);
    return { key, from: `${y}-01-01`, to: isoLocal(end), label: `Ano de ${y}` };
  }
  const n = ['3', '6', '12'].includes(key) ? Number(key) : 3;
  const from = new Date(today.getFullYear(), today.getMonth() - n, today.getDate() + 1);
  return { key: String(n), from: isoLocal(from), to: isoLocal(today), label: REPORT_PERIODS.find(([k]) => k === String(n))[1] };
}

async function loadReport(p) {
  const { data, error } = await sb.rpc('church_report', { p_church: state.church.id, p_from: p.from, p_to: p.to });
  if (error) throw error;
  return data;
}

async function viewReports(ctx) {
  if (!requireMemberFeature('/relatorios', 'relatorios')) return;
  if (!isLeaderRole(myRole())) return navigate('/');
  const p = reportPeriod(ctx.params.get('periodo') || '3');
  await screenShow(ctx, `relatorio:${p.key}`, () => loadReport(p), (r) => drawReport(p, r));
}

const monthLabel = (ym, withYear) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]}${withYear ? `/${String(y).slice(2)}` : ''}`;
};
const pct = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '—');
const statTile = (label, value, note = '') =>
  `<div class="stat-tile"><span class="stat-value">${esc(String(value ?? '—'))}</span><span class="stat-label">${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ''}</div>`;

// Barras verticais (uma série, na cor da igreja): passar o dedo ou o mouse mostra o valor;
// o maior valor fica escrito; a tabela embaixo traz todos.
function barChart(title, rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const top = rows.reduce((best, r, i) => (r.value > (rows[best]?.value ?? -1) ? i : best), 0);
  return `
    <figure class="bar-chart">
      <figcaption>${esc(title)}</figcaption>
      <div class="bars" role="img" aria-label="${esc(`${title}: ${rows.map((r) => `${r.label} ${r.value}`).join(', ')}`)}">
        ${rows
          .map(
            (r, i) => `
          <div class="bar-col" title="${esc(`${r.label}: ${r.value}`)}" tabindex="0">
            <span class="bar-value ${i === top && r.value ? '' : 'hidden-value'}">${r.value}</span>
            <span class="bar" style="height:${Math.max(r.value ? 4 : 0, Math.round((100 * r.value) / max))}%"></span>
            <span class="bar-label">${esc(r.label)}</span>
          </div>`,
          )
          .join('')}
      </div>
      <details><summary>Ver em tabela</summary>
        <table class="help-table">${rows.map((r) => `<tr><th>${esc(r.label)}</th><td>${r.value}</td></tr>`).join('')}</table>
      </details>
    </figure>`;
}

// Barras horizontais com o número ao lado (categorias, ex.: faixa etária).
function hBars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows
    .map(
      (r) => `
    <div class="hbar-row"><span class="hbar-label">${esc(r.label)}</span>
      <span class="hbar-track"><span class="hbar" style="width:${Math.round((100 * r.value) / max)}%"></span></span>
      <span class="hbar-value">${r.value}</span></div>`,
    )
    .join('')}</div>`;
}

const csvButton = (key) => `<button class="btn small no-print" data-csv="${key}">${icon.upload} Baixar planilha</button>`;
const reportTable = (head, rows) =>
  `<div class="table-wrap"><table class="preview-table"><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c == null ? '—' : String(c))}</td>`).join('')}</tr>`)
    .join('')}</table></div>`;

function drawReport(p, r) {
  const m = r.membros;
  const years = new Set(m.novos_por_mes.map((x) => x.mes.slice(0, 4))).size > 1;
  const months = (list) => list.map((x) => ({ label: monthLabel(x.mes, years), value: x.total }));
  const thisYear = new Date().getFullYear();
  const sections = {};

  sections.membros = {
    html: `
      <div class="stat-grid">
        ${statTile('Membros ativos', m.ativos)}
        ${statTile('Usam o app', m.no_app, `${pct(m.no_app, m.ativos)} dos ativos`)}
        ${statTile('Novos no período', m.novos)}
        ${statTile('Inativos', m.inativos)}
      </div>
      ${barChart('Novos membros por mês', months(m.novos_por_mes))}
      <h3>Faixa etária (ativos)</h3>
      ${hBars(AGE_GROUPS.map(([k, label]) => ({ label, value: m.faixa_etaria[k] })))}
      <h3>Papéis</h3>
      ${hBars(Object.entries(ROLES).map(([k, label]) => ({ label, value: m.por_papel[k] || 0 })))}
      ${barChart('Aniversariantes por mês (ativos)', m.aniversarios_por_mes.map((v, i) => ({ label: MONTHS_SHORT[i], value: v })))}`,
    csv: [
      ['Indicador', 'Valor'],
      ['Membros ativos', m.ativos],
      ['Usam o app', m.no_app],
      ['Inativos', m.inativos],
      ['Novos no período', m.novos],
      ...m.novos_por_mes.map((x) => [`Novos em ${x.mes}`, x.total]),
      ...AGE_GROUPS.map(([k, label]) => [label, m.faixa_etaria[k]]),
      ...Object.entries(ROLES).map(([k, label]) => [`Papel: ${label}`, m.por_papel[k] || 0]),
      ...m.aniversarios_por_mes.map((v, i) => [`Aniversariantes em ${MONTHS[i]}`, v]),
    ],
  };

  if (r.visitantes) {
    const v = r.visitantes;
    sections.visitantes = {
      title: 'Visitantes',
      html: `
        <div class="stat-grid">
          ${statTile('Visitantes', v.total)}
          ${statTile('Viraram membros', v.viraram_membros, `${pct(v.viraram_membros, v.total)} dos visitantes`)}
          ${statTile('Primeira vez', v.primeira_vez)}
          ${statTile('Já tinham vindo', v.ja_tinham_vindo)}
        </div>
        ${barChart('Visitantes por mês', months(v.por_mes))}
        <h3>Como conheceram a igreja</h3>
        ${hBars(Object.entries(v.como_conheceram).map(([k, n]) => ({ label: VISITOR_SOURCES[k] || 'Não informado', value: n })))}`,
      csv: [
        ['Indicador', 'Valor'],
        ['Visitantes', v.total],
        ['Viraram membros', v.viraram_membros],
        ['Primeira vez', v.primeira_vez],
        ['Já tinham vindo', v.ja_tinham_vindo],
        ...v.por_mes.map((x) => [`Visitantes em ${x.mes}`, x.total]),
        ...Object.entries(v.como_conheceram).map(([k, n]) => [`Conheceu: ${VISITOR_SOURCES[k] || 'Não informado'}`, n]),
      ],
    };
  }

  if (r.celulas) {
    const c = r.celulas;
    const head = ['Célula', 'Participantes', 'Encontros', 'Presenças', 'Frequência', 'Visitantes'];
    const rows = c.por_celula.map((x) => [x.celula, x.participantes, x.encontros, x.presencas, x.frequencia == null ? null : `${x.frequencia}%`, x.visitantes]);
    sections.celulas = {
      title: 'Células',
      html: `
        <div class="stat-grid">
          ${statTile('Células ativas', c.por_celula.length)}
          ${statTile('Membros sem célula', c.membros_sem_celula)}
        </div>
        ${rows.length ? reportTable(head, rows) : '<p class="hint">Nenhuma célula ativa.</p>'}
        <p class="hint">Frequência: presenças ÷ (encontros × participantes de hoje).</p>
        ${barChart('Presenças nas células por mês', months(c.presencas_por_mes))}`,
      csv: [head, ...rows],
    };
  }

  if (r.infantil) {
    const k = r.infantil;
    sections.infantil = {
      title: 'Ministério infantil',
      html: `
        <div class="stat-grid">
          ${statTile('Entradas', k.entradas)}
          ${statTile('Crianças diferentes', k.criancas_diferentes)}
          ${statTile('Média por dia', k.media_por_dia ?? '—', `${k.dias} ${k.dias === 1 ? 'dia' : 'dias'} com check-in`)}
          ${statTile('Maior dia', k.maior_dia?.total ?? '—', k.maior_dia ? fmtDate(k.maior_dia.dia) : '')}
        </div>
        ${k.por_dia.length ? barChart('Crianças por dia', k.por_dia.slice(-26).map((x) => ({ label: fmtDate(x.dia).slice(0, 5), value: x.total }))) : ''}
        <h3>Por sala</h3>
        ${Object.keys(k.por_sala).length ? hBars(Object.entries(k.por_sala).map(([label, value]) => ({ label, value }))) : '<p class="hint">Nenhuma entrada no período.</p>'}`,
      csv: [['Dia', 'Crianças'], ...k.por_dia.map((x) => [fmtDate(x.dia), x.total]), [], ['Sala', 'Entradas'], ...Object.entries(k.por_sala)],
    };
  }

  if (r.escalas) {
    const head = ['Ministério', 'Escalas', 'Pessoas escaladas', 'Confirmadas', 'Pedidos de troca', 'Confirmação'];
    const rows = r.escalas.map((x) => [x.ministerio, x.escalas, x.pessoas_escaladas, x.confirmadas, x.trocas, x.confirmacao == null ? null : `${x.confirmacao}%`]);
    sections.escalas = {
      title: 'Escalas',
      html: rows.length ? reportTable(head, rows) : '<p class="hint">Nenhum ministério ativo.</p>',
      csv: [head, ...rows],
    };
  }

  if (r.inscricoes) {
    const head = ['Evento', 'Data', 'Vagas', 'Confirmadas', 'Lista de espera'];
    const rows = r.inscricoes.map((x) => [x.evento, new Date(x.inicio).toLocaleDateString('pt-BR'), x.vagas ?? 'sem limite', x.confirmadas, x.lista_de_espera]);
    sections.inscricoes = {
      title: 'Eventos com inscrição',
      html: rows.length ? reportTable(head, rows) : '<p class="hint">Nenhum evento com inscrição no período.</p>',
      csv: [head, ...rows],
    };
  }

  const part = r.participacao;
  const partRows = [
    ['Pessoas em planos de leitura', part.planos_de_leitura],
    ['"Amém" nos devocionais', part.amens],
    ['Pedidos de oração enviados', part.pedidos_de_oracao],
  ].filter(([, v]) => v != null);
  if (partRows.length) {
    sections.participacao = {
      title: 'Participação no app',
      html: `<div class="stat-grid">${partRows.map(([label, v]) => statTile(label, v)).join('')}</div>
        <p class="hint">Só totais: ninguém aparece pelo nome, e o texto dos pedidos de oração não entra no relatório.</p>`,
      csv: [['Indicador', 'Valor'], ...partRows],
    };
  }
  sections.membros.title = 'Membros';

  $view.innerHTML = `
    <div class="page report sheet">
      ${sheetHead('Relatórios', p.label, `${fmtDate(p.from)} a ${fmtDate(p.to)}`)}
      <div class="chips filters no-print">
        ${REPORT_PERIODS.map(([k, label]) => `<a class="chip ${p.key === k ? 'active' : ''}" href="#/relatorios?periodo=${k}">${label}</a>`).join('')}
        ${[thisYear, thisYear - 1].map((y) => `<a class="chip ${p.key === String(y) ? 'active' : ''}" href="#/relatorios?periodo=${y}">${y}</a>`).join('')}
      </div>
      <div class="actions-row no-print">
        <button class="btn" id="members-csv">${icon.users} Lista de membros completa</button>
        <button class="btn" id="print">${icon.print} Imprimir ou salvar PDF</button>
      </div>
      ${Object.entries(sections)
        .map(
          ([key, s]) => `
        <section class="card report-section">
          <div class="report-head"><h2>${esc(s.title)}</h2>${csvButton(key)}</div>
          ${s.html}
        </section>`,
        )
        .join('')}
      <div class="sheet-end">${sheetSigns(['Secretaria', 'Pastor(a) responsável'])}${sheetFoot()}</div>
    </div>`;

  const cell = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const toCsv = (rows) => rows.map((l) => l.map(cell).join(';')).join('\r\n');
  $view.querySelectorAll('[data-csv]').forEach((b) => {
    b.onclick = () => downloadFile(`relatorio-${b.dataset.csv}-${p.from}-a-${p.to}.csv`, toCsv(sections[b.dataset.csv].csv), 'text/csv;charset=utf-8');
  });
  document.getElementById('print').onclick = () => printAs(`Relatório - ${state.church.name} - ${p.label}`);
  const membersBtn = document.getElementById('members-csv');
  membersBtn.onclick = async () => {
    membersBtn.disabled = true;
    // Dados pessoais: buscados na hora e nunca guardados no aparelho.
    const { data, error } = await sb.from('members').select(MEMBER_COLUMNS).eq('church_id', state.church.id).order('name');
    membersBtn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    const rows = [
      ['Nome', 'E-mail', 'Telefone', 'Nascimento', 'Papel', 'Situação', 'Membro desde', 'Usa o app'],
      ...data.map((x) => [
        x.name,
        x.email,
        x.phone ? fmtPhone(x.phone) : '',
        x.birth_date ? fmtDate(x.birth_date) : '',
        ROLES[x.role],
        x.status === 'ativo' ? 'Ativo' : 'Inativo',
        x.member_since ? fmtDate(x.member_since) : '',
        x.user_id && x.consent_at ? 'Sim' : 'Não',
      ]),
    ];
    downloadFile(`membros-${slugify(state.church.name)}-${isoLocal(new Date())}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
    toast('Planilha baixada.');
  };
}

// ---------------------------------------------------------------------
// Financeiro da tesouraria: lançamentos, saldos, contas e categorias. O app só registra (o
// dinheiro não passa por ele). Valores em centavos. As regras ficam no banco (026_financeiro.sql)
// e as telas, só na memória (PRIVATE_SCREENS).
// ---------------------------------------------------------------------
const FIN_KINDS = { entrada: 'Entrada', saida: 'Saída', transferencia: 'Transferência' };
const monthKey = (d = new Date()) => isoLocal(d).slice(0, 7); // "2026-10"
const monthOf = (key) => key.split('-').map(Number);
const finMonthLabel = (key) => `${MONTHS[monthOf(key)[1] - 1]} de ${monthOf(key)[0]}`;
const monthShift = (key, n) => monthKey(new Date(monthOf(key)[0], monthOf(key)[1] - 1 + n, 1));
const monthEnd = (key) => isoLocal(new Date(monthOf(key)[0], monthOf(key)[1], 0));
const monthParam = (ctx) => (/^\d{4}-\d{2}$/.test(ctx.params.get('mes') || '') ? ctx.params.get('mes') : monthKey());

// Depois de lançar ou mudar contas: todas as telas do financeiro esperam o banco de novo.
function forgetFinance() {
  const prefix = screenKey('financeiro');
  for (const key of [...screenMem.keys()]) {
    if (!key.startsWith(prefix)) continue;
    screenMem.delete(key);
    screenLoading.delete(key);
  }
}

function requireTreasury(next) {
  if (!requireMemberFeature(next, 'financeiro')) return false;
  if (treasury()) return true;
  $view.innerHTML = `<div class="empty"><h2>Só para a tesouraria</h2><p>Peça ao administrador da igreja para marcar você como tesouraria no seu cadastro.</p><a class="btn" href="#/">Voltar</a></div>`;
  return false;
}

// Contas e categorias. Na primeira vez, o banco cria as mais comuns (finance_setup).
async function loadFinanceBase() {
  const church = state.church.id;
  const get = async () => {
    const [a, c] = await Promise.all([
      sb.from('fin_accounts').select('id, name, opening_cents, active').eq('church_id', church).order('created_at'),
      sb.from('fin_categories').select('id, kind, name, active').eq('church_id', church).order('name'),
    ]);
    if (a.error) throw a.error;
    if (c.error) throw c.error;
    return { accounts: a.data, categories: c.data };
  };
  const base = await get();
  if (base.accounts.length && base.categories.length) return base;
  const { error } = await sb.rpc('finance_setup', { p_church: church });
  if (error) throw error;
  return get();
}

async function loadFinanceMonth(key) {
  const church = state.church.id;
  const [base, e, b, m] = await Promise.all([
    loadFinanceBase(),
    sb
      .from('fin_entries')
      .select('id, kind, entry_date, amount_cents, account_id, to_account_id, category_id, description')
      .eq('church_id', church)
      .is('deleted_at', null)
      .gte('entry_date', `${key}-01`)
      .lte('entry_date', monthEnd(key))
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false }),
    sb.rpc('finance_balances', { p_church: church, p_until: monthEnd(key) }),
    sb.from('fin_months').select('closed_at, note').eq('church_id', church).eq('month', `${key}-01`).maybeSingle(),
  ]);
  for (const r of [e, b, m]) if (r.error) throw r.error;
  return {
    ...base,
    entries: e.data,
    balances: Object.fromEntries(b.data.map((x) => [x.account_id, x.balance_cents])),
    closed_at: m.data?.closed_at || null,
    note: m.data?.note || null,
  };
}

// Quanto um lançamento muda o saldo de cada conta (sign = -1 desfaz).
function applyEntry(balances, e, sign) {
  const add = (id, v) => id && (balances[id] = (balances[id] || 0) + sign * v);
  if (e.kind === 'entrada') add(e.account_id, e.amount_cents);
  else if (e.kind === 'saida') add(e.account_id, -e.amount_cents);
  else {
    add(e.account_id, -e.amount_cents);
    add(e.to_account_id, e.amount_cents);
  }
}

async function viewFinance(ctx) {
  const key = monthParam(ctx);
  if (!requireTreasury('/financeiro')) return;
  await screenShow(ctx, `financeiro:${key}`, () => loadFinanceMonth(key), (d) => drawFinance(key, d));
}

function drawFinance(key, d) {
  const acc = Object.fromEntries(d.accounts.map((a) => [a.id, a]));
  const cat = Object.fromEntries(d.categories.map((c) => [c.id, c]));
  const total = (kind) => d.entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.amount_cents, 0);
  const balance = (a) => d.balances[a.id] ?? a.opening_cents;
  const accounts = d.accounts.filter((a) => a.active || balance(a));
  const closed = !!d.closed_at;
  const sign = { entrada: '+ ', saida: '− ', transferencia: '' };
  const row = (e) => {
    const title = e.kind === 'transferencia' ? `${acc[e.account_id]?.name} → ${acc[e.to_account_id]?.name}` : cat[e.category_id]?.name;
    const sub = e.description || (e.kind === 'transferencia' ? 'Transferência entre contas' : acc[e.account_id]?.name);
    const link = `
          <a class="fin-row ${closed ? '' : 'swipe-row'}" href="#/financeiro/${e.id}?mes=${key}" draggable="false">
            <span class="fin-day">${e.entry_date.slice(8)}</span>
            <span class="fin-text"><strong>${esc(title || '')}</strong><small>${esc(sub || '')}</small></span>
            <strong class="fin-amount ${e.kind}">${sign[e.kind]}${fmtMoney(e.amount_cents)}</strong>
          </a>`;
    return closed
      ? link
      : `<div class="swipe" data-id="${e.id}"><span class="swipe-bg" aria-hidden="true">${icon.trash} Apagar</span>${link}</div>`;
  };
  $view.innerHTML = `
    <div class="page">
      <h1>Financeiro</h1>
      <nav class="month-nav" aria-label="Mês">
        <a class="btn small" href="#/financeiro?mes=${monthShift(key, -1)}" aria-label="Mês anterior">‹</a>
        <strong>${finMonthLabel(key)}</strong>
        <a class="btn small" href="#/financeiro?mes=${monthShift(key, 1)}" aria-label="Próximo mês">›</a>
      </nav>
      ${
        closed
          ? `<p class="notice">Mês fechado e publicado em ${esc(new Date(d.closed_at).toLocaleDateString('pt-BR'))}: os lançamentos dele não mudam mais.${
              d.note ? `<br>Recado: ${esc(d.note)}` : ''
            }</p>`
          : ''
      }
      <div class="stat-grid">
        <div class="stat-tile"><span class="stat-label">Entradas</span><strong class="fin-amount entrada">${fmtMoney(total('entrada'))}</strong></div>
        <div class="stat-tile"><span class="stat-label">Saídas</span><strong class="fin-amount saida">${fmtMoney(total('saida'))}</strong></div>
        <div class="stat-tile"><span class="stat-label">Resultado do mês</span><strong>${fmtMoney(total('entrada') - total('saida'))}</strong></div>
      </div>
      <h2>Saldo em ${fmtDate(monthEnd(key))}</h2>
      <div class="fin-balances">
        ${accounts.map((a) => `<div><span>${esc(a.name)}</span><strong>${fmtMoney(balance(a))}</strong></div>`).join('')}
        <div class="total"><span>Total</span><strong>${fmtMoney(accounts.reduce((s, a) => s + balance(a), 0))}</strong></div>
      </div>
      <h2>Lançamentos</h2>
      ${
        d.entries.length
          ? `${closed ? '' : '<p class="hint swipe-hint">Arraste um lançamento para a esquerda para apagar.</p>'}
             <div class="list" id="fin-entries">${d.entries.map(row).join('')}</div>
             ${closed ? '' : '<p><button type="button" class="btn danger-outline" id="fin-clear">Apagar os lançamentos do mês</button></p>'}`
          : `<div class="empty"><p>Nenhum lançamento neste mês.${closed ? '' : ' Toque no <strong>+</strong> para lançar uma entrada, uma saída ou uma transferência.'}</p></div>`
      }
      <h2>Prestação de contas</h2>
      <div class="actions-row">
        ${
          closed
            ? `<a class="btn" href="#/prestacao/${key}">Ver a prestação de contas</a>
               <button type="button" class="btn" id="fin-reopen">Reabrir o mês</button>`
            : key <= monthKey()
              ? `<button type="button" class="btn primary" id="fin-close">Fechar e publicar o mês</button>
                 <a class="btn" href="#/prestacao/${key}">Prévia</a>`
              : ''
        }
      </div>
      <p class="hint">${
        closed
          ? 'Os membros veem os totais deste mês em Menu &gt; Prestação de contas. Para corrigir um lançamento, reabra o mês: ele sai da prestação até você fechar de novo.'
          : 'Ao fechar, os lançamentos do mês ficam travados e os membros recebem um aviso para ver os totais por categoria (nunca os lançamentos nem as descrições).'
      }</p>
      <h2>Planilhas</h2>
      <div class="actions-row">
        <button type="button" class="btn" id="fin-csv" ${d.entries.length ? '' : 'disabled'}>${icon.upload} Baixar planilha do mês</button>
        <a class="btn" href="#/financeiro/importar">Importar planilha</a>
      </div>
      <p><a class="btn" href="#/financeiro/config">Contas e categorias</a></p>
      ${
        closed
          ? ''
          : fabMenu('Adicionar lançamentos', [
              [`#/financeiro/novo?mes=${key}`, 'Novo lançamento'],
              ['#/financeiro/importar', 'Importar planilha'],
            ])
      }
    </div>`;

  // Apagar o mês inteiro (ex.: uma planilha importada errada), com "Desfazer". Como no arrastar,
  // fica guardado no banco (deleted_at); o banco recusa se o mês estiver fechado.
  document.getElementById('fin-clear')?.addEventListener('click', async () => {
    const n = d.entries.length;
    const what = n === 1 ? 'o lançamento' : `os ${n} lançamentos`;
    if (!await ask(`Apagar ${what} de ${finMonthLabel(key)}? ${n === 1 ? 'Ele sai' : 'Eles saem'} dos totais e dos saldos.`)) return;
    const { data, error } = await sb
      .from('fin_entries')
      .update({ deleted_at: new Date().toISOString() })
      .eq('church_id', state.church.id)
      .is('deleted_at', null)
      .gte('entry_date', `${key}-01`)
      .lte('entry_date', monthEnd(key))
      .select('id');
    if (error) return toast(errorText(error), 'error');
    const ids = data.map((x) => x.id);
    forgetFinance();
    render();
    toast(ids.length === 1 ? '1 lançamento apagado.' : `${ids.length} lançamentos apagados.`, '', {
      label: 'Desfazer',
      run: async () => {
        for (let i = 0; i < ids.length; i += 100) {
          const { error: err } = await sb.from('fin_entries').update({ deleted_at: null }).in('id', ids.slice(i, i + 100));
          if (err) return toast(errorText(err), 'error');
        }
        forgetFinance();
        if (location.hash.startsWith('#/financeiro')) render();
      },
    });
  });

  // Planilha do mês no mesmo formato do modelo de importar (abre no Excel; serve para o contador).
  document.getElementById('fin-csv').onclick = () => {
    const lines = [...d.entries]
      .reverse()
      .map((e) => [
        fmtDate(e.entry_date),
        FIN_KIND_CSV[e.kind],
        fmtMoney(e.amount_cents).replace(/R\$\s?/, ''),
        cat[e.category_id]?.name,
        acc[e.account_id]?.name,
        acc[e.to_account_id]?.name,
        e.description,
      ]);
    downloadFile(`financeiro-${slugify(state.church.name)}-${key}.csv`, csvText([FINANCE_CSV_HEADER, ...lines]), 'text/csv;charset=utf-8');
  };

  // Fechar e publicar (com um recado opcional) e reabrir: só a tesouraria, conferido no banco.
  const changed = (msg) => {
    forgetFinance();
    screenForget('prestacao');
    screenForget(`prestacao:${key}`);
    toast(msg);
    render();
  };
  document.getElementById('fin-close')?.addEventListener('click', async () => {
    const note = await ask(
      `Fechar e publicar ${finMonthLabel(key)}? Os lançamentos do mês ficam travados e todos os membros veem os totais na Prestação de contas. Se quiser, deixe um recado (opcional):`,
      { input: 'text', ok: 'Fechar e publicar', placeholder: 'Ex.: reforma do telhado concluída' },
    );
    if (note === null) return;
    const { error } = await sb.rpc('finance_close_month', { p_church: state.church.id, p_month: `${key}-01`, p_note: note.trim() || null });
    if (error) return toast(errorText(error), 'error');
    changed('Mês fechado e publicado.');
  });
  document.getElementById('fin-reopen')?.addEventListener('click', async () => {
    if (!await ask(`Reabrir ${finMonthLabel(key)}? Ele sai da Prestação de contas até você fechar de novo.`, { ok: 'Reabrir' })) return;
    const { error } = await sb.rpc('finance_reopen_month', { p_church: state.church.id, p_month: `${key}-01` });
    if (error) return toast(errorText(error), 'error');
    changed('Mês reaberto.');
  });

  const list = document.getElementById('fin-entries');
  if (!list || closed) return;
  // Apagado fica guardado no banco (deleted_at): o "Desfazer" só limpa a data.
  const name = `financeiro:${key}`;
  const setDeleted = async (e, at) => {
    const { data, error } = await sb.from('fin_entries').update({ deleted_at: at }).eq('id', e.id).select('id');
    if (error) throw error;
    if (!data.length) throw new Error('Você não tem permissão para isso.');
    const now = screenCached(name) || d;
    const balances = { ...now.balances };
    applyEntry(balances, e, at ? -1 : 1);
    const entries = at ? now.entries.filter((x) => x.id !== e.id) : [...now.entries, e].sort((a, b) => b.entry_date.localeCompare(a.entry_date));
    const next = { ...now, entries, balances };
    screenUpdate(name, next);
    screenForget(`financeiro-lanc:${e.id}`);
    if (location.hash.startsWith('#/financeiro?') || location.hash === '#/financeiro') drawFinance(key, next);
  };
  swipeLeft(list, async (wrap) => {
    const e = d.entries.find((x) => x.id === wrap.dataset.id);
    try {
      await setDeleted(e, new Date().toISOString());
    } catch (err) {
      toast(errorText(err), 'error');
      return false;
    }
    toast('Lançamento apagado.', '', { label: 'Desfazer', run: () => setDeleted(e, null).catch((err) => toast(errorText(err), 'error')) });
    return true;
  });
}

// Um lançamento (com as contas e as categorias para o formulário) e se o mês dele está fechado.
async function loadFinanceEntry(id) {
  const base = await loadFinanceBase();
  if (!id) return base;
  const { data: entry, error } = await sb
    .from('fin_entries')
    .select('id, kind, entry_date, amount_cents, account_id, to_account_id, category_id, description')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!entry) return { ...base, entry: null };
  const { data: month, error: err } = await sb
    .from('fin_months')
    .select('closed_at')
    .eq('church_id', state.church.id)
    .eq('month', `${entry.entry_date.slice(0, 7)}-01`)
    .maybeSingle();
  if (err) throw err;
  return { ...base, entry, closed_at: month?.closed_at || null };
}

async function viewFinanceEntry(ctx, id) {
  const key = monthParam(ctx);
  if (!requireTreasury(id ? `/financeiro/${id}` : '/financeiro/novo')) return;
  const name = id ? `financeiro-lanc:${id}` : 'financeiro-base';
  // Vindo da lista do mês: já tem tudo o que o formulário precisa.
  const month = screenCached(`financeiro:${key}`);
  const fromList = id && month?.entries.find((e) => e.id === id);
  if (month && !screenCached(name) && (!id || fromList)) {
    screenUpdate(name, { accounts: month.accounts, categories: month.categories, ...(id ? { entry: fromList, closed_at: month.closed_at } : {}) });
  }
  await screenShow(ctx, name, () => loadFinanceEntry(id), (d) => drawFinanceEntry(key, id, d));
}

function drawFinanceEntry(key, id, d) {
  const e = id ? d.entry : null;
  if (id && !e) {
    $view.innerHTML = `<div class="empty"><h2>Lançamento não encontrado</h2><p>Ele pode ter sido apagado.</p><a class="btn" href="#/financeiro?mes=${key}">Voltar</a></div>`;
    return;
  }
  const closed = !!d.closed_at;
  const today = isoLocal(new Date());
  const day = e?.entry_date || (key === monthKey() ? today : key < monthKey() ? monthEnd(key) : `${key}-01`);
  const options = (list, selected) =>
    list.map((x) => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const accounts = d.accounts.filter((a) => a.active || a.id === e?.account_id || a.id === e?.to_account_id);
  $view.innerHTML = `
    <form id="fin-entry" class="form page">
      <a href="#/financeiro?mes=${key}" class="back">← Financeiro</a>
      <h1>${id ? 'Lançamento' : 'Novo lançamento'}</h1>
      ${closed ? '<p class="notice">Este mês está fechado: o lançamento não pode mudar.</p>' : ''}
      <fieldset>
        <legend>Tipo</legend>
        ${Object.entries(FIN_KINDS)
          .map(([k, label]) => `<label class="check"><input type="radio" name="kind" value="${k}" ${k === (e?.kind || 'entrada') ? 'checked' : ''}> ${label}</label>`)
          .join('')}
      </fieldset>
      <label>Data<input name="entry_date" type="date" required min="2000-01-01" value="${esc(day)}"></label>
      <label>Valor (R$)<input name="amount" required inputmode="decimal" placeholder="0,00" autocomplete="off"
        value="${e ? esc(fmtMoney(e.amount_cents).replace(/R\$\s?/, '')) : ''}"></label>
      <label><span id="account-label">Conta</span><select name="account_id" required>${options(accounts, e?.account_id)}</select></label>
      <label id="to-box">Para a conta<select name="to_account_id">${options(accounts, e?.to_account_id || accounts[1]?.id)}</select></label>
      <label id="category-box">Categoria<select name="category_id"></select></label>
      <label>Descrição (opcional)<input name="description" maxlength="200" value="${esc(e?.description || '')}" placeholder="Ex.: culto de domingo, conta de luz"></label>
      ${closed ? '' : `<button class="btn primary big">${id ? 'Salvar' : 'Lançar'}</button>`}
      ${id && !closed ? '<button type="button" class="btn danger-outline" id="delete">Apagar lançamento</button>' : ''}
    </form>`;

  const form = document.getElementById('fin-entry');
  if (closed) form.querySelectorAll('input, select').forEach((el) => (el.disabled = true));
  const kind = () => form.querySelector('[name=kind]:checked').value;
  const sync = () => {
    const transfer = kind() === 'transferencia';
    document.getElementById('to-box').hidden = !transfer;
    document.getElementById('category-box').hidden = transfer;
    document.getElementById('account-label').textContent = transfer ? 'Da conta' : 'Conta';
    form.to_account_id.required = transfer;
    form.category_id.required = !transfer;
    const cats = d.categories.filter((c) => c.kind === kind() && (c.active || c.id === e?.category_id));
    form.category_id.innerHTML = options(cats, form.category_id.value || e?.category_id);
  };
  form.querySelectorAll('[name=kind]').forEach((r) => r.addEventListener('change', sync));
  sync();

  const done = (msg, month) => {
    forgetFinance();
    toast(msg);
    navigate(`/financeiro?mes=${month}`);
  };
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const reais = parseAmount(form.amount.value);
    if (!reais) return toast('Confira o valor.', 'error');
    const transfer = kind() === 'transferencia';
    if (transfer && form.account_id.value === form.to_account_id.value) return toast('Escolha duas contas diferentes.', 'error');
    const row = {
      kind: kind(),
      entry_date: form.entry_date.value,
      amount_cents: Math.round(reais * 100),
      account_id: form.account_id.value,
      to_account_id: transfer ? form.to_account_id.value : null,
      category_id: transfer ? null : form.category_id.value,
      description: form.description.value.trim() || null,
    };
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = id
      ? await sb.from('fin_entries').update(row).eq('id', id).select('id')
      : await sb.from('fin_entries').insert({ ...row, church_id: state.church.id }).select('id');
    if (error || !data.length) {
      btn.disabled = false;
      return toast(errorText(error || new Error('Você não tem permissão para isso.')), 'error');
    }
    done(id ? 'Lançamento salvo.' : 'Lançamento feito.', row.entry_date.slice(0, 7));
  });

  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask('Apagar este lançamento? Ele sai dos totais e dos saldos.')) return;
    const { data, error } = await sb.from('fin_entries').update({ deleted_at: new Date().toISOString() }).eq('id', id).select('id');
    if (error || !data.length) return toast(errorText(error || new Error('Você não tem permissão para isso.')), 'error');
    done('Lançamento apagado.', e.entry_date.slice(0, 7));
  });
}

async function viewFinanceConfig(ctx) {
  if (!requireTreasury('/financeiro/config')) return;
  await screenShow(ctx, 'financeiro-base', loadFinanceBase, (d) => drawFinanceConfig(ctx, d));
}

function drawFinanceConfig(ctx, d) {
  const item = (type, x, extra = '') => `
    <div class="fin-config-row ${x.active ? '' : 'inactive'}">
      <span><strong>${esc(x.name)}</strong>${extra}${x.active ? '' : '<small>Desativada</small>'}</span>
      <button type="button" class="btn small" data-edit="${type}:${x.id}">Editar</button>
      <button type="button" class="btn small" data-active="${type}:${x.id}">${x.active ? 'Desativar' : 'Reativar'}</button>
    </div>`;
  const cats = (kind) => d.categories.filter((c) => c.kind === kind).map((c) => item('categoria', c)).join('');
  $view.innerHTML = `
    <div class="page">
      <a href="#/financeiro" class="back">← Financeiro</a>
      <h1>Contas e categorias</h1>
      <h2>Contas</h2>
      <p class="hint">O saldo inicial é o que a conta tinha antes do primeiro lançamento no app.</p>
      <div class="list">${d.accounts.map((a) => item('conta', a, `<small>Saldo inicial: ${fmtMoney(a.opening_cents)}</small>`)).join('')}</div>
      <button type="button" class="btn" data-new="conta">${icon.plus} Nova conta</button>
      <h2>Categorias de entrada</h2>
      <div class="list">${cats('entrada')}</div>
      <button type="button" class="btn" data-new="entrada">${icon.plus} Nova categoria de entrada</button>
      <h2>Categorias de saída</h2>
      <div class="list">${cats('saida')}</div>
      <button type="button" class="btn" data-new="saida">${icon.plus} Nova categoria de saída</button>
      <p class="hint">Desativar tira a conta ou a categoria dos novos lançamentos; os antigos continuam com ela.</p>
    </div>`;

  const table = (type) => (type === 'conta' ? 'fin_accounts' : 'fin_categories');
  const find = (ref) => {
    const [type, id] = ref.split(':');
    return [type, (type === 'conta' ? d.accounts : d.categories).find((x) => x.id === id)];
  };
  const save = async (query) => {
    const { data, error } = await query.select('id');
    if (error || !data.length) return toast(errorText(error || new Error('Você não tem permissão para isso.')), 'error');
    forgetFinance();
    const fresh = await loadFinanceBase();
    screenUpdate('financeiro-base', fresh);
    if (ctx.alive()) drawFinanceConfig(ctx, fresh);
  };
  // Saldo inicial: aceita negativo ("-150,00").
  const askOpening = async (cents) => {
    const raw = await ask('Saldo inicial da conta (R$)', { input: 'text', value: fmtMoney(cents).replace(/R\$\s?/, ''), ok: 'Salvar' });
    if (raw === null) return null;
    const minus = /^\s*-/.test(raw);
    const reais = parseAmount(raw.replace('-', ''));
    if (reais === null) {
      toast('Confira o valor.', 'error');
      return null;
    }
    return (minus ? -1 : 1) * Math.round(reais * 100);
  };
  $view.querySelectorAll('[data-new]').forEach((b) =>
    b.addEventListener('click', async () => {
      const type = b.dataset.new;
      const name = (await ask(type === 'conta' ? 'Nome da nova conta' : `Nova categoria de ${type === 'entrada' ? 'entrada' : 'saída'}`, { input: 'text', ok: 'Criar' }))?.trim();
      if (!name) return;
      if (type === 'conta') {
        const opening = await askOpening(0);
        if (opening === null) return;
        return save(sb.from('fin_accounts').insert({ church_id: state.church.id, name, opening_cents: opening }));
      }
      save(sb.from('fin_categories').insert({ church_id: state.church.id, kind: type, name }));
    }),
  );
  $view.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', async () => {
      const [type, x] = find(b.dataset.edit);
      const name = (await ask('Nome', { input: 'text', value: x.name, ok: 'Salvar' }))?.trim();
      if (!name) return;
      const patch = { name };
      if (type === 'conta') {
        const opening = await askOpening(x.opening_cents);
        if (opening === null) return;
        patch.opening_cents = opening;
      }
      save(sb.from(table(type)).update(patch).eq('id', x.id));
    }),
  );
  $view.querySelectorAll('[data-active]').forEach((b) =>
    b.addEventListener('click', () => {
      const [type, x] = find(b.dataset.active);
      save(sb.from(table(type)).update({ active: !x.active }).eq('id', x.id));
    }),
  );
}

// Importar lançamentos de uma planilha (mesmo formato do modelo e da planilha do mês). O app
// confere tudo antes; o banco grava todas as linhas de uma vez (ou nenhuma) e confere de novo.
async function viewFinanceImport(ctx) {
  if (!requireTreasury('/financeiro/importar')) return;
  await screenShow(ctx, 'financeiro-base', loadFinanceBase, (d) => drawFinanceImport(ctx, d));
}

function drawFinanceImport(ctx, d) {
  const names = (list) => list.filter((x) => x.active).map((x) => esc(x.name)).join(', ');
  $view.innerHTML = `
    <div class="page">
      <a href="#/financeiro" class="back">← Financeiro</a>
      <h1>Importar planilha</h1>
      <div class="card">
        <p>Use uma planilha com as colunas <strong>data</strong>, <strong>tipo</strong> (entrada, saída ou transferência), <strong>valor</strong>, <strong>categoria</strong>, <strong>conta</strong>, <strong>conta_destino</strong> (só na transferência) e <strong>descricao</strong> na primeira linha.</p>
        <p class="hint">No Excel ou no Google Planilhas, salve como <strong>CSV</strong>. Datas como 05/10/2026 e valores como 1.250,00. Uma linha igual a um lançamento que já existe é pulada: importar a mesma planilha de novo não duplica nada.</p>
        <p class="hint"><strong>Contas:</strong> ${names(d.accounts)}.<br><strong>Categorias de entrada:</strong> ${names(d.categories.filter((c) => c.kind === 'entrada'))}.<br><strong>Categorias de saída:</strong> ${names(d.categories.filter((c) => c.kind === 'saida'))}.<br>Escreva os nomes como aqui (maiúsculas e acentos não importam). Para usar outro nome, crie antes em <a href="#/financeiro/config">Contas e categorias</a>.</p>
        <div class="actions-row">
          <button class="btn small" id="template">Baixar modelo</button>
          <label class="btn primary small">Escolher arquivo CSV<input type="file" id="file" accept=".csv,text/csv,text/plain" hidden></label>
        </div>
      </div>
      <div id="preview"></div>
    </div>`;

  document.getElementById('template').onclick = () => downloadFile('modelo-financeiro.csv', FINANCE_CSV_TEMPLATE, 'text/csv;charset=utf-8');

  document.getElementById('file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const box = document.getElementById('preview');
    box.innerHTML = '<div class="loading">Conferindo…</div>';
    try {
      const text = await readTextFile(file);
      const first = parseFinanceCsv(text, d);
      if (first.error) {
        box.innerHTML = `<div class="notice warn-box">${esc(first.error)}</div>`;
        return;
      }
      // Meses fechados e lançamentos que já existem nos dias da planilha.
      const days = first.rows.map((r) => r.entry_date).filter(Boolean).sort();
      const existing = new Map();
      const closedMonths = new Set();
      if (days.length) {
        const [e, m] = await Promise.all([
          sb
            .from('fin_entries')
            .select('kind, entry_date, amount_cents, account_id, to_account_id, category_id, description')
            .eq('church_id', state.church.id)
            .is('deleted_at', null)
            .gte('entry_date', days[0])
            .lte('entry_date', days.at(-1))
            .limit(10000),
          sb.from('fin_months').select('month').eq('church_id', state.church.id).not('closed_at', 'is', null),
        ]);
        if (e.error) throw e.error;
        if (m.error) throw m.error;
        for (const x of e.data) existing.set(financeKey(x), (existing.get(financeKey(x)) || 0) + 1);
        for (const x of m.data) closedMonths.add(x.month.slice(0, 7));
      }
      if (!ctx.alive()) return;
      drawImportPreview(box, parseFinanceCsv(text, { ...d, existing, closedMonths }).rows);
    } catch (err) {
      box.innerHTML = `<div class="notice warn-box">${esc(errorText(err))}</div>`;
    }
  });
}

function drawImportPreview(box, rows) {
  const ok = rows.filter((r) => !r.errors.length && !r.skip);
  const bad = rows.filter((r) => r.errors.length);
  const skipped = rows.filter((r) => r.skip);
  const total = (kind) => ok.filter((r) => r.kind === kind).reduce((s, r) => s + r.amount_cents, 0);
  const tooMany = ok.length > IMPORT_MAX;
  box.innerHTML = `
    <div class="card">
      <h2>${ok.length} ${ok.length === 1 ? 'lançamento pronto' : 'lançamentos prontos'} para importar</h2>
      ${ok.length ? `<p>Entradas: <strong>${fmtMoney(total('entrada'))}</strong> · Saídas: <strong>${fmtMoney(total('saida'))}</strong></p>` : ''}
      ${skipped.length ? `<p class="hint">${skipped.length} ${skipped.length === 1 ? 'linha pulada: já foi lançada' : 'linhas puladas: já foram lançadas'}.</p>` : ''}
      ${bad.length ? `<p class="hint warn">${bad.length} ${bad.length === 1 ? 'linha com erro não será importada' : 'linhas com erro não serão importadas'}. Corrija na planilha e importe de novo: o que já entrou é pulado.</p>` : ''}
      ${tooMany ? `<p class="hint warn">Até ${IMPORT_MAX} lançamentos por planilha. Divida em mais de uma.</p>` : ''}
      <div class="table-wrap">
        <table class="preview-table">
          <thead><tr><th>Linha</th><th>Situação</th><th>Data</th><th>Tipo</th><th>Valor</th><th>Categoria e conta</th><th>Descrição</th></tr></thead>
          <tbody>
            ${rows
              .slice(0, 300)
              .map(
                (r) => `
              <tr class="${r.errors.length ? 'bad' : r.skip ? 'skip' : ''}">
                <td>${r.line}</td><td>${esc(r.errors.join(', ') || r.skip || 'ok')}</td>
                <td>${esc(fmtDate(r.entry_date))}</td><td>${esc(FIN_KINDS[r.kind] || '')}</td>
                <td>${r.amount_cents ? esc(fmtMoney(r.amount_cents)) : ''}</td><td>${esc(r.label)}</td><td>${esc(r.description || '')}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
        ${rows.length > 300 ? '<p class="hint">Mostrando as primeiras 300 linhas.</p>' : ''}
      </div>
      ${ok.length && !tooMany ? `<button class="btn primary big" id="do-import">Importar ${ok.length} ${ok.length === 1 ? 'lançamento' : 'lançamentos'}</button>` : ''}
    </div>`;

  document.getElementById('do-import')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Importando…';
    // Uma gravação só: se o banco recusar uma linha, nenhuma entra.
    const { error } = await sb.from('fin_entries').insert(
      ok.map((r) => ({
        church_id: state.church.id,
        kind: r.kind,
        entry_date: r.entry_date,
        amount_cents: r.amount_cents,
        account_id: r.account_id,
        to_account_id: r.to_account_id,
        category_id: r.category_id,
        description: r.description,
      })),
    );
    if (error) {
      btn.disabled = false;
      btn.textContent = `Importar ${ok.length} ${ok.length === 1 ? 'lançamento' : 'lançamentos'}`;
      return toast(`Nada foi importado: ${errorText(error)}`, 'error');
    }
    forgetFinance();
    toast(`${ok.length} ${ok.length === 1 ? 'lançamento importado' : 'lançamentos importados'}.`);
    navigate(`/financeiro?mes=${ok.map((r) => r.entry_date).sort()[0].slice(0, 7)}`);
  });
}

// ---------------------------------------------------------------------
// Prestação de contas: todos os membros veem os meses que a tesouraria fechou e publicou, só
// com os totais por categoria (finance_published e finance_report), nunca os lançamentos.
// ---------------------------------------------------------------------
async function loadPublished() {
  const { data, error } = await sb.rpc('finance_published', { p_church: state.church.id });
  if (error) throw error;
  return data;
}

async function viewAccountability(ctx) {
  if (!requireMemberFeature('/prestacao', 'financeiro')) return;
  await screenShow(ctx, 'prestacao', loadPublished, drawAccountability);
}

function drawAccountability(months) {
  $view.innerHTML = `
    <div class="page">
      <h1>Prestação de contas</h1>
      <p class="hint">O que entrou e o que saiu em cada mês, publicado pela tesouraria da igreja.</p>
      ${
        months.length
          ? `<div class="list">${months
              .map((m) => {
                const key = m.month.slice(0, 7);
                return `
          <a class="menu-row fin-month" href="#/prestacao/${key}">
            ${icon.wallet}
            <span><strong>${finMonthLabel(key)}</strong><small>Entradas ${fmtMoney(m.in_cents)} · Saídas ${fmtMoney(m.out_cents)}</small></span>
            ${icon.chevron}
          </a>`;
              })
              .join('')}</div>`
          : '<div class="empty"><p>A tesouraria ainda não publicou nenhuma prestação de contas.</p></div>'
      }
      ${treasury() ? '<p><a class="btn" href="#/financeiro">Ir para o Financeiro</a></p>' : ''}
    </div>`;
}

// Mês não publicado: o banco recusa (a tesouraria vê a prévia).
async function loadAccountabilityMonth(key) {
  const { data, error } = await sb.rpc('finance_report', { p_church: state.church.id, p_month: `${key}-01` });
  if (error?.code === '42501') return { missing: true };
  if (error) throw error;
  return data;
}

async function viewAccountabilityMonth(ctx, key) {
  if (!requireMemberFeature(`/prestacao/${key}`, 'financeiro')) return;
  await screenShow(ctx, `prestacao:${key}`, () => loadAccountabilityMonth(key), (r) => drawAccountabilityMonth(key, r));
}

function drawAccountabilityMonth(key, r) {
  if (r.missing) {
    $view.innerHTML = `<div class="empty"><h2>Prestação de contas não publicada</h2><p>A tesouraria ainda não publicou ${finMonthLabel(key)}.</p><a class="btn" href="#/prestacao">Voltar</a></div>`;
    return;
  }
  const items = (kind) => r.categories.filter((c) => c.kind === kind);
  const sum = (kind) => items(kind).reduce((s, c) => s + c.cents, 0);
  const inC = sum('entrada');
  const outC = sum('saida');
  const result = inC - outC;
  const day = (iso) => new Date(iso).toLocaleDateString('pt-BR');
  const logo = state.church.logo_url;
  // Cada categoria com uma barra do tamanho da sua parte no total (legível também em preto e branco).
  const column = (kind, title, empty) => {
    const total = sum(kind);
    const of = kind === 'entrada' ? 'das entradas' : 'das saídas';
    return `
      <section class="acc-col ${kind}">
        <h2>${title}</h2>
        ${
          items(kind).length
            ? `${items(kind)
                .map((c) => {
                  const pct = Math.round((c.cents / total) * 100);
                  return `
            <div class="acc-cat">
              <div class="acc-cat-row"><span>${esc(c.name)}</span><strong>${fmtMoney(c.cents)}</strong></div>
              <div class="acc-bar" aria-hidden="true"><i style="--w:${Math.max(pct, 1)}%"></i></div>
              <small>${pct}% ${of}</small>
            </div>`;
                })
                .join('')}
             <div class="acc-col-total"><span>Total</span><strong>${fmtMoney(total)}</strong></div>`
            : `<p class="hint">${empty}</p>`
        }
      </section>`;
  };
  $view.innerHTML = `
    <div class="page acc-page">
      <a href="#/prestacao" class="back no-print">← Prestação de contas</a>
      ${r.published_at ? '' : '<p class="notice no-print">Prévia: este mês ainda não foi publicado. Só a tesouraria vê.</p>'}
      <article class="acc-sheet">
        <header class="acc-head">
          ${logo ? `<img class="acc-logo" src="${esc(logo)}" alt="" width="56" height="56">` : ''}
          <div>
            <p class="acc-church">${esc(state.church.name)}</p>
            <h1>Prestação de contas <span>${finMonthLabel(key)}</span></h1>
            <p class="acc-sub">${r.published_at ? `Publicada pela tesouraria em ${esc(day(r.published_at))}` : 'Prévia: ainda não publicada'}</p>
          </div>
        </header>
        <div class="acc-totals">
          <div class="acc-total entrada"><span>Entradas</span><strong>${fmtMoney(inC)}</strong></div>
          <div class="acc-total saida"><span>Saídas</span><strong>${fmtMoney(outC)}</strong></div>
          <div class="acc-total ${result < 0 ? 'neg' : 'pos'}"><span>Resultado</span><strong>${fmtMoney(result)}</strong></div>
        </div>
        <div class="acc-balance">
          <span>Saldo no início do mês<strong>${fmtMoney(r.opening_cents)}</strong></span>
          <span class="acc-arrow" aria-hidden="true">→</span>
          <span>Saldo no fim do mês<strong>${fmtMoney(r.opening_cents + result)}</strong></span>
        </div>
        <div class="acc-cols">
          ${column('entrada', 'Entradas', 'Nenhuma entrada neste mês.')}
          ${column('saida', 'Saídas', 'Nenhuma saída neste mês.')}
        </div>
        ${r.note ? `<blockquote class="acc-note"><strong>Recado da tesouraria</strong><p>${esc(r.note)}</p></blockquote>` : ''}
        <p class="acc-privacy">Só os totais por categoria. Os dízimos e as ofertas não identificam quem deu.</p>
        <div class="acc-signs">
          <div><span class="acc-line"></span>Tesouraria<small>Data: ____/____/________</small></div>
          <div><span class="acc-line"></span>Pastor(a) responsável<small>Data: ____/____/________</small></div>
        </div>
        <footer class="acc-foot">Gerado pelo app da ${esc(state.church.name)} em ${esc(day(Date.now()))}.</footer>
      </article>
      <div class="acc-actions no-print">
        <button type="button" class="btn primary big" id="print">${icon.print} Imprimir ou salvar PDF</button>
        <p class="hint">Sai numa folha A4, com espaço para as assinaturas. No celular, escolha <strong>Salvar como PDF</strong> para mandar no grupo da igreja.</p>
      </div>
    </div>`;
  document.getElementById('print').onclick = () => printAs(`Prestação de contas - ${state.church.name} - ${finMonthLabel(key)}`);
}

// ---------------------------------------------------------------------
// Galeria de fotos: álbuns só para os membros; publicam a liderança e o ministério marcado
// ---------------------------------------------------------------------
const GALLERY_LIMIT = 300; // o banco confere (gallery_limit)
const galleryTeam = () => featureOn('galeria') && (isLeaderRole(myRole()) || (isActiveMember() && !!myMember().gallery_team));

// Links das fotos da galeria (válidos por 1 hora), guardados em memória por 50 minutos.
const galleryLinks = new Map();
async function galleryUrls(paths) {
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const p of paths) {
    const hit = galleryLinks.get(p);
    if (hit && hit.until > now) out[p] = hit.url;
    else missing.push(p);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const { data, error } = await sb.storage.from('galeria').createSignedUrls(missing.slice(i, i + 100), 3600);
    if (error) continue;
    for (const d of data) {
      if (!d.signedUrl) continue;
      galleryLinks.set(d.path, { url: d.signedUrl, until: now + 50 * 60 * 1000 });
      out[d.path] = d.signedUrl;
    }
  }
  return out;
}
const knownGallery = (paths) => {
  const now = Date.now();
  return Object.fromEntries(paths.map((p) => [p, galleryLinks.get(p)]).filter(([, h]) => h && h.until > now).map(([p, h]) => [p, h.url]));
};

// Desenha na hora com os links já conhecidos e de novo quando os que faltam chegam.
async function showWithGalleryLinks(ctx, name, fetcher, pathsOf, draw) {
  await screenShow(ctx, name, fetcher, (data) => draw(data, knownGallery(pathsOf(data))));
  const data = screenCached(name);
  if (!data || !ctx.alive()) return;
  const paths = pathsOf(data);
  if (paths.every((p) => knownGallery([p])[p])) return;
  const urls = await galleryUrls(paths).catch(() => ({}));
  if (ctx.alive()) draw(data, urls);
}

const thumb = (url, alt = '') => (url ? `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy">` : '<span class="thumb-wait" aria-hidden="true"></span>');

async function loadAlbums() {
  const { data, error } = await sb.rpc('gallery_album_list', { p_church: state.church.id });
  if (error) throw error;
  return data;
}

async function viewGallery(ctx) {
  if (!requireMemberFeature('/galeria', 'galeria')) return;
  await showWithGalleryLinks(ctx, 'galeria', loadAlbums, (all) => all.map((a) => a.cover_mini).filter(Boolean), drawGallery);
}

function drawGallery(albums, urls) {
  const team = galleryTeam();
  const used = albums.reduce((n, a) => n + a.photos, 0);
  $view.innerHTML = `
    <div class="page">
      <h1>Galeria</h1>
      ${
        team
          ? `<p class="hint ${used >= GALLERY_LIMIT * 0.9 ? 'warn' : ''}">${used} de ${GALLERY_LIMIT} fotos usadas${used >= GALLERY_LIMIT * 0.9 ? '. Apague álbuns antigos para liberar espaço.' : '.'}</p>`
          : ''
      }
      ${
        albums.length
          ? `<div class="album-grid">${albums
              .map(
                (a) => `
          <a class="album-card" href="#/galeria/${a.id}">
            <span class="album-cover">${thumb(a.cover_mini && urls[a.cover_mini], a.title)}</span>
            <strong>${esc(a.title)}</strong>
            <small>${esc(fmtDate(a.album_date))} · ${a.photos} ${a.photos === 1 ? 'foto' : 'fotos'}</small>
          </a>`,
              )
              .join('')}</div>`
          : `<div class="empty"><p>Nenhum álbum ainda.${team ? ' Toque no <strong>+</strong> para criar o primeiro.' : ''}</p></div>`
      }
      <p class="hint">As fotos são vistas só por quem é da igreja. Se você aparece numa foto e prefere que ela saia, abra a foto e toque em <em>Pedir para tirar esta foto</em>.</p>
      ${team ? fab('#/galeria/novo', 'Novo álbum') : ''}
    </div>`;
}

async function loadAlbum(id) {
  const [albumRes, photosRes] = await Promise.all([
    sb.from('gallery_albums').select('id, title, album_date, description, cover_photo_id').eq('id', id).maybeSingle(),
    sb.from('gallery_photos').select('id, path, mini_path').eq('album_id', id).order('created_at'),
  ]);
  if (albumRes.error) throw albumRes.error;
  if (photosRes.error) throw photosRes.error;
  return { album: albumRes.data, photos: photosRes.data };
}
const forgetAlbum = (id) => {
  screenForget('galeria');
  screenForget(`album:${id}`);
};

async function viewAlbum(ctx, id) {
  if (!requireMemberFeature(`/galeria/${id}`, 'galeria')) return;
  await showWithGalleryLinks(ctx, `album:${id}`, () => loadAlbum(id), (d) => d.photos.map((p) => p.mini_path), (d, urls) => drawAlbum(ctx, id, d, urls));
}

function drawAlbum(ctx, id, { album, photos }, urls) {
  if (!album) {
    $view.innerHTML = `<div class="empty"><h2>Álbum não encontrado</h2><a class="btn" href="#/galeria">Voltar</a></div>`;
    return;
  }
  const team = galleryTeam();
  $view.innerHTML = `
    <div class="page">
      <a href="#/galeria" class="back">← Galeria</a>
      <h1>${esc(album.title)}</h1>
      <p class="hint">${esc(fmtDate(album.album_date))} · ${photos.length} ${photos.length === 1 ? 'foto' : 'fotos'}</p>
      ${album.description ? `<p class="pre">${esc(album.description)}</p>` : ''}
      ${
        team
          ? `<div class="actions-row">
              <label class="btn primary">${icon.upload} Adicionar fotos<input type="file" id="add-photos" accept="image/*" multiple hidden></label>
              <a class="btn" href="#/galeria/${id}/editar">Editar álbum</a>
            </div>
            <p class="hint" id="upload-status" aria-live="polite"></p>`
          : ''
      }
      ${
        photos.length
          ? `<div class="photo-grid">${photos
              .map((p, i) => `<a class="photo-thumb" href="#/galeria/${id}/foto/${p.id}" aria-label="Foto ${i + 1} de ${photos.length}">${thumb(urls[p.mini_path])}</a>`)
              .join('')}</div>`
          : `<div class="empty"><p>Nenhuma foto neste álbum.</p></div>`
      }
    </div>`;

  document.getElementById('add-photos')?.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const status = document.getElementById('upload-status');
    const input = e.target;
    input.disabled = true;
    let sent = 0;
    let stop = null;
    for (const [i, file] of files.entries()) {
      if (status) status.textContent = `Reduzindo e enviando ${i + 1} de ${files.length}…`;
      try {
        await uploadGalleryPhoto(id, file);
        sent++;
      } catch (err) {
        stop = errorText(err);
        if (/limite/.test(stop)) break;
      }
    }
    forgetAlbum(id);
    if (stop) toast(sent ? `${sent} ${sent === 1 ? 'foto enviada' : 'fotos enviadas'}. ${stop}` : stop, 'error');
    else toast(`${sent} ${sent === 1 ? 'foto enviada' : 'fotos enviadas'}.`);
    if (ctx.alive()) render();
  });
}

// Reduz no aparelho, registra no banco (que confere o limite) e envia a foto e a miniatura.
async function uploadGalleryPhoto(albumId, file) {
  const { big, mini, ext } = await resizeForGallery(file);
  const { data, error } = await sb.rpc('gallery_add_photo', { p_album: albumId, p_ext: ext });
  if (error) throw error;
  const [row] = data;
  const bucket = sb.storage.from('galeria');
  try {
    for (const [path, blob] of [[row.path, big], [row.mini_path, mini]]) {
      const { error: err } = await bucket.upload(path, blob, { contentType: blob.type, cacheControl: '3600' });
      if (err) throw err;
    }
  } catch (err) {
    await bucket.remove([row.path, row.mini_path]).catch(() => {});
    await sb.from('gallery_photos').delete().eq('id', row.photo_id);
    throw err;
  }
}

async function removeGalleryFiles(photos) {
  const paths = photos.flatMap((p) => [p.path, p.mini_path]);
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await sb.storage.from('galeria').remove(paths.slice(i, i + 100));
    if (error) throw error;
  }
}

// Foto em tela cheia: passar para o lado, baixar, compartilhar, pedir para tirar.
async function viewGalleryPhoto(ctx, albumId, photoId) {
  if (!requireMemberFeature(`/galeria/${albumId}/foto/${photoId}`, 'galeria')) return;
  await showWithGalleryLinks(
    ctx,
    `album:${albumId}`,
    () => loadAlbum(albumId),
    (d) => {
      const p = d.photos.find((x) => x.id === photoId);
      return p ? [p.path, p.mini_path] : [];
    },
    (d, urls) => drawGalleryPhoto(ctx, albumId, photoId, d, urls),
  );
}

function drawGalleryPhoto(ctx, albumId, photoId, { album, photos }, urls) {
  const i = photos.findIndex((p) => p.id === photoId);
  if (!album || i < 0) {
    $view.innerHTML = `<div class="empty"><h2>Foto não encontrada</h2><p>Ela pode ter sido apagada.</p><a class="btn" href="#/galeria/${albumId}">Voltar ao álbum</a></div>`;
    return;
  }
  const p = photos[i];
  const prev = photos[i - 1];
  const next = photos[i + 1];
  const team = galleryTeam();
  const src = urls[p.path] || urls[p.mini_path];
  $view.innerHTML = `
    <div class="page photo-view">
      <a href="#/galeria/${albumId}" class="back">← ${esc(album.title)}</a>
      <div class="photo-stage" id="stage">
        ${src ? `<img src="${esc(src)}" alt="Foto ${i + 1} de ${photos.length}">` : '<span class="thumb-wait big" aria-hidden="true"></span>'}
        ${prev ? `<a class="photo-nav prev" href="#/galeria/${albumId}/foto/${prev.id}" aria-label="Foto anterior">‹</a>` : ''}
        ${next ? `<a class="photo-nav next" href="#/galeria/${albumId}/foto/${next.id}" aria-label="Próxima foto">›</a>` : ''}
      </div>
      <p class="hint center">${i + 1} de ${photos.length}</p>
      <div class="actions-row">
        <button class="btn" id="share">Compartilhar</button>
        <button class="btn" id="download">${icon.upload} Baixar</button>
      </div>
      ${
        team
          ? `<div class="actions-row">
              ${album.cover_photo_id === p.id ? '<span class="tag ok">Capa do álbum</span>' : '<button class="btn small" id="cover">Usar como capa</button>'}
              <button class="btn small danger-outline" id="delete">Apagar foto</button>
            </div>`
          : ''
      }
      <button class="btn link" id="takedown">Pedir para tirar esta foto</button>
    </div>`;

  // Arrastar para o lado troca de foto.
  const stage = document.getElementById('stage');
  let startX = null;
  stage.addEventListener('touchstart', (e) => (startX = e.touches[0].clientX), { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    const to = dx < -50 ? next : dx > 50 ? prev : null;
    if (to) navigate(`/galeria/${albumId}/foto/${to.id}`);
  });

  const fileOf = async () => {
    const url = (await galleryUrls([p.path]))[p.path];
    if (!url) throw new Error('Sem conexão. Tente de novo.');
    const blob = await (await fetch(url)).blob();
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([blob], `${slugify(album.title)}-${i + 1}.${ext}`, { type: blob.type });
  };
  document.getElementById('download').onclick = async () => {
    try {
      const file = await fileOf();
      const url = URL.createObjectURL(file);
      const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };
  document.getElementById('share').onclick = async () => {
    try {
      const file = await fileOf();
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: album.title });
      else document.getElementById('download').click();
    } catch (err) {
      if (err?.name !== 'AbortError') toast(errorText(err), 'error');
    }
  };
  document.getElementById('takedown').onclick = async () => {
    const reason = await ask('Pedir para tirar esta foto: quem publica a galeria recebe o pedido. Quer dizer o motivo? (opcional)', {
      input: 'text',
      ok: 'Enviar pedido',
      placeholder: 'Motivo (opcional)',
    });
    if (reason === null) return;
    const { data, error } = await sb.rpc('gallery_request_removal', { p_photo: p.id, p_reason: reason.trim().slice(0, 300) });
    if (error) return toast(errorText(error), 'error');
    toast(data ? 'Pedido enviado. Obrigado por avisar.' : 'Você já pediu para tirar esta foto.');
  };
  document.getElementById('cover')?.addEventListener('click', async () => {
    const { data, error } = await sb.from('gallery_albums').update({ cover_photo_id: p.id }).eq('id', albumId).select('id');
    if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para isso.', 'error');
    forgetAlbum(albumId);
    toast('Capa do álbum trocada.');
    render();
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask('Apagar esta foto? Não dá para desfazer.')) return;
    try {
      await removeGalleryFiles([p]);
      const { data, error } = await sb.from('gallery_photos').delete().eq('id', p.id).select('id');
      if (error || !data.length) throw error || new Error('Você não tem permissão para isso.');
    } catch (err) {
      return toast(errorText(err), 'error');
    }
    forgetAlbum(albumId);
    toast('Foto apagada.');
    navigate(next ? `/galeria/${albumId}/foto/${next.id}` : prev ? `/galeria/${albumId}/foto/${prev.id}` : `/galeria/${albumId}`);
  });
}

async function viewAlbumForm(ctx, id) {
  if (!requireMemberFeature(id ? `/galeria/${id}/editar` : '/galeria/novo', 'galeria')) return;
  if (!galleryTeam()) return navigate('/galeria');
  let a = { title: '', album_date: isoLocal(new Date()), description: '' };
  let photos = [];
  if (id) {
    const data = await editItem(ctx, screenCached(`album:${id}`), () => loadAlbum(id), () => forgetAlbum(id));
    if (!data?.album) return navigate('/galeria');
    a = data.album;
    photos = data.photos;
  }
  if (!ctx.alive()) return;
  $view.innerHTML = `
    <form id="album" class="form page">
      <a href="${id ? `#/galeria/${id}` : '#/galeria'}" class="back">← ${id ? esc(a.title) : 'Galeria'}</a>
      <h1>${id ? 'Editar álbum' : 'Novo álbum'}</h1>
      <label>Título<input name="title" required minlength="2" maxlength="80" value="${esc(a.title)}" placeholder="Batismo de outubro"></label>
      <label>Data<input name="album_date" type="date" required value="${esc(a.album_date)}"></label>
      <label>Descrição (opcional)<textarea name="description" rows="3" maxlength="500">${esc(a.description || '')}</textarea></label>
      ${id ? '' : '<p class="hint">Depois de criar, abra o álbum e toque em <em>Adicionar fotos</em>. As fotos são reduzidas no celular antes do envio, para gastar pouco espaço.</p>'}
      <button class="btn primary big">${id ? 'Salvar' : 'Criar álbum'}</button>
      ${id ? `<button class="btn danger-outline" type="button" id="delete">Apagar o álbum e as ${photos.length} fotos</button>` : ''}
    </form>`;
  const form = document.getElementById('album');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = { title: form.title.value.trim(), album_date: form.album_date.value, description: form.description.value.trim() || null };
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = id
      ? await sb.from('gallery_albums').update(row).eq('id', id).select('id').single()
      : await sb.from('gallery_albums').insert({ ...row, church_id: state.church.id }).select('id').single();
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    forgetAlbum(data.id);
    toast(id ? 'Álbum salvo.' : 'Álbum criado. Agora adicione as fotos.');
    navigate(`/galeria/${data.id}`);
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask(`Apagar o álbum "${a.title}" e as ${photos.length} fotos? Não dá para desfazer.`)) return;
    try {
      await removeGalleryFiles(photos);
      const { data, error } = await sb.from('gallery_albums').delete().eq('id', id).select('id');
      if (error || !data.length) throw error || new Error('Você não tem permissão para isso.');
    } catch (err) {
      return toast(errorText(err), 'error');
    }
    forgetAlbum(id);
    toast('Álbum apagado.');
    navigate('/galeria');
  });
}

// ---------------------------------------------------------------------
// Chat 1 a 1 dentro da igreja (supabase/021). Só as duas pessoas leem; as mensagens ficam
// só na memória do aparelho (nunca gravadas). Tempo real pelo canal particular "user:<id>".
// ---------------------------------------------------------------------
const chatOn = () => featureOn('chat') && isActiveMember();
let chatUnread = 0;
let chatChannel = null;
let chatListen = 0;
let chatOpen = null; // conversa aberta na tela: { id, ctx, c, messages, paint, read }
const openConversation = () => (chatOpen?.ctx.alive() ? chatOpen.id : null);

function updateChatBadge() {
  const link = document.getElementById('chat-link');
  const badge = document.getElementById('chat-badge');
  if (!link || !badge) return;
  link.hidden = !(state.church && chatOn());
  badge.hidden = !chatUnread;
  badge.textContent = chatUnread > 9 ? '9+' : String(chatUnread);
  link.setAttribute('aria-label', chatUnread ? `Conversas: ${chatUnread} não lidas` : 'Conversas');
}

// Número no ícone do chat. Uma resposta mais antiga nunca sobrescreve uma contagem mais nova.
let chatUnreadTurn = 0;
async function refreshChatUnread() {
  if (!state.church || !chatOn()) {
    chatUnread = 0;
    return updateChatBadge();
  }
  const turn = ++chatUnreadTurn;
  const { data, error } = await sb.rpc('chat_unread_count', { p_church: state.church.id });
  if (turn !== chatUnreadTurn || error) return;
  chatUnread = data || 0;
  updateChatBadge();
}

// O banco manda cada mensagem para o canal particular de cada participante; só a própria
// pessoa entra no seu canal (regra em realtime.messages).
async function listenChat() {
  const turn = ++chatListen;
  if (chatChannel) sb.removeChannel(chatChannel);
  chatChannel = null;
  if (!state.user || !state.church || !chatOn()) return;
  const { data } = await sb.auth.getSession();
  if (turn !== chatListen || !state.user) return;
  if (data.session) sb.realtime.setAuth(data.session.access_token);
  let initial = true;
  chatChannel = sb
    .channel(`user:${state.user.id}`, { config: { private: true } })
    .on('broadcast', { event: 'message' }, ({ payload: m }) => {
      // A mesma pessoa pode estar em outra igreja: aqui só conta a desta página.
      if (m.church_id !== state.church?.id) return;
      window.dispatchEvent(new CustomEvent('chat-message', { detail: m }));
      if (m.sender_id === state.user?.id || m.conversation_id === openConversation()) return;
      screenForget('chat');
      refreshChatUnread();
      if (location.hash === '#/chat') render();
      else if (!location.hash.startsWith('#/chat')) toast('Nova mensagem no chat.');
    })
    .subscribe((status) => {
      // (Re)conectou, por exemplo depois de a rede cair: busca o que pode ter passado.
      if (status !== 'SUBSCRIBED') return;
      window.dispatchEvent(new CustomEvent('chat-resync', { detail: { initial } }));
      initial = false;
    });
}

// No celular a conexão cai com o app em segundo plano: ao voltar, ou quando chega um aviso,
// busca o que chegou nesse meio-tempo.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.church) return;
  if (!openConversation()) refreshChatUnread();
  window.dispatchEvent(new Event('chat-resync'));
});
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type !== 'push') return;
  const here = openConversation() && e.data.url?.endsWith(`/chat/${openConversation()}`) && document.visibilityState === 'visible';
  if (!here) refreshChatUnread();
  window.dispatchEvent(new Event('chat-resync'));
});
window.addEventListener('chat-resync', (e) => {
  if (e.detail?.initial || location.hash !== '#/chat') return;
  screenForget('chat');
  render();
});

function requireChat(next) {
  if (!requireMemberFeature(next, 'chat')) return false;
  return true;
}

const chatClock = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const chatDay = (iso) => {
  const day = isoLocal(new Date(iso));
  if (day === isoLocal(new Date())) return 'Hoje';
  if (day === isoLocal(addDays(new Date(), -1))) return 'Ontem';
  return new Date(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
};

async function loadChats() {
  const { data, error } = await sb.rpc('my_conversations', { p_church: state.church.id });
  if (error) throw error;
  return data;
}

async function viewChats(ctx) {
  if (!requireChat('/chat')) return;
  await screenShowWithPhotos(ctx, 'chat', loadChats, (rows) => rows.map((c) => c.other_photo), (rows, photos) => drawChats(rows, photos));
  refreshChatUnread();
}

function drawChats(rows, photos) {
  const leader = isLeaderRole(myRole());
  $view.innerHTML = `
    <div class="page chat-page">
      <h1>Conversas</h1>
      ${
        rows.length
          ? `<p class="hint swipe-hint">Arraste uma conversa para a esquerda para apagar.</p>
             <div class="chat-list">${rows
              .map(
                (c) => `
          <div class="swipe" data-id="${c.id}">
            <span class="swipe-bg" aria-hidden="true">${icon.trash} Apagar</span>
            <a class="chat-row swipe-row ${c.unread ? 'unread' : ''}" href="#/chat/${c.id}" draggable="false">
              ${avatar(c.other_name, c.other_photo && photos[miniOf(c.other_photo)])}
              <span class="chat-text">
                <strong>${esc(c.other_name)}</strong>
                <span class="chat-last">${c.blocked ? '🚫 Conversa bloqueada' : `${c.last_mine ? 'Você: ' : ''}${esc(c.last_message || '')}`}</span>
              </span>
              <time datetime="${esc(c.last_message_at)}">${esc(notifTime(c.last_message_at))}</time>
            </a>
          </div>`,
              )
              .join('')}</div>`
          : `<div class="empty"><h2>Nenhuma conversa ainda</h2><p>${
              leader ? 'Toque no <strong>+</strong> para escrever para alguém da igreja.' : 'Toque no <strong>+</strong> para escrever para um pastor, um líder ou a secretaria.'
            }</p></div>`
      }
      <p class="hint">As conversas são só entre as duas pessoas: ninguém mais lê, nem a liderança da igreja.</p>
      ${fab('#/chat/nova', leader ? 'Nova conversa' : 'Falar com a liderança')}
    </div>`;
  const list = $view.querySelector('.chat-list');
  // Apagou a última: mostra a tela vazia.
  if (list) swipeLeft(list, (wrap) => hideConversation(wrap.dataset.id), () => location.hash === '#/chat' && render());
}

// Apaga a conversa só para quem apagou (a regra fica no banco: hide_conversation, SQL 025),
// com "Desfazer" no aviso. Devolve false se o banco recusou.
async function hideConversation(id) {
  const { error } = await sb.rpc('hide_conversation', { p_conv: id });
  if (error) {
    toast(errorText(error), 'error');
    return false;
  }
  const forget = () => {
    screenForget('chat');
    screenForget(`conversa:${id}`);
  };
  forget();
  refreshChatUnread();
  toast('Conversa apagada.', '', {
    label: 'Desfazer',
    run: async () => {
      const { error: undo } = await sb.rpc('hide_conversation', { p_conv: id, p_hide: false });
      if (undo) return toast(errorText(undo), 'error');
      forget();
      refreshChatUnread();
      if (location.hash === '#/chat') render();
    },
  });
  return true;
}

// Arrastar para a esquerda (.swipe > .swipe-row): passando de 35% da largura, onSwipe(wrap) age
// (apaga, inativa…; devolve true, e com false a linha volta ao lugar). Se não sobrou nenhuma
// linha, chama onEmpty. A rolagem vertical continua normal.
function swipeLeft(list, onSwipe, onEmpty) {
  let row = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dragging = false;
  list.addEventListener('pointerdown', (e) => {
    row = e.button === 0 ? e.target.closest('.swipe-row') : null;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    dragging = false;
  });
  list.addEventListener('pointermove', (e) => {
    if (!row) return;
    const x = e.clientX - startX;
    const y = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) return void (row = null); // está rolando a lista
      if (x > -10) return;
      dragging = true;
      row.setPointerCapture(e.pointerId);
      row.classList.add('dragging');
    }
    dx = Math.min(0, x);
    row.style.transform = `translateX(${dx}px)`;
  });
  const end = async () => {
    if (!row) return;
    const r = row;
    row = null;
    r.classList.remove('dragging');
    if (!dragging) return;
    setTimeout(() => (dragging = false)); // depois do clique que o soltar dispara
    if (-dx < r.offsetWidth * 0.35) return void (r.style.transform = '');
    const wrap = r.closest('.swipe');
    r.style.transform = 'translateX(-100%)';
    wrap.classList.add('removing');
    if (await onSwipe(wrap)) {
      wrap.hidden = true;
      if (!list.querySelector('.swipe:not([hidden])')) onEmpty?.();
    } else {
      wrap.classList.remove('removing');
      r.style.transform = '';
    }
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
  // Soltar depois de arrastar não abre o item.
  list.addEventListener('click', (e) => dragging && e.preventDefault(), true);
}

// Escolher com quem conversar: a liderança que recebe mensagens e, com busca, outras pessoas.
// Todos com quem a pessoa pode conversar (a liderança chama qualquer membro; o membro chama a
// liderança e, se a igreja ligou, os outros membros). A regra fica no banco.
async function loadChatContacts() {
  const { data, error } = await sb.rpc('chat_contacts', { p_church: state.church.id, p_all: true });
  if (error) throw error;
  return data;
}

async function viewChatNew(ctx) {
  if (!requireChat('/chat/nova')) return;
  await screenShowWithPhotos(ctx, 'chat-contatos', loadChatContacts, (rows) => rows.map((p) => p.photo_path), (rows, photos) =>
    drawChatNew(ctx, rows, photos),
  );
}

function drawChatNew(ctx, people, photos) {
  const leader = isLeaderRole(myRole());
  // A busca e o texto digitado continuam ao redesenhar (fotos que chegaram, banco que respondeu).
  const typed = document.getElementById('chat-search')?.q.value || '';
  const row = (p) => `
    <button type="button" class="member-row chat-person" data-start="${p.member_id}" data-name="${esc(fold(p.name))}">
      ${avatar(p.name, p.photo_path && photos[miniOf(p.photo_path)])}<span><strong>${esc(p.name)}</strong><small>${esc(ROLES[p.role])}</small></span>${icon.chevron}
    </button>`;
  const leaders = people.filter((p) => isLeaderRole(p.role));
  const members = people.filter((p) => !isLeaderRole(p.role));
  const section = (title, list) =>
    list.length ? `<section class="chat-people"><h2 class="notif-day">${title}</h2><div class="list">${list.map(row).join('')}</div></section>` : '';
  $view.innerHTML = `
    <div class="page chat-page">
      <a href="#/chat" class="back">← Conversas</a>
      <h1>${leader ? 'Nova conversa' : 'Falar com a liderança'}</h1>
      <form id="chat-search" class="form"><label class="search">${icon.search}<input name="q" type="search" placeholder="Buscar pelo nome" aria-label="Buscar pessoa" autocomplete="off" value="${esc(typed)}"></label></form>
      ${
        people.length
          ? `${section('Liderança', leaders)}${section('Membros', members)}
             <p class="hint center" id="chat-none" hidden>Ninguém com esse nome (ou a pessoa não recebe mensagens).</p>`
          : '<div class="empty"><p>Ninguém está recebendo mensagens agora.</p></div>'
      }
    </div>`;
  $view.querySelectorAll('[data-start]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      const { data: id, error } = await sb.rpc('start_conversation', { p_church: state.church.id, p_member: b.dataset.start });
      b.disabled = false;
      if (error) return toast(errorText(error), 'error');
      navigate(`/chat/${id}`);
    };
  });
  // Busca no aparelho: filtra a lista enquanto digita (sem acento e sem diferença de maiúsculas).
  const form = document.getElementById('chat-search');
  const filter = () => {
    const term = fold(form.q.value.trim());
    let shown = 0;
    $view.querySelectorAll('.chat-person').forEach((b) => {
      b.hidden = !!term && !b.dataset.name.includes(term);
      if (!b.hidden) shown++;
    });
    $view.querySelectorAll('.chat-people').forEach((s) => (s.hidden = !s.querySelector('.chat-person:not([hidden])')));
    const none = document.getElementById('chat-none');
    if (none) none.hidden = shown > 0;
  };
  form.addEventListener('submit', (e) => e.preventDefault());
  form.q.addEventListener('input', filter);
  if (typed) filter();
}


async function loadConversation(id) {
  const [info, msgs] = await Promise.all([
    sb.rpc('my_conversations', { p_church: state.church.id, p_conv: id }),
    sb.from('messages').select('id, sender_id, body, created_at').eq('conversation_id', id).order('created_at', { ascending: false }).limit(300),
  ]);
  if (info.error) throw info.error;
  if (msgs.error) throw msgs.error;
  return { c: info.data?.[0] ?? null, messages: msgs.data.reverse() };
}

// No Início, junto com a lista: as mensagens das conversas mais recentes (uma busca só), para a
// conversa abrir na hora. Só na memória (PRIVATE_SCREENS); ao abrir, a tela confere com o banco.
const CHAT_PREFETCH = 8;
async function prefetchConversations(rows) {
  const top = (rows || []).slice(0, CHAT_PREFETCH).filter((c) => !screenCached(`conversa:${c.id}`));
  if (!top.length) return;
  const { data, error } = await sb
    .from('messages')
    .select('id, conversation_id, sender_id, body, created_at')
    .in('conversation_id', top.map((c) => c.id))
    .order('created_at', { ascending: false })
    .limit(60 * top.length);
  if (error) return;
  for (const c of top) {
    const messages = data
      .filter((m) => m.conversation_id === c.id)
      .reverse()
      .map(({ conversation_id, ...m }) => m);
    if (!screenCached(`conversa:${c.id}`)) screenUpdate(`conversa:${c.id}`, { c, messages });
  }
}

async function viewConversation(ctx, id) {
  if (!requireChat(`/chat/${id}`)) return;
  await screenShowWithPhotos(
    ctx,
    `conversa:${id}`,
    () => loadConversation(id),
    (d) => [d.c?.other_photo],
    (d, photos) => drawConversation(ctx, id, d, photos),
  );
  // O guardado na memória pode ser de minutos atrás: busca o que chegou depois.
  if (ctx.alive()) window.dispatchEvent(new Event('chat-resync'));
}

function drawConversation(ctx, id, data, photos) {
  const c = data.c;
  if (!c) {
    chatOpen = null;
    $view.innerHTML = `<div class="empty"><h2>Conversa não encontrada</h2><a class="btn" href="#/chat">Ver conversas</a></div>`;
    return;
  }
  // Redesenho da mesma conversa (o banco respondeu): mantém o que ainda está "enviando…".
  // (Sem as que o banco já trouxe gravadas: mesma pessoa, mesmo texto, de lá para cá.)
  const saved = (p) =>
    data.messages.some((m) => m.sender_id === p.sender_id && m.body === p.body && Date.parse(m.created_at) >= Date.parse(p.created_at) - 60000);
  const pending = chatOpen?.id === id && chatOpen.ctx === ctx ? chatOpen.messages.filter((m) => m.pending && !saved(m)) : [];
  const messages = [...data.messages.filter((m) => !pending.some((p) => p.id === m.id)), ...pending];
  let draft = '';
  try {
    draft = document.getElementById('chat-form')?.body.value || sessionStorage.getItem(`chat-rascunho-${id}`) || '';
    sessionStorage.removeItem(`chat-rascunho-${id}`);
  } catch {}

  $view.innerHTML = `
    <div class="chat-view">
      <div class="chat-head">
        <a href="#/chat" class="chat-back" aria-label="Voltar para as conversas">${icon.chevron}</a>
        ${avatar(c.other_name, c.other_photo && photos[miniOf(c.other_photo)])}
        <span class="chat-text"><strong>${esc(c.other_name)}</strong>${c.other_role ? `<small>${esc(ROLES[c.other_role])}</small>` : ''}</span>
        <details class="chat-menu">
          <summary aria-label="Mais opções">⋯</summary>
          <div class="chat-menu-box">
            ${
              c.blocked
                ? c.blocked_by_me
                  ? '<button type="button" data-unblock>Desbloquear conversa</button>'
                  : ''
                : '<button type="button" data-block>Bloquear conversa</button>'
            }
            <button type="button" data-report>Denunciar</button>
            <button type="button" data-hide>Apagar conversa</button>
          </div>
        </details>
      </div>
      <div class="chat-msgs" id="chat-msgs" aria-live="polite"></div>
      ${
        c.can_send
          ? `<form class="chat-input" id="chat-form">
              <textarea name="body" rows="1" maxlength="2000" placeholder="Escreva uma mensagem" aria-label="Mensagem" required>${esc(draft)}</textarea>
              <button class="btn primary" aria-label="Enviar">${icon.send}</button>
            </form>
            <div id="chat-push"></div>`
          : `<p class="notice chat-closed">${
              c.blocked
                ? c.blocked_by_me
                  ? 'Você bloqueou esta conversa. Para escrever de novo, toque em ⋯ e em Desbloquear.'
                  : 'Esta conversa foi bloqueada pela outra pessoa.'
                : 'Não dá para enviar mensagens nesta conversa agora.'
            }</p>`
      }
    </div>`;

  const box = document.getElementById('chat-msgs');
  const paint = () => {
    let lastDay = '';
    box.innerHTML = messages.length
      ? messages
          .map((m) => {
            const day = chatDay(m.created_at);
            const sep = day !== lastDay ? `<div class="chat-day">${esc(day)}</div>` : '';
            lastDay = day;
            return `${sep}<div class="msg ${m.sender_id === state.user.id ? 'mine' : ''} ${m.pending ? 'pending' : ''}">
              <p>${esc(m.body).replace(/\n/g, '<br>')}</p><time>${m.pending ? 'enviando…' : esc(chatClock(m.created_at))}</time></div>`;
          })
          .join('')
      : `<p class="hint chat-empty">Nenhuma mensagem ainda. Escreva a primeira.</p>`;
    window.scrollTo(0, document.body.scrollHeight);
  };
  // Guarda só na memória o que a tela já tem (nunca no aparelho: PRIVATE_SCREENS).
  const remember = () => screenUpdate(`conversa:${id}`, { c, messages: messages.filter((m) => !m.pending) });
  const read = () =>
    sb.rpc('mark_conversation_read', { p_conv: id }).then(() => {
      screenForget('chat');
      refreshChatUnread();
    });
  chatOpen = { id, ctx, c, messages, paint, read, remember };
  paint();
  if (c.unread || messages.some((m) => m.sender_id !== state.user.id)) read();

  const form = document.getElementById('chat-form');
  if (form) {
    const input = form.body;
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    };
    input.addEventListener('input', grow);
    grow();
    // Enter envia no computador; no celular o Enter quebra a linha e envia pelo botão.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      const temp = { id: `tmp-${Date.now()}`, sender_id: state.user.id, body, created_at: new Date().toISOString(), pending: true };
      const first = !messages.some((m) => m.sender_id === state.user.id);
      messages.push(temp);
      input.value = '';
      grow();
      paint();
      const { data: saved, error } = await sb.from('messages').insert({ conversation_id: id, body }).select('id, sender_id, body, created_at').single();
      // A tela pode ter sido redesenhada enquanto enviava (o banco respondeu): usa a lista atual.
      const v = chatOpen?.id === id && chatOpen.ctx === ctx ? chatOpen : { messages, paint, remember };
      const i = v.messages.findIndex((x) => x.id === temp.id);
      if (error) {
        if (i >= 0) v.messages.splice(i, 1);
        const box = document.getElementById('chat-form')?.body;
        if (box && !box.value) box.value = body;
        v.paint();
        return toast(errorText(error), 'error');
      }
      if (i >= 0) {
        if (v.messages.some((x) => x.id === saved.id)) v.messages.splice(i, 1); // o tempo real chegou antes
        else v.messages[i] = saved;
      } else if (!v.messages.some((x) => x.id === saved.id)) {
        v.messages.push(saved);
      }
      v.paint();
      v.remember();
      screenForget('chat');
      if (first) pushInvite(document.getElementById('chat-push'), { title: 'Quer saber quando responderem?', note: 'Ative as notificações neste celular.' }).catch(() => {});
    });
    if (draft) input.focus();
  }

  const menu = $view.querySelector('.chat-menu');
  const act = async (fn, args, done) => {
    menu.open = false;
    const { error } = await sb.rpc(fn, args);
    if (error) return toast(errorText(error), 'error');
    screenForget('chat');
    screenForget(`conversa:${id}`);
    toast(done);
    render();
  };
  menu.querySelector('[data-block]')?.addEventListener('click', async () => {
    if (await ask('Bloquear esta conversa? Ninguém mais escreve nela até você desbloquear.')) act('chat_block', { p_conv: id, p_block: true }, 'Conversa bloqueada.');
  });
  menu.querySelector('[data-unblock]')?.addEventListener('click', () => act('chat_block', { p_conv: id, p_block: false }, 'Conversa desbloqueada.'));
  menu.querySelector('[data-report]').addEventListener('click', async () => {
    menu.open = false;
    const reason = await ask(
      'Denunciar: a conversa é bloqueada e o administrador da igreja recebe um aviso com os nomes e o motivo. As mensagens não são mostradas a ele. Qual o motivo?',
      { input: 'text', ok: 'Denunciar', placeholder: 'Motivo' },
    );
    if (reason === null) return;
    act('chat_report', { p_conv: id, p_reason: reason.trim().slice(0, 500) }, 'Denúncia enviada. A conversa foi bloqueada.');
  });
  // O mesmo que arrastar na lista, para quem usa teclado ou leitor de tela.
  menu.querySelector('[data-hide]').addEventListener('click', async () => {
    menu.open = false;
    if (!await ask('Apagar esta conversa? Ela some só para você; a outra pessoa continua vendo.')) return;
    if (await hideConversation(id)) navigate('/chat');
  });
}

// Mensagens novas da conversa aberta (da outra pessoa ou de outro aparelho meu).
window.addEventListener('chat-message', (e) => {
  const v = chatOpen;
  const m = e.detail;
  if (!v || !v.ctx.alive() || m.conversation_id !== v.id || v.messages.some((x) => x.id === m.id)) return;
  v.messages.push(m);
  v.paint();
  v.remember();
  if (m.sender_id !== state.user.id) v.read();
});
// Mensagens que chegaram sem o tempo real (app em segundo plano, conexão caída).
let chatSyncing = false;
window.addEventListener('chat-resync', async () => {
  const v = chatOpen;
  if (!v || !v.ctx.alive() || chatSyncing) return;
  chatSyncing = true;
  try {
    const last = v.messages.filter((m) => !m.pending).at(-1)?.created_at;
    let q = sb.from('messages').select('id, sender_id, body, created_at').eq('conversation_id', v.id).order('created_at').limit(200);
    if (last) q = q.gt('created_at', last);
    const { data } = await q;
    const fresh = (data || []).filter((m) => !v.messages.some((x) => x.id === m.id));
    if (!v.ctx.alive() || !fresh.length) return void refreshChatUnread();
    v.messages.push(...fresh);
    v.messages.sort((a, b) => !!a.pending - !!b.pending || a.created_at.localeCompare(b.created_at));
    v.paint();
    v.remember();
    if (fresh.some((m) => m.sender_id !== state.user.id)) v.read();
  } finally {
    chatSyncing = false;
  }
});

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

function weekBirthdaysCard(el, changed) {
  const today = new Date();
  const todayIso = isoLocal(today);
  // Guarda junto o dia: o guardado de outro dia não vale.
  const load = async () => ({ day: todayIso, rows: await fetchBirthdays(todayIso, isoLocal(addDays(today, 6))) });
  const html = (data, minis = {}) => {
    const rows = data.day === todayIso ? data.rows : [];
    if (!rows.length) return '';
    const anyToday = rows.some((r) => r.on_date === todayIso);
    return `
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
  };
  // As fotos chegam depois (links temporários): primeiro com as iniciais, depois com as fotos.
  return homeCard(el, 'semana', load, html, changed).then(async () => {
    const data = screenCached('semana');
    const rows = data?.day === todayIso ? data.rows : [];
    if (!rows.some((r) => r.photo_path)) return;
    const minis = await signedPhotos(rows.filter((r) => r.photo_path).map((r) => miniOf(r.photo_path))).catch(() => ({}));
    const out = html(data, minis);
    if (el.isConnected && out) {
      el.innerHTML = out;
      changed();
    }
  });
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
  await screenShowWithPhotos(
    ctx,
    `mes:${y}-${m}`,
    () => fetchBirthdays(isoLocal(first), isoLocal(last)),
    (rows) => rows.map((r) => r.photo_path),
    (rows, minis) => drawBirthdays(rows, minis, y, m),
  );
}

function drawBirthdays(rows, minis, y, m) {
  const now = new Date();
  const month = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const leader = isLeaderRole(myRole());
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.on_date)) byDay.set(r.on_date, []);
    byDay.get(r.on_date).push(r);
  }
  const todayIso = isoLocal(now);

  $view.innerHTML = `
    <div class="page birthdays-page sheet">
      ${sheetHead('Aniversariantes de', `${MONTHS[m - 1]} de ${y}`)}
      <nav class="month-nav no-print" aria-label="Mês">
        <a class="btn small" href="#/aniversariantes?mes=${month(new Date(y, m - 2, 1))}" aria-label="Mês anterior">‹</a>
        <strong>${MONTHS[m - 1]} de ${y}</strong>
        <a class="btn small" href="#/aniversariantes?mes=${month(new Date(y, m, 1))}" aria-label="Próximo mês">›</a>
      </nav>
      <p class="hint no-print">${
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
      ${sheetFoot()}
      <button class="fab no-print" id="print" aria-label="Imprimir ou salvar PDF" title="Imprimir ou salvar PDF">${icon.print}</button>
    </div>`;
  document.getElementById('print').onclick = () => printAs(`Aniversariantes - ${state.church.name} - ${MONTHS[m - 1]} de ${y}`);
}

// Grupos da central: cada um com ícone, cor (css .k-<grupo>) e os tipos que reúne.
const NOTIF_GROUPS = {
  avisos: { label: 'Avisos', icon: 'megaphone', kinds: ['aviso'], on: () => featureOn('avisos') },
  agenda: { label: 'Agenda', icon: 'calendar', kinds: ['evento', 'inscricao'], on: () => featureOn('agenda') },
  oracao: { label: 'Oração', icon: 'heart', kinds: ['oracao'], on: () => featureOn('oracao') },
  escalas: { label: 'Escalas', icon: 'clipboard', kinds: ['escala'], on: () => featureOn('escalas') },
  infantil: { label: 'Infantil', icon: 'child', kinds: ['infantil'], on: () => featureOn('infantil') },
  galeria: { label: 'Galeria', icon: 'image', kinds: ['galeria'], on: () => galleryTeam() },
  devocional: { label: 'Devocional', icon: 'book', kinds: ['devocional', 'leitura'], on: () => featureOn('devocional') },
  datas: { label: 'Datas', icon: 'cake', kinds: ['aniversario', 'casamento', 'batismo', 'resumo_lideres'], on: () => datesOn() },
  visitantes: { label: 'Visitantes', icon: 'user', kinds: ['visitante'], on: () => visitorTeam() },
  financeiro: { label: 'Prestação de contas', icon: 'wallet', kinds: ['financeiro'], on: () => featureOn('financeiro') },
};
const notifGroup = (kind) => Object.keys(NOTIF_GROUPS).find((g) => NOTIF_GROUPS[g].kinds.includes(kind)) || 'sistema';
const NOTIF_PAGE = 30;

// Hora curta à direita: hoje, a hora; ontem; nesta semana, o dia; antes, a data.
function notifTime(iso) {
  const d = new Date(iso);
  const days = Math.round((parseIso(isoLocal(new Date())) - parseIso(isoLocal(d))) / 864e5);
  if (days === 0) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'ontem';
  if (days < 7) return d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function notifDayGroup(iso) {
  const days = Math.round((parseIso(isoLocal(new Date())) - parseIso(isoLocal(new Date(iso)))) / 864e5);
  return days === 0 ? 'Hoje' : days === 1 ? 'Ontem' : days < 7 ? 'Esta semana' : 'Mais antigas';
}

function notifList(items) {
  let html = '';
  let day = null;
  for (const n of items) {
    const g = notifDayGroup(n.created_at);
    if (g !== day) {
      html += `${day ? '</div>' : ''}<h2 class="notif-day">${g}</h2><div class="notif-list">`;
      day = g;
    }
    const group = notifGroup(n.kind);
    html += `
      <a class="notif-row ${n.unread ? 'unread' : ''}" href="${esc(n.url && n.url.startsWith('#/') ? n.url : '#/')}">
        <span class="notif-icon k-${group}">${icon[NOTIF_GROUPS[group]?.icon] || icon.bell}</span>
        <span class="notif-text">
          <span class="notif-head"><strong>${esc(n.title)}</strong><time datetime="${esc(n.created_at)}">${esc(notifTime(n.created_at))}</time></span>
          ${n.body ? `<small>${esc(n.body)}</small>` : ''}
        </span>
        ${n.unread ? '<span class="notif-dot" aria-label="Não lida"></span>' : ''}
      </a>`;
  }
  return html + (day ? '</div>' : '');
}

// Central de notificações desta igreja: por dia, com filtro por tipo e, no topo ou no fim,
// as notificações no celular.
async function viewNotifications(ctx) {
  if (!requireLogin('/notificacoes')) return;
  if (!isActiveMember()) return navigate('/');
  const groups = Object.keys(NOTIF_GROUPS).filter((g) => NOTIF_GROUPS[g].on());
  const filter = groups.includes(ctx.params.get('ver')) ? ctx.params.get('ver') : null;
  const openedAt = new Date().toISOString();
  const fetchPage = (from) => {
    let q = sb
      .from('notifications')
      .select('id, kind, title, body, url, read_at, created_at')
      .eq('church_id', state.church.id)
      .order('created_at', { ascending: false })
      .range(from, from + NOTIF_PAGE); // um a mais: diz se ainda há outra página
    if (filter) q = q.in('kind', NOTIF_GROUPS[filter].kinds);
    return q;
  };
  // Primeiro a página com o guardado (já visto na última visita: sem destaque); depois o banco.
  const name = `notificacoes:${filter || 'todas'}`;
  const mark = (rows, seen = false) => rows.map((n) => ({ ...n, unread: !seen && !n.read_at }));
  const cached = screenCached(name);
  let items = cached ? mark(cached.slice(0, NOTIF_PAGE), true) : null;
  let more = !!cached && cached.length > NOTIF_PAGE;

  $view.innerHTML = `
    <div class="page notif-page">
      <div class="notif-title">
        <h1>Notificações</h1>
        <button class="btn small" id="clear" hidden>Apagar as lidas</button>
      </div>
      <div id="push-offer"></div>
      ${groups.length > 1 ? '<nav class="chips filters" id="notif-filters" aria-label="Filtrar notificações"></nav>' : ''}
      <div id="notif-items"></div>
      <button class="btn" id="more" hidden>Ver mais</button>
      <p class="hint center notif-push" id="push-line"></p>
    </div>`;

  // Filtros numa linha só: só os grupos que têm notificação (mais "Todas" e o escolhido), com o
  // número de não lidas. Vêm de um resumo guardado (abre na hora) e conferido com o banco.
  const filtersBox = document.getElementById('notif-filters');
  const drawFilters = (rows) => {
    if (!filtersBox) return;
    const stat = {};
    for (const n of rows || []) {
      const g = notifGroup(n.kind);
      stat[g] ??= { total: 0, unread: 0 };
      stat[g].total++;
      // Lida agora, ao abrir a central (read_at = openedAt): ainda conta como nova nesta visita.
      if (!n.read_at || n.read_at >= openedAt) stat[g].unread++;
    }
    const shown = groups.filter((g) => g === filter || !rows || stat[g]?.total);
    const chip = (href, label, active, count) =>
      `<a class="chip ${active ? 'active' : ''}" href="${href}" ${active ? 'aria-current="page"' : ''}>${label}${
        count ? `<span class="chip-count" aria-label="${count} não lidas">${count > 9 ? '9+' : count}</span>` : ''
      }</a>`;
    filtersBox.hidden = !filter && shown.length < 2;
    filtersBox.innerHTML =
      chip('#/notificacoes', 'Todas', !filter, 0) +
      shown.map((g) => chip(`#/notificacoes?ver=${g}`, NOTIF_GROUPS[g].label, filter === g, stat[g]?.unread || 0)).join('');
    filtersBox.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  };
  if (filtersBox) {
    const summaryName = 'notificacoes:resumo';
    const loadSummary = async () => {
      const { data, error } = await sb.from('notifications').select('kind, read_at').eq('church_id', state.church.id).limit(1000);
      if (error) throw error;
      return data;
    };
    drawFilters(screenCached(summaryName));
    screenFetch(summaryName, loadSummary)
      .then((rows) => ctx.alive() && drawFilters(rows))
      .catch(() => {});
  }

  const box = document.getElementById('notif-items');
  const moreBtn = document.getElementById('more');
  const clearBtn = document.getElementById('clear');
  const draw = () => {
    box.innerHTML = !items
      ? '<p class="hint center">Carregando…</p>'
      : items.length
        ? notifList(items)
        : `<div class="empty notif-empty">${icon.bell}
          <h2>Tudo em dia!</h2>
          <p>${filter ? `Nenhuma notificação de ${NOTIF_GROUPS[filter].label.toLowerCase()}.` : 'Avisos, lembretes da agenda e as mensagens da igreja aparecem aqui.'}</p>
        </div>`;
    moreBtn.hidden = !more;
    clearBtn.hidden = !items?.some((n) => !n.unread);
  };
  draw();

  // Notificações no celular: chegam à parte (perguntar ao aparelho pode demorar um pouco).
  const togglePush = async (btn, on) => {
    btn.disabled = true;
    try {
      if (on) {
        const res = await enablePush(sb, CONFIG.VAPID_PUBLIC_KEY);
        toast(res === 'ativo' ? 'Pronto! As notificações estão ativadas.' : 'Sem permissão para notificações.', res === 'ativo' ? '' : 'error');
      } else {
        await disablePush(sb);
        toast('Notificações desativadas neste aparelho.');
      }
    } catch (err) {
      toast(errorText(err), 'error');
    }
    render();
  };
  pushActive().then((active) => {
    if (!ctx.alive()) return;
    const support = pushSupport();
    const blocked = support === 'ok' && Notification.permission === 'denied';
    document.getElementById('push-offer').innerHTML =
      support === 'ok' && !blocked && !active
        ? `<div class="notice push-invite">${icon.bell}
            <span><strong>Receba no celular</strong><small>Avisos e lembretes da igreja, mesmo com o app fechado.</small></span>
            <button class="btn primary small" id="push-on">Ativar</button>
          </div>`
        : support === 'ios-instalar'
          ? `<div class="notice push-invite">${icon.bell}
              <span><strong>Quer receber no iPhone?</strong><small>Instale o app: Compartilhar → "Adicionar à Tela de Início". Depois abra pelo ícone.</small></span>
            </div>`
          : '';
    document.getElementById('push-line').innerHTML = active
      ? `${icon.bell} Ativadas neste aparelho · <button class="link-btn" id="push-test">Enviar aviso de teste</button> · <button class="link-btn" id="push-off">Desativar</button>`
      : blocked
        ? 'As notificações estão bloqueadas para este site. Libere nas configurações do navegador para receber no celular.'
        : support === 'ok' || support === 'ios-instalar'
          ? ''
          : 'Este navegador não recebe notificações no celular. Use o Chrome (Android) ou o app instalado (iPhone).';
    document.getElementById('push-on')?.addEventListener('click', (e) => togglePush(e.currentTarget, true));
    document.getElementById('push-off')?.addEventListener('click', (e) => togglePush(e.currentTarget, false));
    document.getElementById('push-test')?.addEventListener('click', (e) => sendTestPush(e.currentTarget));
  });

  let data;
  try {
    data = await screenFetch(name, async () => {
      const { data: rows, error } = await fetchPage(0);
      if (error) throw error;
      return rows;
    });
  } catch (err) {
    if (cached) return;
    throw err;
  }
  if (!ctx.alive()) return;
  // Quem chegou sem ler continua destacado nesta visita, mesmo depois de marcado como lido.
  items = mark(data.slice(0, NOTIF_PAGE));
  more = data.length > NOTIF_PAGE;
  draw();

  // Abrir a central zera o sininho (as não lidas desta visita continuam destacadas).
  if (items.some((n) => n.unread)) {
    sb.from('notifications')
      .update({ read_at: openedAt })
      .eq('church_id', state.church.id)
      .is('read_at', null)
      .then(() => refreshUnread())
      .catch(() => {});
  }

  moreBtn.onclick = async () => {
    moreBtn.disabled = true;
    const { data: next, error: err } = await fetchPage(items.length);
    moreBtn.disabled = false;
    if (err) return toast(errorText(err), 'error');
    if (!ctx.alive()) return;
    items = items.concat(mark(next.slice(0, NOTIF_PAGE)));
    more = next.length > NOTIF_PAGE;
    draw();
  };

  // Apaga as que já estavam lidas antes desta visita (as novas de agora ficam).
  clearBtn.onclick = async () => {
    if (!await ask('Apagar as notificações que você já tinha lido?')) return;
    let q = sb.from('notifications').delete().eq('church_id', state.church.id).lt('read_at', openedAt);
    if (filter) q = q.in('kind', NOTIF_GROUPS[filter].kinds);
    const { error: err } = await q;
    if (err) return toast(errorText(err), 'error');
    for (const g of [null, ...groups]) screenForget(`notificacoes:${g || 'todas'}`);
    toast('Notificações lidas apagadas.');
    render();
  };
}

// Convite discreto na página inicial para ativar as notificações (some por 30 dias ao fechar).
// Aviso de teste para este aparelho (pela mesma função que manda os avisos do chat): mostra
// se o aviso sai daqui e se o celular deixa aparecer.
async function sendTestPush(btn) {
  btn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    const { data } = await sb.auth.getSession();
    if (!subscription || !data.session) throw new Error('Ative as notificações neste aparelho primeiro.');
    const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/enviar-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ test: true, endpoint: subscription.endpoint, church: state.church?.slug }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'Não foi possível enviar o teste.');
    if (out.sent) {
      toast('Aviso de teste enviado. Se não aparecer em 1 minuto, o celular está bloqueando as notificações do app: confira as configurações de notificação.');
    } else if (out.gone || !out.devices) {
      toast('Este aparelho não está mais inscrito. Toque em Desativar e ative as notificações de novo.', 'error');
    } else {
      toast('O serviço de notificações recusou o envio. Desative e ative as notificações de novo.', 'error');
    }
  } catch (err) {
    toast(errorText(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function pushInvite(el, { title = 'Receba as mensagens da igreja no celular', note = 'Como a mensagem no dia do seu aniversário.' } = {}) {
  if (!el || !isActiveMember() || pushSupport() !== 'ok' || Notification.permission !== 'default' || (await pushActive())) return;
  try {
    if (Date.now() - Number(localStorage.getItem('push-invite-dismissed') || 0) < 30 * 864e5) return;
  } catch {}
  if (!el.isConnected) return;
  el.innerHTML = `
    <div class="notice push-invite">
      ${icon.bell}
      <span><strong>${esc(title)}</strong><small>${esc(note)}</small></span>
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
  const loadTemplates = async () => {
    const { data: rows, error } = await sb.from('message_templates').select('*').eq('church_id', state.church.id).in('kind', [kind, 'resumo_lideres']);
    if (error) throw error;
    return rows;
  };
  const cachedTemplates = screenCached(`modelo:${kind}`);
  const data = await editItem(ctx, cachedTemplates, () => screenFetch(`modelo:${kind}`, loadTemplates), () => {});
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
      for (const k of Object.keys(MESSAGE_KINDS)) screenForget(`modelo:${k}`);
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
    for (const k of Object.keys(localStorage)) if (k.startsWith(SCREEN_PREFIX)) localStorage.removeItem(k);
  } catch {}
  screenMem.clear();
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
  prefetchScreens(); // quem abriu direto em outra tela também ganha a Agenda e os Avisos prontos
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

// O menu do botão "+" fecha ao tocar fora dele.
document.addEventListener('click', (e) => {
  const open = document.querySelector('.fab-menu[open]');
  if (open && !open.contains(e.target)) open.open = false;
});

// Cada igreja tem o seu service worker, com o mesmo endereço do app instalado dela (i/<igreja>/):
// assim o Android mostra os avisos pelo app da igreja, como no Desapega. Com o da raiz do site,
// o aviso ia para o Chrome e sumia em silêncio quando o Chrome não tinha permissão no celular.
const SW_SCOPE = SLUG ? PAGE_URL.replace(/\/?$/, '/') : ROOT_URL;
if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('sw.js', ROOT_URL).href, { scope: SW_SCOPE }).catch(() => {});
let quickStarted = null;
boot().catch((e) => {
  console.error(e);
  // Já está na tela com o que ficou guardado (ex.: sem internet): só avisa.
  if (quickStarted) return toast(errorText(e), 'error');
  $view.innerHTML = `<div class="empty"><h2>Não foi possível abrir o app</h2><p>${esc(errorText(e))}</p><button class="btn primary" id="reload">Tentar de novo</button></div>`;
  // Sem onclick no HTML: a regra de segurança (CSP) não deixa rodar código escrito na página.
  document.getElementById('reload').onclick = () => location.reload();
});
