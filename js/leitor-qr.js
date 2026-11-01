// Leitor de QR Code pela câmera (presença pela carteirinha).
// Usa o leitor do próprio navegador (BarcodeDetector, no Android) e, onde ele não existe
// (iPhone, computador), o jsQR, baixado só quando o leitor abre. A imagem da câmera nunca
// sai do aparelho: cada quadro é lido aqui e descartado.
const JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm';

let jsqr;
function loadJsQR() {
  jsqr ??= import(JSQR).then((m) => m.default);
  jsqr.catch(() => (jsqr = null));
  return jsqr;
}

async function makeDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
      }
    } catch {}
  }
  const decode = await loadJsQR();
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    // Imagem menor: lê mais rápido em celular simples e o QR da carteirinha continua legível.
    const scale = Math.min(1, 720 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    g.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    return decode(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
  };
}

// Abre a câmera no <video> e chama onCode(texto) a cada QR lido (o mesmo QR, no máximo a cada
// 4 segundos). Para sozinho quando a tela muda (alive() falso ou o <video> sai da página).
// facing: 'environment' (câmera de trás) ou 'user' (da frente). Devolve a função que para.
export async function startQrReader(video, { facing = 'environment', onCode, alive = () => true }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador não abre a câmera.');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  let stopped = false;
  const stop = () => {
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
  };
  video.muted = true;
  video.setAttribute('playsinline', '');
  video.srcObject = stream;
  await video.play().catch(() => {});
  let detect;
  try {
    detect = await makeDetector();
  } catch {
    stop();
    throw new Error('Não foi possível carregar o leitor de QR Code. Confira a internet e tente de novo.');
  }
  const seen = new Map();
  const tick = async () => {
    if (stopped) return;
    if (!alive() || !video.isConnected) return stop();
    try {
      const text = await detect(video);
      const now = Date.now();
      if (text && now - (seen.get(text) || 0) > 4000) {
        seen.set(text, now);
        await onCode(text);
      }
    } catch {}
    setTimeout(tick, 200);
  };
  tick();
  return stop;
}

// Bip curto: agudo quando deu certo, grave quando não.
let audio;
export function beep(ok = true) {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = ok ? 880 : 220;
    const t = audio.currentTime;
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (ok ? 0.15 : 0.4));
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.45);
  } catch {}
}
