// Reconhecimento facial no aparelho (face-api, gratuito, roda no navegador): calcula a
// "assinatura" do rosto (128 números) a partir da câmera. Nenhuma foto é guardada nem enviada:
// cada quadro da câmera é lido aqui e descartado; só os números vão para o banco.
// A biblioteca e os modelos (cerca de 8 MB) são baixados só quando a câmera do rosto abre.
const BASE = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15';
export const FACE_MODEL = 'face-api-1.7.15';

// Cadastro girando a cabeça (como o desbloqueio pelo rosto do celular): primeiro de frente, depois
// a pessoa gira a cabeça devagar em círculo e o app guarda as assinaturas de ângulos diferentes.
// TURN_SHOTS: quantas guardar (o anel da tela tem uma parte para cada).
export const TURN_SHOTS = 8;
// Mínimo para terminar se a pessoa não conseguir girar mais (depois de TURN_GIVE_UP_MS).
const TURN_MIN = 4;
const TURN_GIVE_UP_MS = 30000;
// Uma assinatura nova só entra se for diferente das que já estão (outro ângulo): 0,15.
// Mais longe que 0,6 da de frente já não parece a mesma pessoa (ou virou demais): fica de fora.
const TURN_NEW = 0.15;
const TURN_FAR = 0.6;
// O que fazer com uma leitura durante o giro: 'novo' (outro ângulo, guarda), 'igual' (ângulo
// que já tem) ou 'longe' (virou demais ou outra pessoa).
export function turnPick(shots, d) {
  if (!shots.length) return 'novo';
  if (faceDistance(shots[0], d) > TURN_FAR) return 'longe';
  return shots.every((x) => faceDistance(x, d) >= TURN_NEW) ? 'novo' : 'igual';
}
// Totem: quantas leituras seguidas da mesma pessoa antes de dizer "Não reconheci" (quem chega
// com o rosto um pouco para baixo costuma ser reconhecido na segunda ou terceira).
export const FACE_TRIES = 4;
// Nota mínima do detector para ler o rosto no totem (antes 0,6: o rosto um pouco para baixo ficava de fora).
const TRACK_SCORE = 0.4;
// Em grupo, um pouco mais alta: o rosto aparece em duas leituras seguidas antes de ir ao banco.
const GROUP_SCORE = 0.45;
// Quem foi reconhecido não é lido de novo por 20 s; quem não foi, só espera um pouco.
const SEEN_MS = 20000;
const MISSED_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRecent = (recent, d, now) => recent.some((r) => now - r.at < r.ms && faceDistance(r.d, d) < 0.45);

// Erro com texto para a pessoa: a tela mostra como está.
export const faceError = (text) => Object.assign(new Error(text), { friendly: true });
const within = (promise, ms, text) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(faceError(text)), ms))]);

// Arquivos do modo wasm (mesma versão do TensorFlow que vem dentro da face-api 1.7.15).
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/';
const NO_ENGINE = 'O reconhecimento facial não conseguiu rodar neste aparelho. Atualize o navegador ou use outro aparelho.';
// iPhone, iPad (que se apresenta como Mac com tela de toque) e o Safari do Mac.
const appleWebKit = () => {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || (/Safari\//.test(ua) && !/Chrome|Chromium|Edg|Android/.test(ua));
};
// Passa uma imagem lisa pelos três modelos (detector, pontos do rosto e assinatura).
async function warmUp(faceapi) {
  const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 160 });
  const g = canvas.getContext('2d');
  g.fillStyle = '#888';
  g.fillRect(0, 0, 160, 160);
  await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 160 }));
  await faceapi.nets.faceLandmark68TinyNet.detectLandmarks(canvas);
  await faceapi.computeFaceDescriptor(canvas);
}

let engine;
// Os testes trocam o leitor de rosto por um de mentira (window.__rostoFalso): só no navegador do teste.
// onProgress(texto): o que está acontecendo (baixar ~8 MB na primeira vez pode demorar no 4G).
export function loadFaceEngine(onProgress = () => {}) {
  if (window.__rostoFalso) return Promise.resolve(window.__rostoFalso);
  engine ??= within(
    (async () => {
      onProgress('Baixando o reconhecimento facial (cerca de 8 MB, só na primeira vez)…');
      const faceapi = await import(`${BASE}/dist/face-api.esm.js`);
      const { tf } = faceapi;
      tf.setWasmPaths(WASM_BASE);
      // iPhone/iPad (Safari): o modo de vídeo (webgl) trava ou erra as contas; lá vai direto no wasm,
      // que dá a mesma assinatura (os rostos cadastrados em outro aparelho continuam valendo).
      if (appleWebKit() && !(await tf.setBackend('wasm').catch(() => false))) await tf.setBackend('webgl').catch(() => false);
      await tf.ready();
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(`${BASE}/model`),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(`${BASE}/model`),
        faceapi.nets.faceRecognitionNet.loadFromUri(`${BASE}/model`),
      ]);
      onProgress('Preparando o reconhecimento…');
      // Uma leitura de ensaio: se o modo atual falhar ou travar, troca para o wasm e tenta de novo.
      try {
        await within(warmUp(faceapi), 30000, 'ensaio demorou');
      } catch {
        if (tf.getBackend() === 'wasm' || !(await tf.setBackend('wasm').catch(() => false))) throw faceError(NO_ENGINE);
        await within(warmUp(faceapi), 30000, NO_ENGINE);
      }
      return faceapi;
    })(),
    150000,
    'O reconhecimento facial não terminou de baixar em 2 minutos. Confira a internet (de preferência Wi-Fi) e tente de novo.',
  ).then((faceapi) => {
    // Nota mínima baixa (0,3): rosto inclinado para baixo ou de lado tira nota menor. Quem decide se é
    // a pessoa é o banco, pela assinatura (a regra de segurança não muda).
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 });
    // Acompanhar (totem) com imagem menor: mais leituras por segundo no celular.
    const fast = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 });
    // Grupo: imagem maior, para achar rostos menores (gente mais longe).
    const wide = new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.3 });
    const boxOf = (d, w, h) => ({ x: d.box.x / w, y: d.box.y / h, width: d.box.width / w, height: d.box.height / h });
    return {
      backend: faceapi.tf.getBackend(),
      // Rápido (sem a assinatura): onde está o rosto e quanto os olhos estão abertos (para o piscar).
      async track(video) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return [];
        const found = await faceapi.detectAllFaces(video, fast).withFaceLandmarks(true);
        return found.map((f) => ({
          score: f.detection.score,
          box: boxOf(f.detection, w, h),
          eyes: eyesOpen(f.landmarks.positions.map((p) => [p.x, p.y])),
        }));
      },
      // Rostos no quadro: a assinatura, a confiança e a caixa (em fração do quadro).
      async detect(video, { group = false } = {}) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return [];
        const found = await faceapi.detectAllFaces(video, group ? wide : opts).withFaceLandmarks(true).withFaceDescriptors();
        return found.map((f) => ({
          descriptor: Array.from(f.descriptor),
          score: f.detection.score,
          box: { x: f.detection.box.x / w, y: f.detection.box.y / h, width: f.detection.box.width / w, height: f.detection.box.height / h },
        }));
      },
    };
  });
  engine.catch(() => (engine = null));
  return engine;
}

// Brilho médio do quadro (0 a 255): a câmera às vezes abre mas entrega imagem preta.
let probe;
export function frameBrightness(video) {
  try {
    probe ??= Object.assign(document.createElement('canvas'), { width: 24, height: 24 });
    const g = probe.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0, 24, 24);
    const px = g.getImageData(0, 0, 24, 24).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
    return sum / (px.length / 4);
  } catch {
    return 255;
  }
}

// Lê o quadro; se o reconhecimento falhar seguidamente neste aparelho, avisa em vez de tentar para sempre.
function reader(face, kind, options) {
  let fails = 0;
  return async (video) => {
    try {
      const out = await face[kind](video, options);
      fails = 0;
      return out;
    } catch (err) {
      if (++fails >= 5) throw faceError(`O reconhecimento facial não está funcionando neste aparelho (${err?.message || err}). Tente pelo Chrome atualizado ou em outro celular.`);
      return [];
    }
  };
}

// Abertura dos olhos (média dos dois), pelos 68 pontos do rosto: altura ÷ largura do olho.
// Olho aberto fica perto de 0,3; no piscar, cai bem.
export function eyesOpen(pts) {
  const d = (a, b) => Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
  const eye = (s) => (d(s + 1, s + 5) + d(s + 2, s + 4)) / (2 * d(s, s + 3));
  return (eye(36) + eye(42)) / 2;
}

// Fechou e abriu os olhos? Uma leitura com os olhos bem mais fechados que o normal da pessoa
// (abaixo de 82%) e depois uma com eles abertos de novo. No celular cada leitura demora: o totem
// pede para fechar os olhos por um segundo (uma piscada rápida escapa entre duas leituras).
export function blinked(history) {
  if (history.length < 3) return false;
  const sorted = [...history].sort((a, b) => a - b);
  const normal = sorted[Math.floor(sorted.length * 0.7)];
  const low = history.findIndex((v) => v < normal * 0.82);
  return low >= 0 && history.slice(low + 1).some((v) => v > normal * 0.92);
}

export const faceDistance =(a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));

export function meanDescriptor(list) {
  const out = new Array(list[0].length).fill(0);
  for (const d of list) d.forEach((x, i) => (out[i] += x / list.length));
  return out;
}

// Abre a câmera no <video>. Devolve a função que fecha.
// hd: imagem maior (modo grupo), para os rostos de quem está mais longe.
export async function openCamera(video, facing = 'user', { hd = false } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador não abre a câmera.');
  const stream = await within(
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: hd ? 1280 : 640 }, height: { ideal: hd ? 720 : 480 } },
      audio: false,
    }),
    60000,
    'A câmera não respondeu. Confira se o app tem permissão para a câmera e tente de novo.',
  );
  const close = () => stream.getTracks().forEach((t) => t.stop());
  video.muted = true;
  video.setAttribute('playsinline', '');
  video.srcObject = stream;
  video.play().catch(() => {});
  // Espera a primeira imagem (até 10 s).
  for (let i = 0; i < 50 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 200));
  if (!video.videoWidth) {
    close();
    throw faceError('A câmera abriu, mas não mandou imagem. Feche outros apps que usam a câmera e toque em "Trocar câmera".');
  }
  return close;
}

// Cadastro: onStep(texto) mostra o que fazer, onTurn(n) quantas partes do anel já completou,
// onHint(texto) avisa o que falta. Devolve { descriptor (média), samples, angles (cada ângulo) }.
export async function enrollFace(video, { onStep, onTurn = () => {}, onHint, onInfo = () => {}, onProgress = () => {}, alive = () => true }) {
  const face = await loadFaceEngine(onProgress);
  const detect = reader(face, 'detect');
  const shots = [];
  let startedAt = 0;
  let lastNew = 0;
  onStep('Olhe para a câmera, de frente');
  while (shots.length < TURN_SHOTS && !(startedAt && shots.length >= TURN_MIN && Date.now() - startedAt > TURN_GIVE_UP_MS)) {
    if (!alive() || !video.isConnected) throw new Error('cancelado');
    const t0 = performance.now();
    const found = await detect(video);
    const now = Date.now();
    onInfo(`${face.backend || '?'} · ${Math.round(performance.now() - t0)} ms · ${video.videoWidth}×${video.videoHeight}`);
    // De lado o rosto fica mais estreito e com menos certeza: depois do primeiro, aceita um pouco menos.
    const minWidth = shots.length ? 0.14 : 0.18;
    const minScore = shots.length ? 0.4 : 0.6;
    if (found.length > 1) onHint('Só uma pessoa na frente da câmera.');
    else if (!found.length && frameBrightness(video) < 10)
      onHint('A imagem da câmera está preta. Toque em "Trocar câmera" ou feche outros apps que usam a câmera.');
    else if (!found.length) onHint(shots.length ? 'Não estou vendo o rosto: gire um pouco menos.' : 'Não estou vendo o rosto. Chegue mais perto e deixe o rosto iluminado.');
    else if (found[0].box.width < minWidth) onHint('Chegue um pouco mais perto.');
    else if (found[0].score < minScore) onHint('Fique parado um instante, com o rosto iluminado.');
    else {
      const pick = turnPick(shots, found[0].descriptor);
      if (pick === 'novo') {
        shots.push(found[0].descriptor);
        lastNew = now;
        onTurn(shots.length);
        onHint('');
        if (shots.length === 1) {
          startedAt = now;
          onStep('Agora gire a cabeça devagar, fazendo um círculo');
        }
      } else if (pick === 'longe') {
        onHint('Gire um pouco menos, sem tirar o rosto da câmera.');
      } else if (now - lastNew > 5000) {
        onHint('Gire um pouco mais: para os lados, para cima e para baixo.');
      }
    }
    await sleep(120);
  }
  return { descriptor: meanDescriptor(shots), samples: shots.length, angles: shots };
}

// Totem: acompanha quem chega na frente da câmera (um por vez, o rosto maior) e, quando a pessoa
// está perto (e piscou, se pedido), calcula a assinatura e chama onFace(assinatura). A mesma
// pessoa não é enviada de novo por 20 segundos. onState(estado) mostra o que falta:
// 'vazio', 'longe', 'levante' (rosto perto, mas inclinado demais), 'varios', 'piscar' ou 'lendo'.
export async function watchFaces(video, { requireBlink = () => true, onState, onFace, onProgress = () => {}, onInfo = () => {}, alive = () => true }) {
  const face = await loadFaceEngine(onProgress);
  const track = reader(face, 'track');
  const detect = reader(face, 'detect');
  let eyes = [];
  let seenAt = 0;
  let recent = [];
  let tries = 0;
  let blinkOk = 0;
  let last = '';
  const state = (s) => s !== last && onState((last = s));
  while (alive() && video.isConnected) {
    const t0 = performance.now();
    const found = await track(video);
    const now = Date.now();
    onInfo(`${face.backend || '?'} · ${Math.round(performance.now() - t0)} ms${found[0]?.eyes ? ` · olhos ${found[0].eyes.toFixed(2)}` : ''}`);
    // Nota a partir de 0,4: quem chega com o rosto um pouco para baixo também entra.
    const near = found.filter((f) => f.box.width >= 0.12 && f.score >= TRACK_SCORE).sort((a, b) => b.box.width - a.box.width);
    if (!near.length) {
      if (now - seenAt > 1500) {
        eyes = [];
        tries = 0;
      }
      const close = found.some((f) => f.box.width >= 0.12);
      state(close ? 'levante' : found.length ? 'longe' : frameBrightness(video) < 10 ? 'preta' : 'vazio');
    } else if (near.length > 1 && near[1].box.width > near[0].box.width * 0.8) {
      state('varios');
    } else {
      seenAt = now;
      eyes.push(near[0].eyes);
      if (eyes.length > 30) eyes.shift();
      // Depois de piscar, as novas tentativas da mesma pessoa não pedem para piscar de novo.
      if (requireBlink() && !(tries && now - blinkOk < 8000) && !blinked(eyes)) {
        state('piscar');
      } else {
        if (!tries) blinkOk = now;
        state('lendo');
        const full = (await detect(video)).sort((a, b) => b.box.width - a.box.width)[0];
        eyes = [];
        recent = recent.filter((r) => now - r.at < r.ms);
        if (full && !isRecent(recent, full.descriptor, now)) {
          tries++;
          const lastTry = tries >= FACE_TRIES;
          // onFace devolve true quando terminou com essa pessoa (reconhecida ou erro).
          const done = await onFace(full.descriptor, { lastTry, tries });
          last = '';
          if (done || lastTry) {
            recent.push({ d: full.descriptor, at: Date.now(), ms: done ? SEEN_MS : MISSED_MS });
            tries = 0;
            await sleep(1500);
          } else {
            await sleep(350);
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}


// Grupo: rostos da leitura atual que também estavam na anterior (mesma pessoa, assinatura bem
// parecida). Só esses vão para o banco: evita mandar um rosto cortado ou borrado de passagem.
export function stableFaces(previous, current, max = 0.35) {
  return current.filter((f) => previous.some((p) => faceDistance(p.descriptor, f.descriptor) < max));
}

// Totem em modo grupo: cada leitura acha todos os rostos perto o bastante; os que aparecem em duas
// leituras seguidas (e não foram enviados nos últimos 20 s) vão juntos para onFaces(assinaturas).
// onState: 'vazio', 'longe', 'preta' ou 'grupo' (com o número de rostos).
export async function watchGroup(video, { onState, onFaces, onProgress = () => {}, onInfo = () => {}, alive = () => true }) {
  const face = await loadFaceEngine(onProgress);
  const detect = reader(face, 'detect', { group: true });
  let previous = [];
  let recent = [];
  let last = '';
  const state = (s, n = 0) => s + n !== last && onState(s, n, (last = s + n));
  while (alive() && video.isConnected) {
    const t0 = performance.now();
    const found = await detect(video);
    const now = Date.now();
    // Rosto de pelo menos 6% da largura da imagem (cerca de 75 px em 1280): menor que isso, erra muito.
    const near = found.filter((f) => f.box.width >= 0.06 && f.score >= GROUP_SCORE);
    onInfo(`${face.backend || '?'} · ${Math.round(performance.now() - t0)} ms · ${near.length} ${near.length === 1 ? 'rosto' : 'rostos'} · ${video.videoWidth}×${video.videoHeight}`);
    if (!near.length) state(found.length ? 'longe' : frameBrightness(video) < 10 ? 'preta' : 'vazio');
    else state('grupo', near.length);
    recent = recent.filter((r) => now - r.at < r.ms);
    const fresh = stableFaces(previous, near).filter((f) => !isRecent(recent, f.descriptor, now));
    previous = near;
    if (fresh.length) {
      const batch = fresh.sort((a, b) => b.box.width - a.box.width).slice(0, 10);
      // onFaces devolve as posições reconhecidas: essas param por 20 s; as outras tentam de novo logo.
      const hit = new Set((await onFaces(batch.map((f) => f.descriptor))) ?? batch.map((_, i) => i));
      batch.forEach((f, i) => recent.push({ d: f.descriptor, at: Date.now(), ms: hit.has(i) ? SEEN_MS : MISSED_MS }));
      last = '';
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}
