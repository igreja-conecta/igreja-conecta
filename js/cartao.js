// Cartão de aniversário (e de casamento e batismo): a imagem da igreja com o título e a mensagem
// escritos por cima. O mesmo desenho serve para a prévia no app (canvas do navegador) e para o
// envio das 7h (scripts/enviar-aniversarios.mjs, com @napi-rs/canvas): o que a liderança vê na
// prévia é o que chega no e-mail, na notificação do Android e no sininho.
// Sem nada do navegador aqui (nem document, nem window): roda também no Node.

export const CARD_WIDTH = 1080;
export const CARD_POSITIONS = { topo: 'Em cima', meio: 'No meio', base: 'Embaixo' };
export const CARD_COLORS = { claro: 'Texto branco', escuro: 'Texto escuro' };

// Letras do sistema (como no app) e, no servidor, as do Linux; emojis coloridos no fim.
const FONT =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "DejaVu Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';

// Altura do cartão: a da imagem, na largura fixa. Imagem muito comprida ou muito achatada é cortada
// no meio (como "cobrir"), para o texto sempre caber e o e-mail não ficar enorme.
export function cardSize(imgWidth, imgHeight) {
  const ratio = imgWidth > 0 && imgHeight > 0 ? imgHeight / imgWidth : 1;
  const height = Math.round(CARD_WIDTH * Math.min(1.5, Math.max(0.5, ratio)));
  return { width: CARD_WIDTH, height };
}

// Quebra o texto em linhas que cabem na largura (respeita as quebras de linha da mensagem).
function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth || !line) line = test;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  // Tira linhas vazias do começo e do fim (mantém as do meio, que separam parágrafos).
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines;
}

// Desenha o cartão inteiro em ctx (do tamanho de cardSize). img: imagem já carregada.
// title e body já vêm com os campos trocados ({nome}, {idade}...).
export function drawCard(ctx, img, { title, body, position = 'meio', color = 'claro' }, width, height) {
  // Fundo: a imagem cobrindo o cartão, cortada no meio se a proporção não bater.
  const iw = img.naturalWidth || img.width || width;
  const ih = img.naturalHeight || img.height || height;
  const scale = Math.max(width / iw, height / ih);
  const sw = width / scale;
  const sh = height / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, width, height);

  const pad = Math.round(width * 0.08);
  const maxWidth = width - pad * 2;
  const maxHeight = height - pad * 2;

  // Diminui as letras até o texto caber no cartão.
  let k = 1;
  let layout;
  for (let i = 0; i < 12; i++) {
    const titleSize = Math.round(width * 0.072 * k);
    const bodySize = Math.round(width * 0.046 * k);
    ctx.font = `700 ${titleSize}px ${FONT}`;
    const titleLines = wrap(ctx, title, maxWidth);
    ctx.font = `400 ${bodySize}px ${FONT}`;
    const bodyLines = wrap(ctx, body, maxWidth);
    const titleLead = titleSize * 1.18;
    const bodyLead = bodySize * 1.4;
    const gap = titleLines.length && bodyLines.length ? bodySize * 0.9 : 0;
    const total = titleLines.length * titleLead + gap + bodyLines.length * bodyLead;
    layout = { titleSize, bodySize, titleLines, bodyLines, titleLead, bodyLead, gap, total };
    if (total <= maxHeight) break;
    k *= 0.88;
  }

  const { titleSize, bodySize, titleLines, bodyLines, titleLead, bodyLead, gap, total } = layout;
  let y = position === 'topo' ? pad : position === 'base' ? height - pad - total : (height - total) / 2;

  const light = color !== 'escuro';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = light ? '#ffffff' : '#1b1e27';
  // Sombra suave em volta das letras: lê bem em cima de foto clara ou escura.
  ctx.shadowColor = light ? 'rgba(0, 0, 0, 0.65)' : 'rgba(255, 255, 255, 0.8)';
  ctx.shadowBlur = Math.round(width * 0.014);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = Math.round(width * 0.002);

  ctx.font = `700 ${titleSize}px ${FONT}`;
  for (const line of titleLines) {
    ctx.fillText(line, width / 2, y);
    y += titleLead;
  }
  y += gap;
  ctx.font = `400 ${bodySize}px ${FONT}`;
  for (const line of bodyLines) {
    ctx.fillText(line, width / 2, y);
    y += bodyLead;
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
}
