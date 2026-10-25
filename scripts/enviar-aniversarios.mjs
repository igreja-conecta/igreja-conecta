// Envia as mensagens de aniversário do dia (push e e-mail) e o resumo para a liderança.
// Roda no GitHub Actions (.github/workflows/aniversarios.yml) às 7h de Brasília. Precisa de:
//   ENVIO_SECRET e VAPID_PRIVATE_KEY (segredos do GitHub) e SITE_URL.
// E-mail só sai com RESEND_API_KEY (segredo) e EMAIL_FROM (variável), quando houver domínio próprio.
import { readFileSync } from 'node:fs';
import webpush from 'web-push';
import { renderMessage, joinNames, firstName, esc } from '../js/util.js';

const config = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
const pick = (key) => config.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1];
const SUPABASE_URL = pick('SUPABASE_URL');
const ANON_KEY = pick('SUPABASE_ANON_KEY');
const VAPID_PUBLIC_KEY = pick('VAPID_PUBLIC_KEY');

const { ENVIO_SECRET, VAPID_PRIVATE_KEY, RESEND_API_KEY, EMAIL_FROM } = process.env;
const SITE_URL = (process.env.SITE_URL || 'https://igreja-conecta.github.io/igreja-conecta').replace(/\/$/, '');
if (!ENVIO_SECRET || !VAPID_PRIVATE_KEY) throw new Error('Faltam os segredos ENVIO_SECRET e VAPID_PRIVATE_KEY.');
const emailOn = !!(RESEND_API_KEY && EMAIL_FROM);

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

const churchUrl = (slug, hash = '') => `${SITE_URL}/i/${slug}/${hash}`;
const stats = { push: 0, email: 0, gone: 0, failed: 0 };

async function push(sub, msg) {
  try {
    await webpush.sendNotification(sub, JSON.stringify(msg), { TTL: 12 * 3600, urgency: 'normal' });
    stats.push++;
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await rpc('forget_push_subscription', { p_endpoint: sub.endpoint });
      stats.gone++;
    } else {
      stats.failed++;
      console.error(`Falha no push (${err.statusCode ?? 'sem status'}): ${err.body || err.message}`);
    }
    return false;
  }
}

const subOf = (r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } });

// Agrupa por registro de envio: uma pessoa pode ter vários aparelhos.
function byLog(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.log_id)) map.set(r.log_id, { ...r, subs: [] });
    map.get(r.log_id).subs.push(subOf(r));
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------
// 1. Mensagem na central de notificações do app (quem tem conta, mesmo sem push)
// ---------------------------------------------------------------------
const inApp = await rpc('deliver_birthday_notifications');

// ---------------------------------------------------------------------
// 2. Push de aniversário
// ---------------------------------------------------------------------
for (const r of byLog(await rpc('claim_birthday_push'))) {
  const data = { name: r.name, church: r.church_name, age: r.age };
  const msg = {
    title: renderMessage(r.title, data),
    body: renderMessage(r.body, data),
    url: churchUrl(r.church_slug, '#/'),
    tag: `aniversario-${r.log_id}`,
    icon: churchUrl(r.church_slug, 'icon-192.png'),
    image: r.image_url || undefined,
  };
  const results = await Promise.all(r.subs.map((s) => push(s, msg)));
  if (!results.some(Boolean)) await rpc('mark_message_failed', { p_log_id: r.log_id });
}

// ---------------------------------------------------------------------
// 3. E-mail de aniversário (só com provedor configurado), dentro do limite diário
// ---------------------------------------------------------------------
function emailHtml(r, title, body) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f5f6fa;font-family:Arial,sans-serif;color:#1b1e27">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e2e4ec">
      ${r.image_url ? `<img src="${esc(r.image_url)}" alt="" style="display:block;width:100%;height:auto">` : ''}
      <div style="padding:24px">
        <h1 style="font-size:22px;margin:0 0 12px">${esc(title)}</h1>
        <p style="font-size:16px;line-height:1.5;margin:0;white-space:pre-line">${esc(body)}</p>
      </div>
    </div>
    <p style="font-size:12px;color:#5f6475;text-align:center;margin-top:16px">
      Você recebe esta mensagem porque está no cadastro da ${esc(r.church_name)}.
      <a href="${esc(churchUrl(r.church_slug))}" style="color:#5f6475">Abrir o app da igreja</a>
    </p>
  </div></body></html>`;
}

async function sendEmail(r) {
  const data = { name: r.name, church: r.church_name, age: r.age };
  const title = renderMessage(r.title, data);
  const body = renderMessage(r.body, data);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${r.church_name} <${EMAIL_FROM}>`,
      to: [r.email],
      subject: title,
      html: emailHtml(r, title, body),
      text: `${title}\n\n${body}\n\n${r.church_name}`,
    }),
  });
  if (res.ok) {
    stats.email++;
    return;
  }
  stats.failed++;
  console.error(`Falha no e-mail (${res.status}): ${(await res.text()).slice(0, 200)}`);
  await rpc('mark_message_failed', { p_log_id: r.log_id });
}

let backlog = 0;
if (emailOn) {
  for (const r of await rpc('claim_birthday_email')) await sendEmail(r);
  backlog = await rpc('birthday_email_backlog');
} else {
  console.log('E-mail desligado (faltam RESEND_API_KEY e EMAIL_FROM): só push.');
}

// ---------------------------------------------------------------------
// 4. Resumo para a liderança
// ---------------------------------------------------------------------
const weekday = (iso) =>
  new Date(`${iso}T12:00:00-03:00`).toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'America/Sao_Paulo' }).replace('.', '');

for (const r of byLog(await rpc('claim_leader_summaries'))) {
  const today = r.today_names || [];
  const week = r.week || [];
  const parts = [];
  if (today.length) parts.push(`Hoje: ${joinNames(today)}.`);
  if (week.length) parts.push(`Nesta semana: ${week.map((w) => `${firstName(w.name)} (${weekday(w.date)})`).join(', ')}.`);
  const msg = {
    title: today.length ? `Aniversariantes de hoje na ${r.church_name}` : `Aniversariantes da semana na ${r.church_name}`,
    body: parts.join(' '),
    url: churchUrl(r.church_slug, '#/aniversariantes'),
    tag: `resumo-${r.church_slug}`,
    icon: churchUrl(r.church_slug, 'icon-192.png'),
  };
  const results = await Promise.all(r.subs.map((s) => push(s, msg)));
  if (!results.some(Boolean)) await rpc('mark_message_failed', { p_log_id: r.log_id });
}

// ---------------------------------------------------------------------
// 5. Aviso ao administrador da plataforma quando o limite de e-mails segurou envios
// ---------------------------------------------------------------------
if (backlog > 0) {
  const msg = {
    title: 'Limite diário de e-mails atingido',
    body: `${backlog} mensagem(ns) de aniversário ficaram para amanhã. O push saiu normalmente.`,
    url: `${SITE_URL}/#/plataforma`,
    tag: 'limite-email',
  };
  for (const t of await rpc('platform_push_targets')) await push(subOf(t), msg);
}

await rpc('clean_message_log');
await rpc('clean_notifications');

// Só números: nada de nome ou endereço de aparelho no registro público do GitHub.
console.log(`Aniversários: ${inApp} na central do app, ${stats.push} push, ${stats.email} e-mail(s), ${backlog} e-mail(s) para amanhã, ${stats.gone} aparelho(s) removido(s), ${stats.failed} falha(s).`);
if (stats.failed && !stats.push && !stats.email) process.exit(1);
