// Convite para "Adicionar à tela inicial", com o nome e a logo da igreja.
// Aparece depois que a pessoa entra na igreja; no iPhone, mostra um tutorial.
import { esc } from './util.js';

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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

export function maybeSuggestInstall(church) {
  if (!church || isStandalone()) return;
  if (Date.now() - readNumber('install-dismissed') < 14 * 24 * 3600 * 1000) return;
  if (!deferredPrompt && !isIOS()) return;
  if (document.querySelector('.install-banner')) return;
  setTimeout(() => showBanner(church), 1200);
}

function showBanner(church) {
  const el = document.createElement('div');
  el.className = 'install-banner';
  el.innerHTML = `
    <img src="${esc(church.logo_url || 'icons/icon-192.png')}" alt="" width="40" height="40">
    <div><strong>Tenha ${esc(church.short_name || church.name)} na tela inicial</strong><span>Agenda, avisos e aniversariantes com um toque.</span></div>
    <button class="btn primary small" data-install>Adicionar</button>
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
    }
  };
}

function showIOSTutorial() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal">
      <h2>Adicionar à Tela de Início</h2>
      <ol>
        <li>Abra este endereço no <strong>Safari</strong>.</li>
        <li>Toque no botão <strong>Compartilhar</strong>
          <svg viewBox="0 0 24 24" class="inline"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg>
          na barra de baixo.</li>
        <li>Role e toque em <strong>Adicionar à Tela de Início</strong>.</li>
        <li>Toque em <strong>Adicionar</strong>. Pronto!</li>
      </ol>
      <button class="btn primary" data-close>Entendi</button>
    </div>`;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) wrap.remove();
  });
  document.body.appendChild(wrap);
}
