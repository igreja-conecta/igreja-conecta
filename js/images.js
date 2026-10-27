// Imagens reduzidas no aparelho antes do envio, e os ícones do app gerados a partir da logo.

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Não foi possível abrir esta imagem. Tente uma foto em JPG ou PNG.'));
    img.src = URL.createObjectURL(file);
  });
}

const encode = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// WebP quando o navegador sabe gerar; senão (Safari antigo), JPG.
export async function resizeImage(file, max = 1080, quality = 0.8) {
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  const webp = await encode(canvas, 'image/webp', quality);
  return webp && webp.type === 'image/webp' ? webp : encode(canvas, 'image/jpeg', quality);
}

// Logo com transparência continua PNG (a WebP do Safari antigo viraria JPG com fundo preto).
export async function resizeLogo(file, max = 512) {
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  const webp = await encode(canvas, 'image/webp', 0.9);
  return webp && webp.type === 'image/webp' ? webp : encode(canvas, 'image/png');
}

// Ícone quadrado: fundo da cor escolhida e a logo centralizada ocupando "fill" do lado.
async function square(img, size, background, fill) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);
  const box = size * fill;
  const scale = Math.min(box / img.naturalWidth, box / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return encode(canvas, 'image/png');
}

// Os quatro arquivos que a publicação do site copia para i/<igreja>/.
// O do iPhone (180x180) não pode ter transparência: o fundo é sempre pintado.
export async function makeIconSet(file, background) {
  const img = await loadImage(file);
  try {
    return {
      'icon-192.png': await square(img, 192, background, 0.84),
      'icon-512.png': await square(img, 512, background, 0.84),
      'icon-maskable-512.png': await square(img, 512, background, 0.6),
      'apple-touch-icon.png': await square(img, 180, background, 0.76),
    };
  } finally {
    URL.revokeObjectURL(img.src);
  }
}

// Galeria: foto grande leve (até ~300 KB; o banco recusa acima de 400 KB) e miniatura para a grade.
// Se a foto ficar pesada, reduz o tamanho e a qualidade até caber.
export async function resizeForGallery(file) {
  let big;
  for (const [max, quality] of [[1600, 0.72], [1280, 0.65], [1024, 0.6], [800, 0.55]]) {
    big = await resizeImage(file, max, quality);
    if (big.size <= 300 * 1024) break;
  }
  const mini = await resizeImage(file, 360, 0.6);
  return { big, mini, ext: big.type === 'image/webp' ? 'webp' : 'jpg' };
}
