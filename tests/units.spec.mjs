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
