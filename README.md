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

## Contas de teste

Os testes de `tests/isolation.spec.mjs` entram com cinco contas (admin, líder e membro da Teste A, admin da Teste B e uma pessoa sem igreja) e conferem que nenhuma lê ou altera o que não pode.

1. `node scripts/criar-usuarios-de-teste.mjs` gera uma senha aleatória em `tests/senha-testes.local` e o arquivo `supabase/usuarios-de-teste.local.sql`. Os dois ficam fora do Git.
2. Rode `supabase/usuarios-de-teste.local.sql` no SQL Editor (pode rodar de novo quando quiser; recria as contas).
3. No GitHub, em **Settings > Secrets and variables > Actions**, crie o segredo `TEST_USERS_PASSWORD` com o conteúdo de `tests/senha-testes.local`. Sem ele, os testes do GitHub falham de propósito.

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
| E-mail (Resend) | ~100/dia | O app controla o limite |
| GitHub Actions | Grátis em repositório público | Publicação a cada hora para atualizar ícones |
