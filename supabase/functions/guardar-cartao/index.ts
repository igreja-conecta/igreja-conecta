// Guarda no Storage o cartão de aniversário gerado às 7h (scripts/enviar-aniversarios.mjs) e
// devolve o endereço público dele, usado no e-mail, na notificação do celular e no sininho.
// Só o envio chama: precisa do mesmo ENVIO_SECRET dos lembretes (cabeçalho x-envio-secret).
// O arquivo vai para igrejas/cartoes/<igreja>/<nome sorteado>.jpg (ninguém adivinha o endereço).
// A cada chamada, apaga os cartões da igreja com mais de 40 dias.
// Publicada pelo workflow funcoes.yml.

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_BYTES = 3 * 1024 * 1024;
const KEEP_DAYS = 40;

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Compara sem revelar pelo tempo quantas letras acertou.
function sameSecret(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });
  const secret = Deno.env.get('ENVIO_SECRET');
  if (!secret) return reply(503, { error: 'Envio não configurado.' });
  if (!sameSecret(req.headers.get('x-envio-secret') ?? '', secret)) return reply(401, { error: 'Sem permissão.' });

  const slug = new URL(req.url).searchParams.get('igreja') ?? '';
  if (!SLUG.test(slug) || slug.length > 60) return reply(400, { error: 'Igreja inválida.' });

  const bytes = new Uint8Array(await req.arrayBuffer());
  // Só JPEG (começa com FF D8 FF), até 3 MB.
  if (bytes.length < 100 || bytes.length > MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return reply(400, { error: 'Imagem inválida.' });
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const auth = { Authorization: `Bearer ${key}`, apikey: key };
  const folder = `cartoes/${slug}`;
  const path = `${folder}/${crypto.randomUUID()}.jpg`;

  const up = await fetch(`${url}/storage/v1/object/igrejas/${path}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=31536000', 'x-upsert': 'false' },
    body: bytes,
  });
  if (!up.ok) {
    console.error('upload', up.status, (await up.text()).slice(0, 300));
    return reply(502, { error: 'Não foi possível guardar o cartão.' });
  }

  // Limpeza dos cartões antigos desta igreja (não atrasa a resposta se falhar).
  try {
    const list = await fetch(`${url}/storage/v1/object/list/igrejas`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: folder, limit: 200, sortBy: { column: 'created_at', order: 'asc' } }),
    });
    const files: { name: string; created_at?: string }[] = list.ok ? await list.json() : [];
    const limit = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    const old = files.filter((f) => f.created_at && Date.parse(f.created_at) < limit).map((f) => `${folder}/${f.name}`);
    if (old.length) {
      await fetch(`${url}/storage/v1/object/igrejas`, {
        method: 'DELETE',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: old }),
      });
    }
  } catch (err) {
    console.error('limpeza', (err as Error).message);
  }

  return reply(200, { url: `${url}/storage/v1/object/public/igrejas/${path}` });
});
