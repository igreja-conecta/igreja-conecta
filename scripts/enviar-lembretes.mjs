// Lembretes dos eventos da agenda, notificações dos avisos novos e os avisos da central que
// também vão por push (pedidos de oração, visitantes, devocional e leitura do dia, escalas).
// Também manda o e-mail de confirmação das inscrições em eventos (scripts/email.mjs).
// Roda no GitHub Actions a cada 10 minutos (.github/workflows/lembretes.yml). Precisa de:
//   ENVIO_SECRET e VAPID_PRIVATE_KEY (segredos do GitHub) e SITE_URL.
// As notificações da central do app são gravadas pelo próprio banco ao separar os envios.
import { readFileSync } from 'node:fs';
import webpush from 'web-push';
import { emailOn, deliverEmail, closeEmail } from './email.mjs';
import { esc, firstName } from '../js/util.js';

const config = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
const pick = (key) => config.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1];
const SUPABASE_URL = pick('SUPABASE_URL');
const ANON_KEY = pick('SUPABASE_ANON_KEY');
const VAPID_PUBLIC_KEY = pick('VAPID_PUBLIC_KEY');

const { ENVIO_SECRET, VAPID_PRIVATE_KEY } = process.env;
const SITE_URL = (process.env.SITE_URL || 'https://igreja-conecta.github.io/igreja-conecta').replace(/\/$/, '');
if (!ENVIO_SECRET || !VAPID_PRIVATE_KEY) throw new Error('Faltam os segredos ENVIO_SECRET e VAPID_PRIVATE_KEY.');

webpush.setVapidDetails(SITE_URL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

async function rpc(fn, body = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: ENVIO_SECRET, ...body }),
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const churchUrl = (slug, path = '') => `${SITE_URL}/i/${slug}/${path}`;
const stats = { push: 0, gone: 0, failed: 0 };

async function push(r, msg) {
  try {
    await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, JSON.stringify(msg), {
      TTL: 3 * 3600,
      urgency: 'high',
    });
    stats.push++;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await rpc('forget_push_subscription', { p_endpoint: r.endpoint });
      stats.gone++;
    } else {
      stats.failed++;
      console.error(`Falha no push (${err.statusCode ?? 'sem status'}): ${err.body || err.message}`);
    }
  }
}

// Hora no horário de Brasília: "19h30", "8h".
const hour = (iso) => {
  const t = new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const [h, m] = t.split(':');
  return `${Number(h)}h${m === '00' ? '' : m}`;
};
const when = (iso) => {
  const day = (d) => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const today = day(Date.now());
  const tomorrow = day(Date.now() + 864e5);
  const d = day(iso);
  return d === today ? `Hoje às ${hour(iso)}` : d === tomorrow ? `Amanhã às ${hour(iso)}` : `${d.slice(0, 5)} às ${hour(iso)}`;
};

// Lembretes da agenda
const reminders = await rpc('claim_event_reminders');
await Promise.all(
  reminders.map((r) =>
    push(r, {
      title: r.title,
      body: `${when(r.occurrence)}${r.location ? ` · ${r.location}` : ''}`,
      url: churchUrl(r.church_slug, `#/agenda/${r.event_id}`),
      tag: `evento-${r.event_id}`,
      icon: churchUrl(r.church_slug, 'icon-192.png'),
    }),
  ),
);

// Avisos novos com notificação
const notices = await rpc('claim_announcement_push');
await Promise.all(
  notices.map((r) =>
    push(r, {
      title: `${r.church_name}: ${r.title}`,
      body: r.body,
      url: churchUrl(r.church_slug, '#/avisos'),
      tag: `aviso-${r.announcement_id}`,
      icon: churchUrl(r.church_slug, 'icon-192.png'),
    }),
  ),
);

// Às 7h: o devocional do dia e o lembrete da leitura de quem ainda não leu (o banco grava na central
// e põe na fila do push logo abaixo).
const daily = await rpc('deliver_devotional_notifications');
// Na véspera: o lembrete de quem está escalado (também vai pela fila da central).
const escalas = await rpc('deliver_schedule_reminders');

// Avisos da central que também vão por push (ex.: pedido de oração novo para a liderança)
const central = await rpc('claim_notification_push');
await Promise.all(
  central.map((r) =>
    push(r, {
      title: `${r.church_name}: ${r.title}`,
      body: r.body || '',
      url: churchUrl(r.church_slug, r.url?.startsWith('#/') ? r.url : ''),
      tag: `${r.kind}-${r.notification_id}`,
      icon: churchUrl(r.church_slug, 'icon-192.png'),
    }),
  ),
);

// E-mail de confirmação das inscrições em eventos (dentro do limite diário de e-mails)
const fullWhen = (r) => {
  const opts = { timeZone: 'America/Sao_Paulo' };
  const day = new Date(r.starts_at).toLocaleDateString('pt-BR', { ...opts, weekday: 'long', day: 'numeric', month: 'long' });
  return `${day}, às ${hour(r.starts_at)}${r.ends_at ? ` até ${hour(r.ends_at)}` : ''}`;
};
function registrationHtml(r, link) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f5f6fa;font-family:Arial,sans-serif;color:#1b1e27">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border-radius:14px;border:1px solid #e2e4ec;padding:24px">
      <p style="font-size:14px;color:#5f6475;margin:0 0 8px">Inscrição confirmada ✅</p>
      <h1 style="font-size:22px;margin:0 0 12px">${esc(r.title)}</h1>
      <p style="font-size:16px;line-height:1.5;margin:0 0 6px">📅 ${esc(fullWhen(r))}</p>
      ${r.location ? `<p style="font-size:16px;line-height:1.5;margin:0 0 6px">📍 ${esc(r.location)}</p>` : ''}
      <p style="font-size:16px;line-height:1.5;margin:16px 0 0">Olá, ${esc(firstName(r.name))}! Sua vaga está garantida. Se não puder ir, cancele pelo app para a vaga passar para outra pessoa.</p>
      <p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#3b5bdb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px">Ver o evento no app</a></p>
    </div>
    <p style="font-size:12px;color:#5f6475;text-align:center;margin-top:16px">Você recebe este e-mail porque se inscreveu pelo app da ${esc(r.church_name)}.</p>
  </div></body></html>`;
}
let emails = 0;
if (emailOn) {
  for (const r of await rpc('claim_registration_emails')) {
    const link = churchUrl(r.church_slug, `#/agenda/${r.event_id}`);
    const fail = await deliverEmail({
      fromName: r.church_name,
      to: r.email,
      subject: `Inscrição confirmada: ${r.title}`,
      html: registrationHtml(r, link),
      text: `Inscrição confirmada: ${r.title}\n${fullWhen(r)}${r.location ? `\n${r.location}` : ''}\n\nVer o evento: ${link}\n\n${r.church_name}`,
    });
    if (!fail) emails++;
    else {
      stats.failed++;
      // Sem o endereço da pessoa: o registro do GitHub é público.
      console.error(`Falha no e-mail de inscrição (${fail.replaceAll(r.email, '<destinatário>')})`);
    }
  }
  closeEmail();
}

// Só números: nada de nome ou endereço de aparelho no registro público do GitHub.
const count = (rows, key) => new Set(rows.map((r) => r[key])).size;
console.log(
  `Lembretes: ${count(reminders, 'event_id')} evento(s); avisos: ${count(notices, 'announcement_id')}; ` +
    `central: ${count(central, 'notification_id')} (devocional e leitura: ${daily}; escalas: ${escalas}); ` +
    `${stats.push} push, ${stats.gone} aparelho(s) removido(s), ${emails} e-mail(s) de inscrição, ${stats.failed} falha(s).`,
);
if (stats.failed && !stats.push) process.exit(1);
