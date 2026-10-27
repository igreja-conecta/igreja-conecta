// Notificação no celular quando chega mensagem no chat (como no Desapega).
// O banco chama esta função quando uma mensagem é gravada (gatilho messages_push, supabase/022) e
// ela avisa os aparelhos da outra pessoa da conversa. O aviso mostra só quem escreveu, nunca o texto.
// Usa os mesmos segredos dos lembretes (VAPID_PRIVATE_KEY e ENVIO_SECRET), gravados aqui pelo
// workflow funcoes.yml. Sem login: o banco só devolve aparelhos para mensagens com menos de
// 5 minutos e ainda não avisadas, então chamar de novo não gera aviso extra.
import webpush from 'npm:web-push@3.6.7';

const SITE_URL = 'https://igreja-conecta.github.io/igreja-conecta';
// Chave pública (a mesma de js/config.js).
const VAPID_PUBLIC_KEY = 'BFUtgT80s-tPnIsLlXFB2TmRzYyk0cf7QSIzjOVhDnMz8inMugqVYgK4cbsKKzBGFK8ExreJ0ebSHNrcDLHICZg';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Target = {
  endpoint: string;
  p256dh: string;
  auth: string;
  conversation_id: string;
  church_slug: string;
  church_name: string;
  sender_name: string;
};

Deno.serve(async (req) => {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const secret = Deno.env.get('ENVIO_SECRET');
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY');
  if (!secret || !privateKey) return reply(503, { error: 'Notificações não configuradas.' });
  webpush.setVapidDetails(SITE_URL, VAPID_PUBLIC_KEY, privateKey);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_secret: secret, ...args }),
    });
    // O motivo vem do banco (código e mensagem do erro); não traz senha nem endereço de aparelho.
    if (!res.ok) throw new Error(`${fn}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  };

  let body: { hook_message_id?: string };
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: 'Pedido inválido.' });
  }
  if (!UUID.test(body.hook_message_id ?? '')) return reply(400, { error: 'Mensagem inválida.' });

  let targets: Target[];
  try {
    targets = await rpc('message_push_targets', { p_message: body.hook_message_id });
  } catch (err) {
    console.error((err as Error).message);
    return reply(500, { error: 'Não foi possível buscar os aparelhos.' });
  }
  let sent = 0;
  let gone = 0;
  let failed = 0;
  await Promise.all(
    targets.map(async (t) => {
      const church = `${SITE_URL}/i/${t.church_slug}/`;
      const payload = {
        title: `${t.church_name}: mensagem de ${t.sender_name}`,
        body: 'Toque para ler no app.',
        url: `${church}#/chat/${t.conversation_id}`,
        tag: `chat-${t.conversation_id}`, // várias mensagens da mesma conversa viram um aviso só
        icon: `${church}icon-192.png`,
      };
      try {
        await webpush.sendNotification({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, JSON.stringify(payload), {
          TTL: 24 * 3600,
          urgency: 'high',
        });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await rpc('forget_push_subscription', { p_endpoint: t.endpoint }).catch(() => {});
          gone++;
        } else {
          failed++;
          console.error('push', status ?? 'sem status');
        }
      }
    }),
  );
  return reply(200, { sent, gone, failed });
});
