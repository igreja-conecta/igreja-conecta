// Funções pequenas e sem dependência do navegador (testadas em tests/units.spec.mjs).

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Mesma regra do banco (churches.slug): letras minúsculas, números e hífens, de 3 a 40.
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const isValidSlug = (s) => SLUG_RE.test(s) && s.length >= 3 && s.length <= 40;

export function slugify(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

// Igreja da página: o endereço é .../i/<slug>/
export function churchSlugFromPath(pathname) {
  const m = String(pathname).match(/\/i\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?(?:index\.html)?$/);
  return m ? m[1] : null;
}

// "#3b5bdb" → [59, 91, 219]
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a, b) {
  const [l1, l2] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// Cor do texto em cima da cor da igreja: branco ou quase preto, o que ler melhor.
export const inkOn = (hex) => (contrastRatio(hex, '#ffffff') >= contrastRatio(hex, '#111111') ? '#ffffff' : '#111111');

// Aviso para o admin: cor clara demais para botões e links sobre fundo branco.
export const readableOnWhite = (hex) => contrastRatio(hex, '#ffffff') >= 3;

export const onlyDigits = (s) => String(s ?? '').replace(/\D/g, '');

// Telefone no formato do banco: 55 + DDD + número (12 ou 13 dígitos).
export function normalizePhone(s) {
  let d = onlyDigits(s);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return /^55\d{10,11}$/.test(d) ? d : null;
}

export function fmtPhone(d) {
  const m = String(d ?? '').match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : d || '';
}

export const ROLES = {
  admin: 'Administrador',
  secretaria: 'Secretaria',
  lider: 'Líder',
  membro: 'Membro',
};
export const isLeaderRole = (role) => ['admin', 'secretaria', 'lider'].includes(role);

// Funcionalidades que cada igreja liga ou desliga. "phase" > 1: ainda não disponível.
export const FEATURES = [
  { key: 'aniversarios', label: 'Aniversariantes', phase: 1 },
  { key: 'agenda', label: 'Agenda de cultos e eventos', phase: 1 },
  { key: 'avisos', label: 'Mural de avisos', phase: 1 },
  { key: 'datas_especiais', label: 'Aniversário de casamento e batismo', phase: 2 },
  { key: 'oracao', label: 'Pedidos de oração', phase: 2 },
  { key: 'escalas', label: 'Escalas de ministérios', phase: 2 },
  { key: 'pix', label: 'Dízimos e ofertas por Pix', phase: 2 },
  { key: 'visitantes', label: 'Cadastro de visitantes', phase: 2 },
  { key: 'celulas', label: 'Células e pequenos grupos', phase: 3 },
  { key: 'inscricoes', label: 'Inscrições em eventos', phase: 3 },
  { key: 'infantil', label: 'Check-in do ministério infantil', phase: 3 },
  { key: 'carteirinha', label: 'Carteirinha digital', phase: 3 },
  { key: 'relatorios', label: 'Relatórios', phase: 3 },
  { key: 'galeria', label: 'Galeria de fotos', phase: 3 },
  { key: 'devocional', label: 'Devocional e plano de leitura', phase: 3 },
];
