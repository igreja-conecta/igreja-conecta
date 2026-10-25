import { readFileSync } from 'node:fs';

// Lê a URL e a chave pública direto do js/config.js, para os testes usarem o mesmo projeto do site.
const config = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
const pick = (key) => config.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1];

export const SUPABASE_URL = pick('SUPABASE_URL');
export const ANON_KEY = pick('SUPABASE_ANON_KEY');
export const configured = !!ANON_KEY && !ANON_KEY.includes('COLE-AQUI');
export const headers = { apikey: ANON_KEY, 'Content-Type': 'application/json' };

export const rest = (path) => `${SUPABASE_URL}/rest/v1/${path}`;

// Senha das contas de teste: segredo TEST_USERS_PASSWORD no GitHub; no computador,
// o arquivo tests/senha-testes.local criado por scripts/criar-usuarios-de-teste.mjs.
export function testPassword() {
  if (process.env.TEST_USERS_PASSWORD) return process.env.TEST_USERS_PASSWORD;
  try {
    return readFileSync(new URL('./senha-testes.local', import.meta.url), 'utf8').trim();
  } catch {
    return null;
  }
}

export const testEmail = (user) => `${user}@teste.igrejaconecta.invalid`;

// Entra com uma conta de teste e devolve os cabeçalhos para falar com o banco como ela.
export async function loginAs(request, user) {
  const res = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    data: { email: testEmail(user), password: testPassword() },
  });
  if (!res.ok()) throw new Error(`Login de ${user} falhou (${res.status()}): ${await res.text()}. Rode supabase/usuarios-de-teste.local.sql.`);
  const { access_token, user: info } = await res.json();
  return {
    id: info.id,
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
  };
}
