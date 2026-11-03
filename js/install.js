// Convite para "Adicionar à tela inicial", com o nome e a logo da igreja.
// Aparece logo que a pessoa abre a página da igreja no navegador do celular (antes mesmo de entrar).
// Android com o Chrome: abre a instalação do navegador. iPhone ou outro navegador: mostra o passo a passo.
import { esc } from './util.js';

let deferredPrompt = null;
let pendingChurch = null; // igreja que já pediu o convite, à espera do aviso do navegador
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  // O Chrome às vezes avisa que dá para instalar depois que a tela já abriu.
  if (pendingChurch) maybeSuggestInstall(pendingChurch);
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  document.querySelector('.install-banner')?.remove();
});

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /android/i.test(navigator.userAgent);

function readNumber(key) {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

// A página da igreja vem com a versão do ícone com que foi publicada (scripts/build-site.mjs).
// Se o administrador trocou o ícone depois, o celular instalaria com o antigo: espera a próxima
// publicação (o GitHub confere a cada 10 minutos). Igreja nova, ainda sem pasta, também espera.
export function iconReady(church) {
  const built = Number(document.querySelector('meta[name="icone-versao"]')?.content || 0);
  return !!church && built >= (church.branding_version || 1);
}
export const ICON_PREPARING =
  'O ícone novo da igreja está sendo preparado. Em até 15 minutos fica pronto para instalar: depois disso, abra esta página de novo.';

// Para a tela de Ajuda: 'instalado' | 'android' (o navegador oferece instalar) | 'iphone' | 'manual'.
export function installState() {
  if (isStandalone()) return 'instalado';
  if (deferredPrompt) return 'android';
  if (isIOS()) return 'iphone';
  return 'manual';
}

// Abre a instalação do navegador (Android) ou o tutorial do iPhone. Devolve true se instalou.
export async function installNow() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    return outcome === 'accepted';
  }
  if (isIOS()) showIOSTutorial();
  else if (isAndroid()) showAndroidTutorial();
  return false;
}

// Chamado ao abrir a página da igreja (e de novo no Início). Mostra o convite uma vez por abertura.
// Quem fechou no "×" volta a ver depois de 3 dias.
let bannerTimer = 0;
export function maybeSuggestInstall(church) {
  if (!church || isStandalone() || !iconReady(church)) return;
  if (Date.now() - readNumber('install-dismissed') < 3 * 24 * 3600 * 1000) return;
  pendingChurch = church;
  if (!deferredPrompt && !isIOS() && !isAndroid()) return; // computador: só se o navegador oferecer instalar
  if (document.querySelector('.install-banner') || bannerTimer) return;
  // No Android sem o aviso do Chrome ainda, espera um pouco mais: se ele chegar, o botão instala direto.
  const wait = deferredPrompt || isIOS() ? 800 : 2500;
  bannerTimer = setTimeout(() => {
    if (!document.querySelector('.install-banner') && !isStandalone()) showBanner(pendingChurch);
  }, wait);
}

function showBanner(church) {
  const el = document.createElement('div');
  el.className = 'install-banner';
  el.innerHTML = `
    <img src="${esc(church.logo_url || 'icons/icon-192.png')}" alt="" width="40" height="40">
    <div><strong>Tenha ${esc(church.short_name || church.name)} na tela inicial</strong><span>Instale o app da igreja: agenda, avisos e aniversariantes com um toque.</span></div>
    <button class="btn primary small" data-install>Instalar</button>
    <button class="close" aria-label="Agora não" data-dismiss>&times;</button>`;
  document.body.appendChild(el);

  el.querySelector('[data-dismiss]').onclick = () => {
    write('install-dismissed', Date.now());
    el.remove();
  };
  el.querySelector('[data-install]').onclick = async () => {
    el.remove();
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (outcome !== 'accepted') write('install-dismissed', Date.now());
    } else if (isIOS()) {
      showIOSTutorial();
    } else {
      showAndroidTutorial();
    }
  };
}

function showModal(inner) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal">${inner}<button class="btn primary" data-close>Entendi</button></div>`;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) wrap.remove();
  });
  document.body.appendChild(wrap);
}

function showIOSTutorial() {
  showModal(`
      <h2>Adicionar à Tela de Início</h2>
      <ol>
        <li>Abra este endereço no <strong>Safari</strong>.</li>
        <li>Toque no botão <strong>Compartilhar</strong>
          <svg viewBox="0 0 24 24" class="inline"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg>
          na barra de baixo.</li>
        <li>Role e toque em <strong>Adicionar à Tela de Início</strong>.</li>
        <li>Toque em <strong>Adicionar</strong>. Pronto!</li>
      </ol>`);
}

// Android sem o botão de instalar do navegador (outro navegador, ou o Chrome ainda não liberou).
function showAndroidTutorial() {
  showModal(`
      <h2>Adicionar à tela inicial</h2>
      <ol>
        <li>Toque no menu do navegador: os <strong>três pontinhos ⋮</strong> no canto de cima (no Samsung Internet, as <strong>três linhas ≡</strong> embaixo).</li>
        <li>Toque em <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>.</li>
        <li>Confirme em <strong>Instalar</strong> ou <strong>Adicionar</strong>. Pronto!</li>
      </ol>
      <p class="hint">Não achou a opção? Abra este endereço no <strong>Chrome</strong>.</p>`);
}
