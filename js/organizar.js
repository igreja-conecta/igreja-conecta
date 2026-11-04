// Organizar arrastando (receita da skill organizar-arrastando, tirada do CC4): por enquanto os
// atalhos do Início (sortableGrid + applyOrder + mergeOrder). JavaScript puro, sem biblioteca.
//
// - sortable(list, onDrop): lista (um item embaixo do outro), arrastada pela alça ≡ ([data-grip]).
//   Cada item tem data-sort-id. onDrop(ids) recebe os ids na ordem nova.
// - sortableGrid(box, onDrop): grade (ícones lado a lado), arrastada pelo item inteiro, só quando
//   a grade tem a classe "organizing". Cada item tem data-key. onDrop(keys) recebe as chaves.
// - applyOrder(box, order): põe os itens [data-key] na ordem salva. O que não está nela vai para o fim.
// onDrop só é chamado quando a ordem mudou de verdade.

// Quem pediu menos movimento no celular não vê animação. A troca funciona igual.
export const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(.2, .8, .2, 1)';

// Alça ≡ do item da lista. Troque o SVG pelo ícone do projeto, se houver.
const GRIP_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
export const gripButton = (name) =>
  `<button type="button" class="grip" data-grip aria-label="Mudar a ordem de ${escAttr(name)}" title="Arraste para mudar a ordem">${GRIP_SVG}</button>`;

// Desliza um elemento de onde estava (dy) até onde está agora (técnica FLIP).
function slideFrom(el, dy) {
  if (!dy || calm()) return;
  el.style.transition = 'none';
  el.style.transform = `translateY(${dy}px)`;
  void el.offsetHeight; // aplica o ponto de partida antes de animar
  el.style.transition = `transform .22s ${EASE}`;
  el.style.transform = '';
  el.addEventListener('transitionend', () => (el.style.transition = ''), { once: true });
}

// O mesmo na grade (dx, dy). data-sliding avisa que o item ainda está a caminho.
function slideFrom2D(el, dx, dy) {
  if ((!dx && !dy) || calm()) return;
  el.dataset.sliding = '1';
  el.style.transition = 'none';
  el.style.transform = `translate(${dx}px, ${dy}px)`;
  void el.offsetHeight;
  el.style.transition = `transform .24s ${EASE}`;
  el.style.transform = '';
  const done = () => {
    delete el.dataset.sliding;
    el.style.transition = '';
  };
  el.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 300);
}

// Ao soltar: o item desliza até o lugar e "pousa" (a sombra some aos poucos).
function settle(item, ms) {
  document.documentElement.classList.remove('sorting-now');
  item.classList.remove('sorting');
  item.classList.add('settling');
  item.style.transition = calm() ? 'none' : `transform ${ms / 1000}s ${EASE}`;
  item.style.transform = '';
  setTimeout(() => {
    item.classList.remove('settling');
    item.style.transition = '';
  }, ms + 20);
}

// Lista: o item acompanha o dedo e troca de lugar com o vizinho quando passa da metade dele.
export function sortable(list, onDrop) {
  const ids = () => [...list.querySelectorAll('[data-sort-id]')].map((x) => x.dataset.sortId);
  list.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const item = grip.closest('[data-sort-id]');
    const before = ids().join();
    let startY = e.clientY;
    let dy = 0;
    item.style.transition = '';
    item.classList.add('sorting');
    document.documentElement.classList.add('sorting-now'); // sem selecionar texto enquanto arrasta
    navigator.vibrate?.(8);
    const place = () => (item.style.transform = `translateY(${dy}px) scale(${calm() ? 1 : 1.02})`);
    place();
    const move = (ev) => {
      dy = ev.clientY - startY;
      const next = item.nextElementSibling?.matches('[data-sort-id]') ? item.nextElementSibling : null;
      const prev = item.previousElementSibling?.matches('[data-sort-id]') ? item.previousElementSibling : null;
      const other = next && dy > next.offsetHeight / 2 ? next : prev && dy < -prev.offsetHeight / 2 ? prev : null;
      if (other) {
        const otherTop = other.offsetTop;
        const top = item.offsetTop;
        if (other === next) list.insertBefore(next, item);
        else list.insertBefore(item, prev);
        startY += item.offsetTop - top; // o lugar novo vira o ponto de partida
        dy = ev.clientY - startY;
        slideFrom(other, otherTop - other.offsetTop);
        navigator.vibrate?.(4);
      }
      place();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      settle(item, 220);
      if (ids().join() !== before) onDrop(ids());
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  // A alça não abre o item.
  list.addEventListener('click', (e) => e.target.closest('[data-grip]') && e.preventDefault(), true);
  // Teclado: setas para cima e para baixo na alça.
  list.addEventListener('keydown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const item = grip.closest('[data-sort-id]');
    const other = e.key === 'ArrowUp' ? item.previousElementSibling : item.nextElementSibling;
    if (!other?.matches('[data-sort-id]')) return;
    const itemTop = item.offsetTop;
    const otherTop = other.offsetTop;
    if (e.key === 'ArrowUp') list.insertBefore(item, other);
    else list.insertBefore(other, item);
    slideFrom(item, itemTop - item.offsetTop);
    slideFrom(other, otherTop - other.offsetTop);
    grip.focus();
    onDrop(ids());
  });
}

// Grade: o item levanta ao pegar, os outros deslizam para abrir espaço e ele pousa ao soltar.
// Só funciona com a grade em modo "organizing". Fora dele, os itens abrem normalmente.
export function sortableGrid(box, onDrop) {
  const tiles = () => [...box.children].filter((el) => el.dataset.key);
  const keys = () => tiles().map((el) => el.dataset.key);
  const moveTile = (item, target, after) => {
    const before = new Map(tiles().map((el) => [el, el.getBoundingClientRect()]));
    box.insertBefore(item, after ? target.nextElementSibling : target);
    for (const [el, r] of before) {
      if (el === item) continue;
      const n = el.getBoundingClientRect();
      slideFrom2D(el, r.left - n.left, r.top - n.top);
    }
    return before.get(item);
  };
  box.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('[data-key]');
    if (!box.classList.contains('organizing') || !item || item.parentElement !== box) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const first = keys().join();
    let sx = e.clientX;
    let sy = e.clientY;
    let dx = 0;
    let dy = 0;
    item.style.transition = '';
    item.classList.add('sorting');
    document.documentElement.classList.add('sorting-now');
    navigator.vibrate?.(8);
    const place = () => (item.style.transform = `translate(${dx}px, ${dy}px) scale(${calm() ? 1 : 1.06})`);
    place();
    const move = (ev) => {
      dx = ev.clientX - sx;
      dy = ev.clientY - sy;
      // O item embaixo do dedo. O que está sendo arrastado não conta: ele tem pointer-events: none no CSS.
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-key]');
      if (target && target !== item && target.parentElement === box && !target.dataset.sliding) {
        const list = tiles();
        const after = list.indexOf(target) > list.indexOf(item);
        const old = moveTile(item, target, after);
        const now = item.getBoundingClientRect();
        // O lugar novo vira o ponto de partida: o item continua embaixo do dedo.
        sx += now.left - old.left;
        sy += now.top - old.top;
        dx = ev.clientX - sx;
        dy = ev.clientY - sy;
        navigator.vibrate?.(4);
      }
      place();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      settle(item, 240);
      if (keys().join() !== first) onDrop(keys());
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  // No modo organizando, tocar no item não abre a tela.
  box.addEventListener('click', (e) => box.classList.contains('organizing') && e.preventDefault(), true);
  // Teclado: as setas mudam o item de lugar.
  box.addEventListener('keydown', (e) => {
    const item = e.target.closest('[data-key]');
    if (!box.classList.contains('organizing') || !item) return;
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const list = tiles();
    const target = list[list.indexOf(item) + step];
    if (!target) return;
    const old = moveTile(item, target, step > 0);
    const now = item.getBoundingClientRect();
    slideFrom2D(item, old.left - now.left, old.top - now.top);
    item.focus();
    onDrop(keys());
  });
}

// Põe os itens na ordem salva. Um item que não está na lista (função ligada depois, item novo)
// vai para o fim, na ordem de sempre. Só mexe na tela se a ordem mudou, e não mexe enquanto
// alguém arrasta.
export function applyOrder(box, order) {
  if (!box || !order?.length || box.querySelector('.sorting')) return;
  const pos = (el) => {
    const i = order.indexOf(el.dataset.key);
    return i < 0 ? order.length : i;
  };
  const tiles = [...box.children].filter((el) => el.dataset.key);
  const sorted = tiles
    .map((el, i) => [el, pos(el), i])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([el]) => el);
  if (sorted.some((el, i) => el !== tiles[i])) box.append(...sorted);
}

// Junta a ordem nova com as chaves que quem organizou não vê (ex.: grupos de que não
// participa), para elas não se perderem ao salvar.
export const mergeOrder = (keys, saved) => [...keys, ...(saved || []).filter((k) => !keys.includes(k))];
