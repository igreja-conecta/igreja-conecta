// Reconhecimento facial no aparelho (face-api, gratuito, roda no navegador): calcula a
// "assinatura" do rosto (128 números) a partir da câmera. Nenhuma foto é guardada nem enviada:
// cada quadro da câmera é lido aqui e descartado; só os números vão para o banco.
// A biblioteca e os modelos (cerca de 8 MB) são baixados só quando a câmera do rosto abre.
const BASE = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15';
export const FACE_MODEL = 'face-api-1.7.15';

// Passos do cadastro: um quadro bom em cada, com o rosto em ângulos um pouco diferentes.
export const ENROLL_STEPS = [
  'Olhe para a câmera',
  'Vire o rosto um pouco para a esquerda',
  'Agora um pouco para a direita',
  'Levante um pouco o queixo',
  'Olhe para a câmera de novo',
];
// Capturas da mesma pessoa ficam bem perto (no teste: até 0,16); pessoas diferentes, a partir de 0,5.
const SAME_PERSON = 0.4;

let engine;
// Os testes trocam o leitor de rosto por um de mentira (window.__rostoFalso): só no navegador do teste.
export function loadFaceEngine() {
  if (window.__rostoFalso) return Promise.resolve(window.__rostoFalso);
  engine ??= (async () => {
    const faceapi = await import(`${BASE}/dist/face-api.esm.js`);
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(`${BASE}/model`),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(`${BASE}/model`),
      faceapi.nets.faceRecognitionNet.loadFromUri(`${BASE}/model`),
    ]);
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    const boxOf = (d, w, h) => ({ x: d.box.x / w, y: d.box.y / h, width: d.box.width / w, height: d.box.height / h });
    return {
      // Rápido (sem a assinatura): onde está o rosto e quanto os olhos estão abertos (para o piscar).
      async track(video) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return [];
        const found = await faceapi.detectAllFaces(video, opts).withFaceLandmarks(true);
        return found.map((f) => ({
          score: f.detection.score,
          box: boxOf(f.detection, w, h),
          eyes: eyesOpen(f.landmarks.positions.map((p) => [p.x, p.y])),
        }));
      },
      // Rostos no quadro: a assinatura, a confiança e a caixa (em fração do quadro).
      async detect(video) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return [];
        const found = await faceapi.detectAllFaces(video, opts).withFaceLandmarks(true).withFaceDescriptors();
        return found.map((f) => ({
          descriptor: Array.from(f.descriptor),
          score: f.detection.score,
          box: { x: f.detection.box.x / w, y: f.detection.box.y / h, width: f.detection.box.width / w, height: f.detection.box.height / h },
        }));
      },
    };
  })();
  engine.catch(() => (engine = null));
  return engine;
}

// Abertura dos olhos (média dos dois), pelos 68 pontos do rosto: altura ÷ largura do olho.
// Olho aberto fica perto de 0,3; no piscar, cai bem.
export function eyesOpen(pts) {
  const d = (a, b) => Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
  const eye = (s) => (d(s + 1, s + 5) + d(s + 2, s + 4)) / (2 * d(s, s + 3));
  return (eye(36) + eye(42)) / 2;
}

// Piscou? Os olhos fecharam bem (abaixo de 75% do normal da pessoa) e abriram de novo.
export function blinked(history) {
  if (history.length < 5) return false;
  const sorted = [...history].sort((a, b) => a - b);
  const normal = sorted[Math.floor(sorted.length * 0.7)];
  const low = history.findIndex((v) => v < normal * 0.75);
  return low >= 0 && history.slice(low + 1).some((v) => v > normal * 0.9);
}

export const faceDistance =(a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));

export function meanDescriptor(list) {
  const out = new Array(list[0].length).fill(0);
  for (const d of list) d.forEach((x, i) => (out[i] += x / list.length));
  return out;
}

// Abre a câmera no <video>. Devolve a função que fecha.
export async function openCamera(video, facing = 'user') {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador não abre a câmera.');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.muted = true;
  video.setAttribute('playsinline', '');
  video.srcObject = stream;
  await video.play().catch(() => {});
  return () => stream.getTracks().forEach((t) => t.stop());
}

// Cadastro guiado: um quadro bom por passo (um rosto só, perto e nítido). onStep(i, texto) mostra
// o passo; onHint(texto) avisa o que falta. Se aparecer outra pessoa no meio, recomeça.
// Devolve { descriptor (média), samples }.
export async function enrollFace(video, { onStep, onHint, alive = () => true }) {
  const face = await loadFaceEngine();
  const shots = [];
  let step = 0;
  let since = 0;
  onStep(0, ENROLL_STEPS[0]);
  while (shots.length < ENROLL_STEPS.length) {
    if (!alive() || !video.isConnected) throw new Error('cancelado');
    const found = await face.detect(video).catch(() => []);
    const now = Date.now();
    if (found.length > 1) onHint('Só uma pessoa na frente da câmera.');
    else if (!found.length) onHint('Não estou vendo o rosto. Chegue mais perto e deixe o rosto iluminado.');
    else if (found[0].box.width < 0.18) onHint('Chegue um pouco mais perto.');
    else if (found[0].score < 0.6) onHint('Fique parado um instante, com o rosto iluminado.');
    // Um pequeno intervalo entre os passos, para a pessoa virar o rosto.
    else if (now - since > 1200) {
      const d = found[0].descriptor;
      if (shots.length && faceDistance(shots[0], d) > SAME_PERSON) {
        shots.length = 0;
        step = 0;
        onHint('Parece que outra pessoa apareceu. Vamos recomeçar.');
      } else {
        shots.push(d);
        step = shots.length;
        onHint('');
      }
      since = now;
      if (step < ENROLL_STEPS.length) onStep(step, ENROLL_STEPS[step]);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { descriptor: meanDescriptor(shots), samples: shots.length };
}

// Totem: acompanha quem chega na frente da câmera (um por vez, o rosto maior) e, quando a pessoa
// está perto (e piscou, se pedido), calcula a assinatura e chama onFace(assinatura). A mesma
// pessoa não é enviada de novo por 20 segundos. onState(estado) mostra o que falta:
// 'vazio', 'longe', 'varios', 'piscar' ou 'lendo'.
export async function watchFaces(video, { requireBlink = () => true, onState, onFace, alive = () => true }) {
  const face = await loadFaceEngine();
  let eyes = [];
  let seenAt = 0;
  const recent = [];
  let last = '';
  const state = (s) => s !== last && onState((last = s));
  while (alive() && video.isConnected) {
    const found = await face.track(video).catch(() => []);
    const now = Date.now();
    const near = found.filter((f) => f.box.width >= 0.15 && f.score >= 0.6).sort((a, b) => b.box.width - a.box.width);
    if (!near.length) {
      if (now - seenAt > 1500) eyes = [];
      state(found.length ? 'longe' : 'vazio');
    } else if (near.length > 1 && near[1].box.width > near[0].box.width * 0.8) {
      state('varios');
    } else {
      seenAt = now;
      eyes.push(near[0].eyes);
      if (eyes.length > 30) eyes.shift();
      if (requireBlink() && !blinked(eyes)) {
        state('piscar');
      } else {
        state('lendo');
        const full = (await face.detect(video).catch(() => [])).sort((a, b) => b.box.width - a.box.width)[0];
        eyes = [];
        if (full) {
          while (recent.length && now - recent[0].at > 20000) recent.shift();
          if (!recent.some((r) => faceDistance(r.d, full.descriptor) < 0.45)) {
            recent.push({ d: full.descriptor, at: now });
            await onFace(full.descriptor);
            last = '';
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}
