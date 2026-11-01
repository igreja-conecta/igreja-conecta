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
    return {
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

export const faceDistance = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));

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
