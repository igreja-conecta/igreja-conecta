# Igreja Conecta

App (PWA) para igrejas: agenda, avisos e aniversariantes no celular. Uma única instalação atende várias igrejas, cada uma com nome, logo, cores e funcionalidades próprias, e o banco garante que uma igreja nunca vê os dados de outra.

Mesma arquitetura do [Desapega](https://github.com/garagesalebsb/desapega): HTML + CSS + JavaScript sem build, Supabase (Postgres com RLS, Auth, Storage) e GitHub Pages.

## Endereços

| Endereço | O que é |
|---|---|
| `.../` | Início: entrar e escolher a igreja; administração da plataforma |
| `.../i/<igreja>/` | O app da igreja (é este endereço que cada membro instala na tela inicial) |

A publicação (`scripts/build-site.mjs`) gera uma pasta `i/<igreja>/` por igreja ativa, com manifest, ícones e título próprios. Uma igreja recém-criada já abre antes disso pelo `404.html`, só que ainda com o ícone padrão.

Na publicação, o código do app vira um arquivo só e compactado (`js/app.js`, com o cliente do Supabase dentro, via esbuild) e a página de cada igreja já pede os dados da igreja junto com o HTML. O código-fonte continua rodando sem build (o Supabase vem do jsDelivr); a versão do `supabase-js` no `import` de `js/app.js` e no `package.json` precisa ser a mesma (o build confere). Os testes do GitHub rodam sobre a pasta publicada (`SITE_DIR=_site`); para fazer o mesmo aqui: `node scripts/build-site.mjs --sem-igrejas` e depois `SITE_DIR=_site npx playwright test`.

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
| `009_oracao.sql` | Pedidos de oração: só para os pastores (administrador e líderes) ou para o mural da igreja com aprovação, anônimo opcional, "Estou orando", avisos na central e por push |
| `010_celulas.sql` | Células e pequenos grupos: participantes, líder e auxiliar (qualquer pessoa do cadastro), encontros com lista de presença e visitantes, frequência e membros sem célula |
| `011_mapa.sql` | Local exato no mapa (alfinete) no endereço da igreja, nos eventos e nas células; o app mostra o mapa (OpenStreetMap) e a rota no Google Maps e no Waze |
| `012_seguranca.sql` | Reforços do scan de segurança: links das redes sociais, logo e imagens só com https://; notificações só para os serviços de push conhecidos; funções de gatilho fechadas |
| `013_visitantes.sql` | Cadastro de visitantes pelo QR Code (sem login, com limite de envios e autorização), aviso para a liderança, acompanhamento, "cadastrar como membro" e limpeza em 12 meses |
| `014_devocional.sql` | Devocional do dia (agendado, com Amém e aviso às 7h), planos de leitura da Bíblia com o progresso de cada um, tradução da Bíblia da igreja |
| `015_escalas.sql` | Ministérios e escalas: equipe e líder (qualquer pessoa do cadastro), escalas com função, confirmar ou pedir troca, aviso ao ser escalado e lembrete na véspera; o ministério de Acolhimento recebe os avisos de visitantes |
| `016_inscricoes.sql` | Inscrição em eventos: vagas, prazo, lista de espera que anda sozinha, cancelar, lista de inscritos e planilha para a liderança, e-mail de confirmação dentro do limite diário |
| `017_infantil.sql` | Check-in do ministério infantil: filhos cadastrados pelo responsável (ou na recepção), salas por idade, entrada com código de retirada sorteado pelo banco, etiquetas, retirada só com o código, avisos ao responsável e limpeza em 12 meses |
| `018_carteirinha.sql` | Carteirinha digital de membro: "membro desde" (liderança), código secreto do QR (a pessoa troca quando quiser) e conferência pública que mostra só o que está na carteirinha |
| `019_relatorios.sql` | Relatórios da liderança: membros (novos por mês, faixa etária, uso do app), visitantes e conversão, células, infantil, escalas, inscrições e participação, só totais, por período de até 400 dias |
| `020_galeria.sql` | Galeria de fotos: álbuns só para os membros (pasta privada), publicam a liderança e o ministério marcado, limite de 300 fotos por igreja conferido no banco, arquivos até 400 KB (o app reduz no aparelho) e "pedir para tirar esta foto" |
| `021_chat.sql` | Chat 1 a 1 dentro da igreja: membro com a liderança (e entre membros, se a igreja ligar), "receber mensagens", só as duas pessoas leem, bloquear e denunciar (sem as mensagens), limites por hora, tempo real pelo canal particular de cada pessoa |
| `022_push_do_chat.sql` | Notificação do chat no celular na hora: o banco chama (pg_net) a Edge Function `enviar-push`, um aviso por mensagem, sem o texto da mensagem |
| `023_push_do_chat_correcao.sql` | Correção do aviso do chat: a busca dos celulares de quem recebe, em passos simples (a do 022 dava erro quando havia celular para avisar) |
| `024_chat_lista.sql` | Chat: lista completa de com quem a pessoa pode conversar (a tela "Nova conversa" mostra todos e a busca filtra no aparelho), com as mesmas regras |
| `025_conversas_apagar.sql` | Chat: apagar a conversa só para quem apagou (arrastando para a esquerda ou pelo menu ⋯); volta com mensagem nova, só com o que é novo |
| `026_financeiro.sql` | Financeiro e livro caixa: a tesouraria (admin e membros marcados) lança entradas, saídas e transferências em centavos; fechar o mês trava e publica; os membros veem só os totais por categoria dos meses publicados |
| `027_livro_caixa.sql` | Financeiro: o aviso de mês publicado passa a dizer "Livro caixa" (antes "Prestação de contas") |
| `028_atas.sql` | ATAs das reuniões: o administrador e a secretaria enviam o PDF (só PDF, até 5 MB, pasta privada), os membros da igreja abrem e recebem o aviso quando sai uma ATA nova |
| `029_separar_teste_a.sql` | A igreja de verdade que estava na Teste A vira a Igreja Reformada de Brasília (`/i/reformada-brasilia/`), sem as pessoas de teste; nasce uma Teste A nova só para os testes |
| `030_limpar_reformada.sql` | Tira da Igreja Reformada de Brasília o que os testes automáticos deixaram quando ela era a Teste A (conversas, avisos, lançamentos…) |
| `031_cor_tema_escuro.sql` | Aparência: no tema escuro, links e ícones usam a cor principal clareada (padrão) ou a cor principal pura, à escolha do administrador |

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

O e-mail respeita o limite de 100 por dia para todas as igrejas juntas, somando os aniversários e as confirmações de inscrição em eventos (o Gmail aceita uns 500). O que passar fica para o dia seguinte (até 2 dias de atraso), e o administrador da plataforma recebe um aviso no celular.

## Lembretes da agenda, avisos e inscrições

O GitHub Actions (`.github/workflows/lembretes.yml`) roda a cada 10 minutos e chama `scripts/enviar-lembretes.mjs`: manda o lembrete de cada evento no prazo escolhido (1 h, 2 h, 3 h ou 1 dia antes) e a notificação dos avisos publicados com "Mandar notificação". As notificações também ficam na central do app. Também manda o e-mail de confirmação das inscrições em eventos, pelo mesmo Gmail dos aniversários. Usa os mesmos segredos `ENVIO_SECRET`, `VAPID_PRIVATE_KEY` e `GMAIL_APP_PASSWORD` (e a variável `GMAIL_USER`).

### Notificações do chat (Edge Function)

O aviso de mensagem nova sai na hora, sem esperar o GitHub: um gatilho do banco (`supabase/022_push_do_chat.sql`) chama a função `supabase/functions/enviar-push`, que avisa os aparelhos da outra pessoa. O workflow `.github/workflows/funcoes.yml` publica a função e grava nela os segredos que já existem (`VAPID_PRIVATE_KEY` e `ENVIO_SECRET`). Ele precisa de um segredo a mais no GitHub, `SUPABASE_ACCESS_TOKEN` (Supabase > Account preferences > Access Tokens). Sem ele, o chat funciona normalmente, só sem o aviso no celular.

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
