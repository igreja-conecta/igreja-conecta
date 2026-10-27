// Funções puras do app, testadas sem navegador.
import { test, expect } from '@playwright/test';
import { slugify, isValidSlug, churchSlugFromPath, inkOn, readableOnWhite, normalizePhone, fmtPhone, esc } from '../js/util.js';
import { pixPayload, normalizePixKey, guessPixType, crc16, parseAmount } from '../js/pix.js';

test('endereço da igreja a partir do nome', () => {
  expect(slugify('Igreja Batista Central')).toBe('igreja-batista-central');
  expect(slugify('  Comunidade Cristã São João!  ')).toBe('comunidade-crista-sao-joao');
  expect(slugify('A'.repeat(60))).toHaveLength(40);
  expect(isValidSlug('exemplo')).toBe(true);
  for (const bad of ['ab', 'Exemplo', 'com espaço', '-inicio', 'fim-', 'dois--hifens', 'a'.repeat(41)]) {
    expect(isValidSlug(bad), bad).toBe(false);
  }
});

test('igreja da página pelo caminho', () => {
  expect(churchSlugFromPath('/i/exemplo/')).toBe('exemplo');
  expect(churchSlugFromPath('/repositorio/i/batista-central/')).toBe('batista-central');
  expect(churchSlugFromPath('/repositorio/i/exemplo/index.html')).toBe('exemplo');
  expect(churchSlugFromPath('/repositorio/')).toBe(null);
  expect(churchSlugFromPath('/i/')).toBe(null);
});

test('texto legível sobre a cor da igreja', () => {
  expect(inkOn('#3b5bdb')).toBe('#ffffff');
  expect(inkOn('#ffd43b')).toBe('#111111');
  expect(readableOnWhite('#3b5bdb')).toBe(true);
  expect(readableOnWhite('#ffe066')).toBe(false);
});

test('telefone no formato do banco', () => {
  expect(normalizePhone('(61) 99999-8888')).toBe('5561999998888');
  expect(normalizePhone('61 3333-4444')).toBe('556133334444');
  expect(normalizePhone('+55 61 99999-8888')).toBe('5561999998888');
  expect(normalizePhone('9999')).toBe(null);
  expect(fmtPhone('5561999998888')).toBe('(61) 99999-8888');
});

test('textos escapados antes de ir para a tela', () => {
  expect(esc('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('datas de nascimento digitadas de vários jeitos', async () => {
  const { parseBirthDate, fmtDate } = await import('../js/util.js');
  const today = new Date('2026-10-25T12:00:00Z');
  expect(parseBirthDate('15/03/1980', today)).toBe('1980-03-15');
  expect(parseBirthDate('5/3/80', today)).toBe('1980-03-05');
  expect(parseBirthDate('01-02-05', today)).toBe('2005-02-01');
  expect(parseBirthDate('1980-03-15', today)).toBe('1980-03-15');
  expect(parseBirthDate('29/02/2000', today)).toBe('2000-02-29');
  for (const bad of ['29/02/2001', '32/01/1990', '15/13/1990', '01/01/1899', '01/01/2030', 'ontem', '']) {
    expect(parseBirthDate(bad, today), bad).toBe(null);
  }
  expect(fmtDate('1980-03-15')).toBe('15/03/1980');
});

test('planilha CSV do Excel e do Google Planilhas', async () => {
  const { parseCsv } = await import('../js/util.js');
  expect(parseCsv('﻿nome;email\r\nAna;ana@x.com\r\n\r\n')).toEqual([['nome', 'email'], ['Ana', 'ana@x.com']]);
  expect(parseCsv('nome,obs\n"Silva, João","disse ""oi""\nem duas linhas"')).toEqual([
    ['nome', 'obs'],
    ['Silva, João', 'disse "oi"\nem duas linhas'],
  ]);
  expect(parseCsv('nome\tidade\nAna\t30')).toEqual([['nome', 'idade'], ['Ana', '30']]);
});

test('importação de membros: colunas, erros e repetidos', async () => {
  const { parseMembersCsv } = await import('../js/util.js');
  const csv = [
    'Nome Completo;E-mail;Celular;Data de Nascimento',
    'Maria  da Silva;MARIA@x.com;(61) 99999-0000;15/03/1980',
    'J;joao@;123;31/02/1990',
    'Pedro;maria@x.com;;',
    'Ana;ana@igreja.com;;',
  ].join('\n');
  const { rows, error } = parseMembersCsv(csv, new Set(['ana@igreja.com']), new Date('2026-10-25'));
  expect(error).toBeUndefined();
  expect(rows[0]).toEqual({ line: 2, name: 'Maria da Silva', email: 'maria@x.com', phone: '5561999990000', birth_date: '1980-03-15', wedding_date: null, baptism_date: null, errors: [], skip: null });
  expect(rows[1].errors).toEqual(['nome inválido', 'e-mail inválido', 'telefone inválido', 'data de nascimento inválida']);
  expect(rows[2].skip).toBe('e-mail repetido na planilha');
  expect(rows[3].skip).toBe('já cadastrado');
  expect(parseMembersCsv('email;telefone\na@b.com;1').error).toMatch(/coluna "nome"/);
});

test('importação de membros com as datas de casamento e batismo', async () => {
  const { parseMembersCsv } = await import('../js/util.js');
  const csv = 'nome;nascimento;casamento;Data de Batismo\nAna Souza;15/03/1980;12/06/2005;20/06/1995\nBia;;31/02/2005;2030-01-01';
  const { rows } = parseMembersCsv(csv, new Set(), new Date('2026-10-25'));
  expect(rows[0]).toMatchObject({ birth_date: '1980-03-15', wedding_date: '2005-06-12', baptism_date: '1995-06-20', errors: [] });
  expect(rows[1].errors).toEqual(['data de casamento inválida', 'data de batismo inválida']);
});

test('mensagem de aniversário com os campos da igreja', async () => {
  const { renderMessage, joinNames } = await import('../js/util.js');
  const data = { name: 'Maria  da Silva', church: 'Igreja Exemplo', age: 40 };
  expect(renderMessage('Feliz aniversário, {primeiro_nome}!', data)).toBe('Feliz aniversário, Maria!');
  expect(renderMessage('{nome} faz {idade} anos na {igreja}. {outro}', data)).toBe('Maria da Silva faz 40 anos na Igreja Exemplo. {outro}');
  expect(renderMessage('Parabéns {primeiro_nome} {idade}', { name: 'Ana', church: 'X' })).toBe('Parabéns Ana');
  expect(renderMessage('Hoje você completa {anos} de casamento!', { ...data, age: 10 })).toBe('Hoje você completa 10 anos de casamento!');
  expect(renderMessage('{anos} de batismo', { ...data, age: 1 })).toBe('1 ano de batismo');
  expect(joinNames(['Ana Souza'])).toBe('Ana');
  expect(joinNames(['Ana Souza', 'João', 'Maria Clara'])).toBe('Ana, João e Maria');
});

test('adicionar à agenda: arquivo .ics e link do Google Agenda', async () => {
  const { icsForEvent, googleCalendarUrl } = await import('../js/util.js');
  const ev = {
    event_id: 'abc',
    title: 'Culto de domingo, com Santa Ceia',
    description: 'Traga a família',
    location: 'Templo; salão principal',
    starts_at: '2027-03-14T22:00:00Z',
    ends_at: null,
    repeat_weekly: true,
    repeat_until: '2027-12-31',
    remind_minutes: 120,
  };
  const opts = { church: 'Igreja Exemplo', url: 'https://x/i/exemplo/', now: new Date('2027-01-01T00:00:00Z') };
  const ics = icsForEvent(ev, opts);
  expect(ics).toContain('DTSTART:20270314T220000Z\r\n');
  expect(ics).toContain('DTEND:20270315T000000Z\r\n');
  expect(ics).toContain('RRULE:FREQ=WEEKLY;UNTIL=20271231T235959Z\r\n');
  expect(ics).toContain('SUMMARY:Culto de domingo\\, com Santa Ceia\r\n');
  expect(ics).toContain('LOCATION:Templo\\; salão principal\r\n');
  expect(ics).toContain('TRIGGER:-PT120M');
  expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);

  const g = new URL(googleCalendarUrl(ev, opts));
  expect(g.searchParams.get('dates')).toBe('20270314T220000Z/20270315T000000Z');
  expect(g.searchParams.get('recur')).toBe('RRULE:FREQ=WEEKLY;UNTIL=20271231T235959Z');
  const once = icsForEvent({ ...ev, repeat_weekly: false, repeat_until: null, remind_minutes: 0, location: null }, opts);
  expect(once).not.toContain('RRULE');
  expect(once).not.toContain('VALARM');
  expect(once).not.toContain('LOCATION');
});

test.describe('Pix (BR Code)', () => {
  test('gera exatamente o exemplo do manual do Banco Central', () => {
    expect(pixPayload({ key: '123e4567-e12b-12d1-a456-426655440000', name: 'Fulano de Tal', city: 'BRASILIA' })).toBe(
      '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D',
    );
  });

  test('inclui o valor e remove acentos do nome e da cidade', () => {
    const p = pixPayload({ key: '+5561999998888', name: 'Comunidade Cristã São João', city: 'Brasília', amount: 150.5 });
    expect(p).toContain('5406150.50');
    expect(p).toContain('5925Comunidade Crista Sao Joa');
    expect(p).toContain('6008Brasilia');
    expect(p.slice(-4)).toBe(crc16(p.slice(0, -4)));
  });

  test('sem valor, quem oferta digita no banco', () => {
    expect(pixPayload({ key: 'a@b.com', name: 'X', amount: 0 })).not.toContain('5406');
  });

  test('normaliza e valida chaves', () => {
    expect(normalizePixKey('celular', '(61) 99999-8888')).toBe('+5561999998888');
    expect(normalizePixKey('celular', '+55 61 99999-8888')).toBe('+5561999998888');
    expect(normalizePixKey('cpf', '12.345.678/0001-90')).toBe('12345678000190');
    expect(normalizePixKey('email', ' Igreja@Mail.com ')).toBe('igreja@mail.com');
    expect(normalizePixKey('aleatoria', '123E4567-E12B-12D1-A456-426655440000')).toBe('123e4567-e12b-12d1-a456-426655440000');
    expect(normalizePixKey('cpf', '123')).toBeNull();
    expect(normalizePixKey('email', 'sem-arroba')).toBeNull();
    expect(guessPixType('+5561999998888')).toBe('celular');
    expect(guessPixType('12345678000190')).toBe('cpf');
  });

  test('valor digitado em reais', () => {
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('50')).toBe(50);
    expect(parseAmount('50,5')).toBe(50.5);
    expect(parseAmount('R$ 1.234,56')).toBe(1234.56);
    expect(parseAmount('10.5')).toBe(10.5);
    expect(parseAmount('1.234')).toBe(1234);
    for (const bad of ['abc', '-5', '0', '1,234', '12,345', '1.23.4']) expect(parseAmount(bad), bad).toBeNull();
  });
});

test('rota até o local: pelo alfinete ou pelo endereço; on-line não tem rota', async () => {
  const { routeLinks, placeBlock } = await import('../js/map.js');
  expect(routeLinks({ lat: -15.7942, lng: -47.8822, address: 'Templo' })).toEqual({
    google: 'https://www.google.com/maps/dir/?api=1&destination=-15.7942,-47.8822',
    waze: 'https://waze.com/ul?ll=-15.7942,-47.8822&navigate=yes',
  });
  expect(routeLinks({ lat: null, lng: null, address: 'Rua das Flores, 10' })).toEqual({
    google: 'https://www.google.com/maps/dir/?api=1&destination=Rua%20das%20Flores%2C%2010',
    waze: 'https://waze.com/ul?q=Rua%20das%20Flores%2C%2010&navigate=yes',
  });
  expect(placeBlock({ lat: null, lng: null, address: 'On-line' })).toBe('');
  expect(placeBlock({ lat: null, lng: null, address: '' })).toBe('');
  expect(placeBlock({ lat: null, lng: null, address: 'Templo' })).not.toContain('place-map');
  expect(placeBlock({ lat: 1, lng: 2, address: '' })).toContain('data-lat="1"');
});

test('regras de segurança das páginas (CSP): os scripts do 404.html batem com a impressão digital', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const page = readFileSync(new URL('../404.html', import.meta.url), 'utf8');
  const csp = page.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  for (const [, code] of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    expect(csp).toContain(`'sha256-${createHash('sha256').update(code).digest('base64')}'`);
  }
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  expect(index).toMatch(/http-equiv="Content-Security-Policy"[^>]*object-src 'none'/);
  expect(index).not.toMatch(/<script>(?!\s*<\/script>)/); // nenhum script escrito dentro da página
  // Nem comandos no HTML das telas (onclick="..."): a CSP bloquearia.
  for (const file of ['app.js', 'map.js', 'install.js', 'push.js', 'pix.js', 'biblia.js']) {
    const code = readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
    expect(code, file).not.toMatch(/\son[a-z]+="/);
  }
});

test('planos de leitura: cada plano lê todos os capítulos uma vez só, no número de dias do banco', async () => {
  const { readFileSync } = await import('node:fs');
  const { BOOKS, READING_PLANS, planReading, readingLabel } = await import('../js/biblia.js');
  expect(BOOKS).toHaveLength(66);
  expect(BOOKS.reduce((n, b) => n + b[2], 0)).toBe(1189);
  // Os mesmos planos e dias do supabase/014_devocional.sql.
  const sql = readFileSync(new URL('../supabase/014_devocional.sql', import.meta.url), 'utf8');
  for (const [key, plan] of Object.entries(READING_PLANS)) {
    expect(sql, key).toContain(`when '${key}' then ${plan.days}`);
    expect(sql, key).toContain(`when '${key}' then '${plan.title}'`);
    const read = [];
    for (let day = 1; day <= plan.days; day++) {
      const parts = planReading(key, day);
      expect(parts.length, `${key} dia ${day}`).toBeGreaterThan(0);
      for (const p of parts) for (let c = p.from; c <= p.to; c++) read.push(`${p.book}.${c}`);
    }
    const all = plan.tracks.flat().map(([b, c]) => `${b}.${c}`);
    expect(read.sort(), key).toEqual(all.sort());
    expect(planReading(key, 0)).toEqual([]);
    expect(planReading(key, plan.days + 1)).toEqual([]);
  }
  expect(readingLabel(planReading('biblia-1-ano', 1))).toBe('Gênesis 1–3');
  expect(readingLabel(planReading('biblia-1-ano', 365))).toBe('Apocalipse 19–22');
  expect(readingLabel(planReading('salmos-proverbios', 1))).toBe('Salmos 1–4; Provérbios 1');
  expect(readingLabel(planReading('evangelhos-30', 30))).toBe('João 19–21');
});

test('links da Bíblia (YouVersion) e referência do versículo', async () => {
  const { bibleUrl, verseRef, passageLabel } = await import('../js/biblia.js');
  expect(bibleUrl('NVI', 'JHN', 3, '16')).toBe('https://www.bible.com/bible/129/JHN.3.16.NVI');
  expect(bibleUrl('ARA', 'PSA', 23)).toBe('https://www.bible.com/bible/1608/PSA.23.ARA');
  expect(bibleUrl('XYZ', 'GEN', 1)).toBe('https://www.bible.com/bible/129/GEN.1.NVI');
  expect(verseRef({ verse_book: 'JHN', verse_chapter: 3, verse_from: 16, verse_to: 18 })).toBe('João 3:16-18');
  expect(verseRef({ verse_book: 'PSA', verse_chapter: 23, verse_from: null, verse_to: null })).toBe('Salmos 23');
  expect(verseRef({ verse_book: null })).toBe('');
  expect(passageLabel({ book: 'OBA', from: 1, to: 1 })).toBe('Obadias');
  expect(passageLabel({ book: 'GEN', from: 50, to: 50 })).toBe('Gênesis 50');
});
