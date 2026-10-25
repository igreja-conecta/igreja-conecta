// Funções puras do app, testadas sem navegador.
import { test, expect } from '@playwright/test';
import { slugify, isValidSlug, churchSlugFromPath, inkOn, readableOnWhite, normalizePhone, fmtPhone, esc } from '../js/util.js';

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
  expect(rows[0]).toEqual({ line: 2, name: 'Maria da Silva', email: 'maria@x.com', phone: '5561999990000', birth_date: '1980-03-15', errors: [], skip: null });
  expect(rows[1].errors).toEqual(['nome inválido', 'e-mail inválido', 'telefone inválido', 'data de nascimento inválida']);
  expect(rows[2].skip).toBe('e-mail repetido na planilha');
  expect(rows[3].skip).toBe('já cadastrado');
  expect(parseMembersCsv('email;telefone\na@b.com;1').error).toMatch(/coluna "nome"/);
});

test('mensagem de aniversário com os campos da igreja', async () => {
  const { renderMessage, joinNames } = await import('../js/util.js');
  const data = { name: 'Maria  da Silva', church: 'Igreja Exemplo', age: 40 };
  expect(renderMessage('Feliz aniversário, {primeiro_nome}!', data)).toBe('Feliz aniversário, Maria!');
  expect(renderMessage('{nome} faz {idade} anos na {igreja}. {outro}', data)).toBe('Maria da Silva faz 40 anos na Igreja Exemplo. {outro}');
  expect(renderMessage('Parabéns {primeiro_nome} {idade}', { name: 'Ana', church: 'X' })).toBe('Parabéns Ana');
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
