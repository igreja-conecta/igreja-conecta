// Contagem de quem entra (js/contagem.js): o detector de pessoas roda aqui, fora da tela, para não
// atrapalhar o reconhecimento do rosto que roda junto no totem. Recebe quadros reduzidos
// (ImageBitmap) e devolve as caixas das pessoas em fração da imagem. Nada é guardado.
let det = null;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      const { FilesetResolver, ObjectDetector } = await import(`${msg.mp}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`${msg.mp}/wasm`);
      det = await ObjectDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: msg.model, delegate: 'CPU' },
        runningMode: 'VIDEO',
        scoreThreshold: msg.minScore,
        categoryAllowlist: ['person'],
        maxResults: 20,
      });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
    return;
  }
  if (msg.type === 'frame') {
    const { bitmap, at } = msg;
    let boxes = [];
    try {
      const w = bitmap.width;
      const h = bitmap.height;
      boxes = det.detectForVideo(bitmap, at).detections.map((d) => {
        const b = d.boundingBox;
        return { x: b.originX / w, y: b.originY / h, w: b.width / w, h: b.height / h, score: d.categories[0]?.score ?? 0 };
      });
    } catch {}
    bitmap.close();
    self.postMessage({ type: 'boxes', boxes });
  }
};
