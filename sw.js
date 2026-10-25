// Service worker: deixa o app abrir rápido e funcionar com internet ruim.
// Arquivos do app: rede primeiro, cache como reserva. Dados do Supabase: sempre da rede.
// Troque o nome do cache a cada versão publicada.
const CACHE = 'igreja-conecta-v2';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/config.js',
  'js/util.js',
  'js/images.js',
  'js/install.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !cdn) return;
  // O ícone da tela de início do iPhone vem direto da rede (o Safari falha às vezes quando passa pelo service worker).
  if (url.pathname.endsWith('/apple-touch-icon.png')) return;

  if (cdn) {
    // Bibliotecas com versão fixa: cache primeiro.
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })),
    );
    return;
  }

  // "no-cache" revalida com o servidor: uma versão nova publicada chega na hora.
  e.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./'))),
  );
});
