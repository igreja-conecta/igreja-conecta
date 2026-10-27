// Livros da Bíblia, planos de leitura prontos e links para ler na YouVersion.
// O texto bíblico não fica no app (as traduções em português têm direitos autorais).

// [código da YouVersion, nome, capítulos]
export const BOOKS = [
  ['GEN', 'Gênesis', 50], ['EXO', 'Êxodo', 40], ['LEV', 'Levítico', 27], ['NUM', 'Números', 36], ['DEU', 'Deuteronômio', 34],
  ['JOS', 'Josué', 24], ['JDG', 'Juízes', 21], ['RUT', 'Rute', 4], ['1SA', '1 Samuel', 31], ['2SA', '2 Samuel', 24],
  ['1KI', '1 Reis', 22], ['2KI', '2 Reis', 25], ['1CH', '1 Crônicas', 29], ['2CH', '2 Crônicas', 36], ['EZR', 'Esdras', 10],
  ['NEH', 'Neemias', 13], ['EST', 'Ester', 10], ['JOB', 'Jó', 42], ['PSA', 'Salmos', 150], ['PRO', 'Provérbios', 31],
  ['ECC', 'Eclesiastes', 12], ['SNG', 'Cânticos', 8], ['ISA', 'Isaías', 66], ['JER', 'Jeremias', 52], ['LAM', 'Lamentações', 5],
  ['EZK', 'Ezequiel', 48], ['DAN', 'Daniel', 12], ['HOS', 'Oseias', 14], ['JOL', 'Joel', 3], ['AMO', 'Amós', 9],
  ['OBA', 'Obadias', 1], ['JON', 'Jonas', 4], ['MIC', 'Miqueias', 7], ['NAM', 'Naum', 3], ['HAB', 'Habacuque', 3],
  ['ZEP', 'Sofonias', 3], ['HAG', 'Ageu', 2], ['ZEC', 'Zacarias', 14], ['MAL', 'Malaquias', 4],
  ['MAT', 'Mateus', 28], ['MRK', 'Marcos', 16], ['LUK', 'Lucas', 24], ['JHN', 'João', 21], ['ACT', 'Atos', 28],
  ['ROM', 'Romanos', 16], ['1CO', '1 Coríntios', 16], ['2CO', '2 Coríntios', 13], ['GAL', 'Gálatas', 6], ['EPH', 'Efésios', 6],
  ['PHP', 'Filipenses', 4], ['COL', 'Colossenses', 4], ['1TH', '1 Tessalonicenses', 5], ['2TH', '2 Tessalonicenses', 3],
  ['1TI', '1 Timóteo', 6], ['2TI', '2 Timóteo', 4], ['TIT', 'Tito', 3], ['PHM', 'Filemom', 1], ['HEB', 'Hebreus', 13],
  ['JAS', 'Tiago', 5], ['1PE', '1 Pedro', 5], ['2PE', '2 Pedro', 3], ['1JN', '1 João', 5], ['2JN', '2 João', 1],
  ['3JN', '3 João', 1], ['JUD', 'Judas', 1], ['REV', 'Apocalipse', 22],
];
const BOOK = Object.fromEntries(BOOKS.map(([code, name, chapters]) => [code, { name, chapters }]));
export const bookName = (code) => BOOK[code]?.name ?? '';
export const bookChapters = (code) => BOOK[code]?.chapters ?? 0;

// Traduções da igreja: sigla -> número da tradução na YouVersion.
export const BIBLE_VERSIONS = {
  NVI: ['Nova Versão Internacional (NVI)', 129],
  ARA: ['Almeida Revista e Atualizada (ARA)', 1608],
  NAA: ['Nova Almeida Atualizada (NAA)', 1840],
  NTLH: ['Nova Tradução na Linguagem de Hoje (NTLH)', 211],
  ARC: ['Almeida Revista e Corrigida (ARC)', 212],
  NVT: ['Nova Versão Transformadora (NVT)', 1930],
};

// Link para ler na YouVersion (abre o app, se estiver instalado).
export function bibleUrl(version, book, chapter, verse) {
  const id = (BIBLE_VERSIONS[version] || BIBLE_VERSIONS.NVI)[1];
  return `https://www.bible.com/bible/${id}/${book}.${chapter}${verse ? `.${verse}` : ''}.${BIBLE_VERSIONS[version] ? version : 'NVI'}`;
}

// "João 3:16-18", "Salmos 23", "João 3".
export function verseRef({ verse_book, verse_chapter, verse_from, verse_to }) {
  if (!verse_book) return '';
  const v = verse_from ? `:${verse_from}${verse_to && verse_to !== verse_from ? `-${verse_to}` : ''}` : '';
  return `${bookName(verse_book)} ${verse_chapter}${v}`;
}

// Todos os capítulos de um trecho de livros, em ordem: [[livro, capítulo], ...]
const chaptersOf = (from, to) => {
  const out = [];
  const i0 = BOOKS.findIndex((b) => b[0] === from);
  const i1 = BOOKS.findIndex((b) => b[0] === to);
  for (const [code, , n] of BOOKS.slice(i0, i1 + 1)) for (let c = 1; c <= n; c++) out.push([code, c]);
  return out;
};

// Planos prontos. Cada plano tem uma ou mais "trilhas" lidas em paralelo, divididas por igual
// entre os dias. Os nomes e o número de dias são os mesmos do banco (supabase/014_devocional.sql).
export const READING_PLANS = {
  'biblia-1-ano': { title: 'Bíblia em 1 ano', days: 365, tracks: [chaptersOf('GEN', 'REV')], about: 'De Gênesis a Apocalipse, uns 3 capítulos por dia.' },
  'nt-90': { title: 'Novo Testamento em 90 dias', days: 90, tracks: [chaptersOf('MAT', 'REV')], about: 'De Mateus a Apocalipse, uns 3 capítulos por dia.' },
  'salmos-proverbios': {
    title: 'Salmos e Provérbios em 31 dias',
    days: 31,
    tracks: [chaptersOf('PSA', 'PSA'), chaptersOf('PRO', 'PRO')],
    about: 'Cerca de 5 salmos e 1 capítulo de Provérbios por dia.',
  },
  'evangelhos-30': { title: 'Evangelhos em 30 dias', days: 30, tracks: [chaptersOf('MAT', 'JHN')], about: 'Mateus, Marcos, Lucas e João, 3 capítulos por dia.' },
};

// Leitura de um dia (1 = primeiro dia): [{ book, from, to }], juntando capítulos seguidos do mesmo livro.
export function planReading(key, day) {
  const plan = READING_PLANS[key];
  if (!plan || day < 1 || day > plan.days) return [];
  const out = [];
  for (const track of plan.tracks) {
    const start = Math.floor(((day - 1) * track.length) / plan.days);
    const end = Math.floor((day * track.length) / plan.days);
    for (const [book, c] of track.slice(start, end)) {
      const last = out[out.length - 1];
      if (last && last.book === book && last.to === c - 1) last.to = c;
      else out.push({ book, from: c, to: c });
    }
  }
  return out;
}

// "Gênesis 1–3", "Gênesis 50", "Obadias" (livro de um capítulo só).
export function passageLabel({ book, from, to }) {
  if (bookChapters(book) === 1) return bookName(book);
  return `${bookName(book)} ${from}${to !== from ? `–${to}` : ''}`;
}
export const readingLabel = (parts) => parts.map(passageLabel).join('; ');
