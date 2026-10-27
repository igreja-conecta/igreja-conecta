# Igreja Conecta

App (PWA) para igrejas: agenda, avisos e aniversariantes no celular. Uma única instalação atende várias igrejas, cada uma com nome, logo, cores e funcionalidades próprias, e o banco garante que uma igreja nunca vê os dados de outra.

Mesma arquitetura do [Desapega](https://github.com/garagesalebsb/desapega): HTML + CSS + JavaScript sem build, Supabase (Postgres com RLS, Auth, Storage) e GitHub Pages.

## Endereços

| Endereço | O que é |
|---|---|
| `.../` | Início: entrar e escolher a igreja; administração da plataforma |
| `.../i/<igreja>/` | O app da igreja (é este endereço que cada membro instala na tela inicial) |

A publicação (`scripts/build-site.mjs`) gera uma pasta `i/<igreja>/` por igreja ativa, com manifest, ícones e título próprios. Uma igreja recém-criada já abre antes disso pelo `404.html`, só que ainda com o ícone padrão.

## Papéis

| Papel | O que faz |
|---|---|
| Administrador da plataforma | Cria igrejas e define o administrador de cada uma (tabela `platform_admins`) |
| Administrador da igreja | Configura aparência, textos e funcionalidades; gerencia membros e papéis |
| Secretaria / Líder | Cadastra membros e publica avisos |
| Membro | Vê o que a igreja liberou e edita os próprios dados |

A secretaria cadastra a pessoa com o e-mail dela. Quando a pessoa entra no app com esse e-mail, a conta é ligada ao cadastro e ela aceita participar (consentimento da LGPD). Só então passa a ver os dados da igreja.

## Configuração (uma vez)

1. **Banco**: no Supabase, abra o **SQL Editor** e rode `supabase/001_base.sql`.
2. **Você como administrador da plataforma**: entre uma vez no app (para a sua conta existir) e rode no SQL Editor, trocando o e-mail:
   ```sql
   insert into public.platform_admins (user_id)
   select id from auth.users where email = 'seu-email@exemplo.com';
   ```
3. **Chave pública**: em **Project Settings > API Keys**, copie a chave *publishable* (ou *anon*) para `js/config.js`. Nunca coloque a chave `service_role`/secret no código.
4. **Login**: em **Authentication > URL Configuration**, coloque o endereço do site em *Site URL* e acrescente em *Redirect URLs*:
   - `https://<usuario>.github.io/<repositorio>/**`
   - `http://localhost:4173/**` (testes no computador)
5. **Google** (opcional): em **Authentication > Providers > Google**, siga o passo a passo do Supabase.
6. **GitHub Pages**: em **Settings > Pages**, escolha *GitHub Actions* como origem.

## Arquivos SQL

Rode na ordem, no SQL Editor. Cada entrega que precisar de SQL novo avisa.

| Arquivo | O que faz |
|---|---|
| `001_base.sql` | Igrejas, membros, papéis, regras de acesso (RLS), pastas de arquivos e a Igreja Exemplo |
| `002_igrejas_de_teste.sql` | Igrejas Teste A e Teste B, usadas pelos testes de separação (não ganham página pública) |
| `003_membros.sql` | Foto do membro na pasta dele, o membro troca a própria foto, e-mail de quem já entrou só muda após desligar a conta, admin desliga contas |
| `004_aniversarios.sql` | Mensagem de aniversário por igreja, aparelhos com notificação, registro de envios (sem repetir), limite de 100 e-mails/dia, resumo da liderança, aniversariantes do mês |
| `005_agenda_avisos.sql` | Agenda (eventos que podem repetir toda semana), mural de avisos, central de notificações, lembretes e avisos por push |
| `006_privacidade.sql` | Exportar os próprios dados, sair de uma igreja e excluir a conta (com proteção do último administrador) |
| `007_relogio.sql` | Relógio do Supabase: manda o GitHub rodar os lembretes (a cada 10 min) e os aniversários (7h) na hora certa, e publicar o site quando uma igreja muda nome ou ícone. Precisa do segredo `github_token` no Vault |
| `008_datas_especiais.sql` | Aniversário de casamento e de batismo: datas no cadastro, mensagens próprias com `{anos}`, envio às 7h junto com os aniversários, resumo da liderança e lista do mês |

## Contas de teste

Os testes de `tests/isolation.spec.mjs` entram com cinco contas (admin, líder e membro da Teste A, admin da Teste B e uma pessoa sem igreja) e conferem que nenhuma lê ou altera o que não pode.

1. `node scripts/criar-usuarios-de-teste.mjs` gera uma senha aleatória em `tests/senha-testes.local` e o arquivo `supabase/usuarios-de-teste.local.sql`. Os dois ficam fora do Git.
2. Rode `supabase/usuarios-de-teste.local.sql` no SQL Editor (pode rodar de novo quando quiser; recria as contas).
3. No GitHub, em **Settings > Secrets and variables > Actions**, crie o segredo `TEST_USERS_PASSWORD` com o conteúdo de `tests/senha-testes.local`. Sem ele, os testes do GitHub falham de propósito.

As igrejas de teste são só dos testes: **não entre nelas com a sua conta** (para experimentar, use a Igreja Exemplo). Se alguém entrar, os testes param antes de mexer em qualquer coisa e pedem para rodar `supabase/limpar-igrejas-de-teste.sql`, que tira das igrejas de teste as contas que não são de teste e devolve os papéis.

## Mensagens de aniversário

O GitHub Actions (`.github/workflows/aniversarios.yml`) roda todo dia às 7h de Brasília e chama `scripts/enviar-aniversarios.mjs`, que envia o push e o e-mail de aniversário e o resumo da liderança. As funções de envio do banco só respondem com a senha `ENVIO_SECRET`; no SQL fica apenas o hash dela.

Segredos do GitHub (**Settings > Secrets and variables > Actions**):

| Nome | Tipo | Para quê |
|---|---|---|
| `ENVIO_SECRET` | Segredo | Senha das funções de envio |
| `VAPID_PRIVATE_KEY` | Segredo | Chave privada das notificações (a pública fica em `js/config.js`) |
| `GMAIL_USER` | Variável (opcional) | Gmail que envia os e-mails, ex.: `aniversarios.suaigreja@gmail.com` |
| `GMAIL_APP_PASSWORD` | Segredo (opcional) | Senha de app desse Gmail (não é a senha normal). Sem ela, só sai o push |
| `RESEND_API_KEY` | Segredo (opcional) | Alternativa com domínio próprio: e-mail pelo Resend (o Gmail tem prioridade) |
| `EMAIL_FROM` | Variável (opcional) | Remetente do Resend, ex.: `aniversario@seudominio.com.br` |

Para criar a senha de app: na conta Google do Gmail, ative a **Verificação em duas etapas** e abra https://myaccount.google.com/apppasswords. Depois de gravar os dois itens, teste em **Actions > Mensagens de aniversário > Run workflow**, marcando "Só mandar um e-mail de teste": chega um e-mail no próprio Gmail e nada vai para os membros. Os e-mails saem com o nome da igreja e o endereço do Gmail.

O e-mail respeita o limite de 100 por dia para todas as igrejas juntas (o Gmail aceita uns 500). O que passar fica para o dia seguinte (até 2 dias de atraso), e o administrador da plataforma recebe um aviso no celular.

## Lembretes da agenda e avisos

O GitHub Actions (`.github/workflows/lembretes.yml`) roda a cada 10 minutos e chama `scripts/enviar-lembretes.mjs`: manda o lembrete de cada evento no prazo escolhido (1 h, 2 h, 3 h ou 1 dia antes) e a notificação dos avisos publicados com "Mandar notificação". As notificações também ficam na central do app. Usa os mesmos segredos `ENVIO_SECRET` e `VAPID_PRIVATE_KEY`.

### Relógio do Supabase

O agendamento grátis do GitHub atrasa ou pula rodadas em horário de movimento. Por isso o Supabase (`supabase/007_relogio.sql`, com pg_cron) chama o GitHub na hora certa; o agendamento do GitHub fica como reserva, e os envios não se repetem.

1. No GitHub, crie um token em **Settings > Developer settings > Personal access tokens > Fine-grained tokens**: dono `igreja-conecta`, só o repositório `igreja-conecta/igreja-conecta`, permissão **Actions: Read and write**. Validade de até 1 ano: anote a data para trocar.
2. No Supabase, em **Integrations > Vault** (em versões antigas do painel, **Project Settings > Vault**), clique em **Add new secret**, com o nome `github_token` e o token como valor.
3. Rode `supabase/007_relogio.sql` no SQL Editor.

Para conferir se o GitHub aceitou as últimas chamadas (204 = deu certo):

```sql
select created, status_code, left(content, 120) from net._http_response order by created desc limit 5;
```

Atenção: o GitHub desliga os agendamentos de um repositório público depois de 60 dias sem nenhum commit. Se isso acontecer, ele avisa por e-mail; é só reativar em **Actions**. As chamadas do relógio do Supabase continuam funcionando.

## Testes

```sh
npm install
npx playwright install
npm test
```

Rodam também no GitHub Actions a cada mudança. A publicação só acontece se passarem. `tests/security.spec.mjs` tenta ler e gravar sem permissão e precisa falhar.

## Limites do plano gratuito

| Serviço | Limite | Observação |
|---|---|---|
| Supabase banco | 500 MB | Fotos ficam no Storage |
| Supabase Storage | 1 GB | Logo em até 512 px; fotos reduzidas no celular |
| Supabase sem uso | Pausa após 7 dias | O envio diário dos aniversários mantém acordado |
| E-mail (Gmail) | ~500/dia | O app manda no máximo 100 |
| GitHub Actions | Grátis em repositório público | Publicação a cada hora para atualizar ícones |
