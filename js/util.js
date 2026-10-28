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

// Funcionalidades que cada igreja liga ou desliga. "soon": ainda não disponível.
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
  { key: 'chat', label: 'Chat com a liderança', phase: 3 },
  { key: 'chat_membros', label: 'Chat: membros também conversam entre si', phase: 3 },
  { key: 'financeiro', label: 'Financeiro e prestação de contas', phase: 3 },
];

// Texto sem acentos e em minúsculas, para buscas e nomes de colunas.
export const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

// Data digitada (nascimento, casamento, batismo) ("15/03/1980", "15-3-80", "1980-03-15") → "1980-03-15", ou null.
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

// Centavos (como ficam no banco) em reais: 123456 → "R$ 1.234,56".
export const fmtMoney = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

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
  wedding_date: ['casamento', 'data de casamento', 'data casamento'],
  baptism_date: ['batismo', 'data de batismo', 'data batismo'],
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
    const weddingRaw = get('wedding_date');
    const wedding_date = weddingRaw ? parseBirthDate(weddingRaw, today) : null;
    if (weddingRaw && !wedding_date) errors.push('data de casamento inválida');
    const baptismRaw = get('baptism_date');
    const baptism_date = baptismRaw ? parseBirthDate(baptismRaw, today) : null;
    if (baptismRaw && !baptism_date) errors.push('data de batismo inválida');
    let skip = null;
    if (email && existingEmails.has(email)) skip = 'já cadastrado';
    else if (email && seen.has(email)) skip = 'e-mail repetido na planilha';
    if (email) seen.add(email);
    return { line: i + 2, name, email, phone, birth_date, wedding_date, baptism_date, errors, skip };
  });
  return { rows };
}

export const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || '';

// Campos da mensagem de aniversário: {nome}, {primeiro_nome}, {igreja}, {idade}.
export const MESSAGE_FIELDS = ['nome', 'primeiro_nome', 'igreja', 'idade'];
// Casamento e batismo: {anos} no lugar de {idade}.
export const SPECIAL_FIELDS = ['nome', 'primeiro_nome', 'igreja', 'anos'];
// "1 ano", "10 anos" (igual a public.years_text no banco).
export const yearsText = (n) => (n == null || n === '' ? '' : Number(n) === 1 ? '1 ano' : `${n} anos`);

// Atalhos na tela da mensagem; o teclado do celular também põe qualquer outro emoji.
export const MESSAGE_EMOJIS = ['🎂', '🎉', '🎈', '🎁', '🥳', '🙏', '🙌', '❤️', '😊', '✨', '🌟', '🌷', '🕊️', '✝️', '📖', '🎶'];

export function renderMessage(template, { name, church, age }) {
  const values = { nome: name, primeiro_nome: firstName(name), igreja: church, idade: age ?? '', anos: yearsText(age) };
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

// ---------------------------------------------------------------------
// "Adicionar à agenda": arquivo .ics (iPhone, Android, Outlook) e link do Google Agenda
// ---------------------------------------------------------------------
// 2027-03-14T22:00:00Z → 20270314T220000Z
const icsStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const endOf = (ev) => ev.ends_at || new Date(new Date(ev.starts_at).getTime() + 2 * 3600e3).toISOString();
const untilStamp = (date) => `${date.replace(/-/g, '')}T235959Z`;

const icsText = (t) => String(t ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Linhas do .ics têm no máximo 75 bytes; o resto continua na linha seguinte, começando com espaço.
function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let chunk = '';
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += ch;
    size += n;
  }
  out.push(chunk);
  return out.join('\r\n ');
}

export function icsForEvent(ev, { church, url, now = new Date() }) {
  const rrule = ev.repeat_weekly ? [`RRULE:FREQ=WEEKLY${ev.repeat_until ? `;UNTIL=${untilStamp(ev.repeat_until)}` : ''}`] : [];
  const alarm = ev.remind_minutes
    ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:-PT${ev.remind_minutes}M`, `DESCRIPTION:${icsText(ev.title)}`, 'END:VALARM']
    : [];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Igreja Conecta//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${ev.event_id || ev.id}@igreja-conecta`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(ev.starts_at)}`,
    `DTEND:${icsStamp(endOf(ev))}`,
    ...rrule,
    `SUMMARY:${icsText(ev.title)}`,
    ...(ev.location ? [`LOCATION:${icsText(ev.location)}`] : []),
    `DESCRIPTION:${icsText(`${ev.description ? `${ev.description}\n\n` : ''}${church}: ${url}`)}`,
    `URL:${url}`,
    ...alarm,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl(ev, { church, url }) {
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${icsStamp(ev.starts_at)}/${icsStamp(endOf(ev))}`,
    details: `${ev.description ? `${ev.description}\n\n` : ''}${church}: ${url}`,
    ctz: 'America/Sao_Paulo',
  });
  if (ev.location) q.set('location', ev.location);
  if (ev.repeat_weekly) q.set('recur', `RRULE:FREQ=WEEKLY${ev.repeat_until ? `;UNTIL=${untilStamp(ev.repeat_until)}` : ''}`);
  return `https://calendar.google.com/calendar/render?${q}`;
}

export const REMIND_OPTIONS = [
  [0, 'Sem lembrete'],
  [60, '1 hora antes'],
  [120, '2 horas antes'],
  [180, '3 horas antes'],
  [1440, '1 dia antes'],
];
