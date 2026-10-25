// Dados do projeto Supabase (Project Settings > API Keys).
// A chave "publishable"/"anon" é pública por natureza: a segurança vem das regras RLS (supabase/001_base.sql).
export const CONFIG = {
  SUPABASE_URL: 'https://lmukzyonnggwwwjrfywy.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Z8-CR2iLvz9XAC59Dty-Vg_BOPcvDhC',
  APP_NAME: 'Igreja Conecta',
  // Chave pública das notificações (a privada fica só no segredo VAPID_PRIVATE_KEY do GitHub).
  VAPID_PUBLIC_KEY: 'BFUtgT80s-tPnIsLlXFB2TmRzYyk0cf7QSIzjOVhDnMz8inMugqVYgK4cbsKKzBGFK8ExreJ0ebSHNrcDLHICZg',
};
