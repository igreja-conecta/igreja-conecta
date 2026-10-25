// Monta a pasta _site para o GitHub Pages e gera uma pasta por igreja em i/<slug>/,
// com manifest, ícones e título próprios: assim o app instalado na tela inicial
// aparece com o nome e a logo da igreja.
// Uso: SITE_URL=https://usuario.github.io/repositorio/ node scripts/build-site.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const OUT = '_site';
const STATIC = ['index.html', '404.html', 'privacidade.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons'];
const ICONS = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const p of STATIC) cpSync(p, `${OUT}/${p}`, { recursive: true });
writeFileSync(`${OUT}/.nojekyll`, '');

const config = readFileSync('js/config.js', 'utf8');
const pick = (key) => config.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1];
const SUPABASE_URL = pick('SUPABASE_URL');
const SUPABASE_ANON_KEY = pick('SUPABASE_ANON_KEY');

if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes('COLE-AQUI')) {
  console.log('Supabase ainda não configurado em js/config.js; pulando as pastas das igrejas.');
  process.exit(0);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const res = await fetch(
  `${SUPABASE_URL}/rest/v1/churches?select=id,slug,name,short_name,primary_color,welcome_text,branding_version&active=eq.true&is_test=eq.false&order=slug`,
  { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
);
if (!res.ok) {
  console.error('Falha ao ler as igrejas do Supabase:', res.status, await res.text());
  process.exit(0); // publica o site mesmo assim (as igrejas abrem pelo 404.html, sem ícone próprio)
}
const churches = await res.json();
const shell = readFileSync('index.html', 'utf8');

for (const c of churches) {
  const dir = `${OUT}/i/${c.slug}`;
  mkdirSync(dir, { recursive: true });
  const v = c.branding_version;

  // Ícones gerados pelo admin em Configurar a igreja; sem eles, os padrão do app.
  let own = 0;
  for (const name of ICONS) {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/public/igrejas/${c.id}/icons/${name}`);
    if (r.ok) {
      writeFileSync(`${dir}/${name}`, Buffer.from(await r.arrayBuffer()));
      own++;
    } else {
      cpSync(`icons/${name}`, `${dir}/${name}`);
    }
  }

  const short = c.short_name || c.name.slice(0, 20);
  writeFileSync(
    `${dir}/manifest.webmanifest`,
    JSON.stringify(
      {
        id: './', // relativo ao manifest: cada igreja é um app instalado separado
        name: c.name,
        short_name: short,
        description: c.welcome_text || `App da ${c.name}`,
        lang: 'pt-BR',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f5f6fa',
        theme_color: c.primary_color,
        icons: [
          { src: `icon-192.png?v=${v}`, sizes: '192x192', type: 'image/png' },
          { src: `icon-512.png?v=${v}`, sizes: '512x512', type: 'image/png' },
          { src: `icon-maskable-512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      null,
      2,
    ),
  );

  // Mesmo app da raiz; o <base> faz os arquivos (css, js) virem de lá.
  const page = shell
    .replace('<!-- igreja -->', '<base href="../../">')
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(c.name)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*"/, `$1${esc(c.welcome_text || `App da ${c.name}`)}"`)
    .replace(/(<meta name="theme-color" content=")[^"]*"/, `$1${esc(c.primary_color)}"`)
    .replace('href="manifest.webmanifest"', `href="i/${c.slug}/manifest.webmanifest"`)
    .replace('href="icons/icon-192.png"', `href="i/${c.slug}/icon-192.png?v=${v}"`)
    .replace('href="icons/apple-touch-icon.png"', `href="i/${c.slug}/apple-touch-icon.png?v=${v}"`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*"/, `$1${esc(short)}"`);
  writeFileSync(`${dir}/index.html`, page);
  console.log(`i/${c.slug}/ ${own === ICONS.length ? 'com ícones da igreja' : 'com ícones padrão'}`);
}
console.log(`Geradas ${churches.length} pastas de igrejas.`);
