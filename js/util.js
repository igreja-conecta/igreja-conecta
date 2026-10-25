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

// Texto sem acentos e em minúsculas, para buscas e nomes de colunas.
export const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

// Data de nascimento digitada ("15/03/1980", "15-3-80", "1980-03-15") → "1980-03-15", ou null.
// Ano com dois dígitos: até o ano atual vira 20xx, depois 19xx.
export function parseBirthDate(s, today = new Date()) {
  const t = String(s ?? '').trim();
  let y, m, d;
  let r;
  if ((r = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, m, d] = r;
  else if ((r = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) [, d, m, y] = r;
  else return null;
  y = Number(y);
  m = Number(m);
  d = Number(d);
  if (y < 100) y += y <= today.getFullYear() % 100 ? 2000 : 1900;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (y < 1900 || date > today) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// CSV de planilha (Excel em português usa ";"). Aceita aspas, quebras de linha dentro de aspas e BOM.
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0];
  const count = (c) => firstLine.split(c).length - 1;
  const sep = [';', ',', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const COLUMNS = {
  name: ['nome', 'nome completo', 'membro'],
  email: ['email', 'e-mail', 'e mail'],
  phone: ['telefone', 'celular', 'whatsapp', 'fone', 'tel'],
  birth_date: ['nascimento', 'data de nascimento', 'data nascimento', 'aniversario', 'data'],
};
export const MEMBERS_CSV_TEMPLATE = 'nome;email;telefone;nascimento\r\nMaria da Silva;maria@exemplo.com;(61) 99999-0000;15/03/1980\r\n';

// Planilha de membros → linhas prontas para gravar, cada uma com os seus erros.
// "existingEmails": e-mails (minúsculos) que a igreja já tem; essas linhas são puladas.
export function parseMembersCsv(text, existingEmails = new Set(), today = new Date()) {
  const [header = [], ...lines] = parseCsv(text);
  const index = {};
  header.forEach((h, i) => {
    const key = Object.keys(COLUMNS).find((k) => COLUMNS[k].includes(fold(h)));
    if (key && index[key] === undefined) index[key] = i;
  });
  if (index.name === undefined) return { error: 'A planilha precisa de uma coluna "nome" na primeira linha.', rows: [] };

  const seen = new Set();
  const rows = lines.map((cells, i) => {
    const get = (k) => (index[k] === undefined ? '' : String(cells[index[k]] ?? '').trim());
    const errors = [];
    const name = get('name').replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 120) errors.push('nome inválido');
    const email = get('email').toLowerCase() || null;
    if (email && !EMAIL_RE.test(email)) errors.push('e-mail inválido');
    const phoneRaw = get('phone');
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) errors.push('telefone inválido');
    const birthRaw = get('birth_date');
    const birth_date = birthRaw ? parseBirthDate(birthRaw, today) : null;
    if (birthRaw && !birth_date) errors.push('data de nascimento inválida');
    let skip = null;
    if (email && existingEmails.has(email)) skip = 'já cadastrado';
    else if (email && seen.has(email)) skip = 'e-mail repetido na planilha';
    if (email) seen.add(email);
    return { line: i + 2, name, email, phone, birth_date, errors, skip };
  });
  return { rows };
}

export const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || '';

// Campos da mensagem de aniversário: {nome}, {primeiro_nome}, {igreja}, {idade}.
export const MESSAGE_FIELDS = ['nome', 'primeiro_nome', 'igreja', 'idade'];

export function renderMessage(template, { name, church, age }) {
  const values = { nome: name, primeiro_nome: firstName(name), igreja: church, idade: age ?? '' };
  return String(template ?? '')
    .replace(/\{(\w+)\}/g, (all, key) => (key in values ? String(values[key]) : all))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// "Hoje: Ana e João" / "Ana, João e Maria"
export function joinNames(names) {
  const list = names.map(firstName);
  return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} e ${list.at(-1)}`;
}
