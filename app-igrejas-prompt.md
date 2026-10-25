# App para igrejas: prompt e planejamento

Parte 1: o prompt para colar numa conversa nova do Claude Code, aberta numa pasta vazia (ex.: `C:\IA\Igrejas`).
Parte 2: o planejamento, para você decidir o escopo antes de começar.

---

## Parte 1: prompt

```text
Quero criar um aplicativo web (PWA) para igrejas, em português do Brasil, com a mesma arquitetura
de outro app que já fiz (o "Desapega", em https://github.com/garagesalebsb/desapega — leia o código
de lá para seguir os mesmos padrões). Não implemente nada ainda: primeiro me mostre o plano da
Fase 1 e espere eu aprovar.

## Arquitetura (igual ao Desapega)
- Front-end sem build: HTML + CSS + JavaScript em módulos ES, SPA com rotas por hash (#/...),
  publicado no GitHub Pages por um workflow do GitHub Actions.
- PWA: manifest, service worker com cache versionado (trocar o nome do cache a cada versão),
  instalável no Android e no iPhone (apple-touch-icon PNG 180x180 sem transparência).
- Supabase no plano gratuito: Postgres com RLS em todas as tabelas, Auth (login com Google e
  por link mágico no e-mail), Storage para fotos, Edge Functions para o que precisa de segredo.
- Notificações push com Web Push (chaves VAPID), disparadas por Edge Function.
- Tarefas agendadas pelo GitHub Actions (cron), chamando Edge Functions protegidas por um
  segredo no cabeçalho. Isso também mantém o projeto gratuito do Supabase acordado.
- Fotos reduzidas no celular antes do envio (WebP, 1080 px, miniatura de 400 px).
- Banco versionado em arquivos SQL numerados (supabase/001_..., 002_...) que eu rodo no SQL
  Editor. Avise sempre que houver SQL novo para rodar.
- Testes com Playwright no CI, incluindo testes de segurança que tentam ler e gravar dados
  sem permissão e precisam falhar.

## Multi-igreja (white label) — o requisito mais importante
- Uma única instalação atende várias igrejas. Cada igreja tem nome, logo, cores, textos,
  chave Pix, redes sociais e as funcionalidades ligadas ou desligadas.
- Usuários de uma igreja NUNCA podem ver dados de outra. Isso tem que ser garantido no banco
  (RLS), não só na tela:
  - toda tabela de dados tem church_id;
  - as regras de acesso usam funções auxiliares (ex.: is_member(church_id), has_role(church_id, 'admin'))
    chamadas como (select ...) para o Postgres não repetir a consulta por linha;
  - as fotos ficam no Storage em pastas por igreja (church_id/...), com regras por pasta;
  - Edge Functions conferem a igreja do usuário antes de qualquer ação;
  - testes automáticos com duas igrejas de teste provando que uma não lê nem altera a outra.
- Papéis:
  - administrador da plataforma (eu): cria igrejas, define o administrador de cada uma;
  - administrador da igreja: configura a aparência e as funcionalidades, gerencia membros e papéis;
  - secretaria / líder: cadastra membros e publica avisos;
  - membro: vê o que a igreja liberou e edita os próprios dados.
- Uma pessoa pode participar de mais de uma igreja (escolhe a igreja ao entrar).

## Decisões já tomadas
- Endereço único para todas as igrejas, com a igreja no caminho: .../i/nome-da-igreja/
  (sem domínio próprio por igreja).
- Cada igreja aparece com o próprio nome e logo, inclusive no app instalado na tela inicial:
  gere no build uma pasta por igreja (i/nome-da-igreja/) com manifest, ícones e start_url
  próprios, a partir dos dados da tabela de igrejas.
- O volume de e-mails não passa de 100 por dia no total: use um provedor gratuito (ex.: Resend)
  e mesmo assim controle o limite no envio, deixando o excedente para o dia seguinte e
  avisando o administrador da plataforma.

## Funcionalidade principal da Fase 1: aniversariantes
- Cadastro de membros pela secretaria (o membro não precisa ter conta): nome, data de
  nascimento, e-mail, telefone, foto opcional. Se o membro criar conta com o mesmo e-mail,
  a conta é ligada ao cadastro.
- Importação de membros por planilha (CSV).
- Cada igreja configura a mensagem de aniversário, com campos como {nome}, {primeiro_nome},
  {igreja}, {idade} (opcional), e uma imagem.
- No dia do aniversário, às 7h no horário de Brasília, o app envia a mensagem por e-mail e por
  notificação push (para quem instalou o app e ativou as notificações).
- Quem nasceu em 29/02 recebe em 28/02 nos anos que não são bissextos.
- Registro de envios para não mandar duas vezes, respeitando o limite de 100 e-mails por dia.
- Os líderes recebem um resumo com os aniversariantes do dia e da semana.
- Página "Aniversariantes do mês", com opção de imprimir.

## Também na Fase 1
- Agenda de cultos e eventos, com lembrete por push e botão "adicionar à agenda" (.ics).
- Mural de avisos da igreja, com push opcional.
- Central de notificações dentro do app.

## Próximas fases (planeje o banco para elas, mas não implemente agora)
Cada funcionalidade pode ser ligada ou desligada por igreja na configuração.

Fase 2 — vida da igreja:
- Datas especiais: aniversário de casamento e de batismo, com o mesmo motor de mensagens
  dos aniversários.
- Pedidos de oração: o membro envia; escolhe se vai só para os pastores ou para a igreja toda;
  os pedidos públicos passam por moderação.
- Escalas de ministérios (louvor, recepção, infantil, mídia): o líder monta a escala, o
  voluntário confirma ou pede troca e recebe lembrete por push.
- Dízimos e ofertas por Pix: QR Code e "copiar chave" da igreja. O app não recebe nem
  processa dinheiro.
- Visitantes: QR Code exibido no culto abre um cadastro rápido; a equipe de acolhimento
  recebe aviso para fazer o acompanhamento.

Fase 3 — gestão:
- Células / pequenos grupos: membros de cada grupo, encontros e lista de presença.
- Inscrições em eventos (retiros, cursos): limite de vagas, lista de espera e confirmação por
  e-mail (contando no limite diário).
- Check-in do ministério infantil: etiqueta com código para a retirada da criança.
- Carteirinha digital de membro com QR Code.
- Relatórios: membros ativos, novos membros, presença, exportação para planilha.
- Galeria de fotos dos eventos, com limpeza automática das fotos antigas.
- Devocional / plano de leitura com lembrete diário.

## Privacidade (LGPD)
Dados de membros de igreja revelam convicção religiosa, que é dado sensível pela LGPD:
- consentimento claro no cadastro;
- política de privacidade por igreja;
- o membro pode ver, exportar e excluir os próprios dados;
- a data de nascimento e o telefone ficam visíveis só para a liderança, a não ser que o
  membro autorize;
- coletar apenas o necessário.

## Regras de trabalho
- Converse comigo em português e explique em linguagem simples.
- Antes de implementar algo grande, me mostre como vai ficar e espere eu aprovar.
- Use o fluxo branch → pull request → merge, e só faça o merge depois que eu rodar o SQL
  necessário e os testes passarem.
- Nunca me peça para colar no chat senhas, chaves secretas (service_role, VAPID privada,
  chave do provedor de e-mail), tokens ou a senha do banco. Segredos vão só nos secrets do
  GitHub, nas variáveis das Edge Functions ou no Vault do Supabase. Me diga onde colar.
- Antes de publicar qualquer coisa, confira com `gh api user` se a conta do GitHub é a certa.
- Mantenha tudo dentro do plano gratuito e me avise quando algo puder passar do limite.

Comece me perguntando: o nome do app, a conta do GitHub, se já criei o projeto no Supabase,
qual igreja vai testar primeiro, se tenho domínio próprio para o remetente dos e-mails e quem
pode ver aniversários e telefones (só a liderança ou também os membros, com autorização). Depois me mostre o plano da Fase 1 (tabelas, regras de
acesso, telas e a ordem de entrega) para eu aprovar.
```

---

## Parte 2: planejamento

### Como fica a separação entre igrejas

| Peça | Como funciona |
|---|---|
| `churches` | Uma linha por igreja: nome, endereço curto (slug), logo, cores, textos, funcionalidades ligadas |
| `memberships` | Quem participa de qual igreja e com qual papel (admin, secretaria, líder, membro) |
| Dados (membros, eventos, avisos...) | Toda linha tem `church_id`; o banco só entrega as linhas das igrejas da pessoa |
| Fotos | Pasta por igreja no Storage, com regra por pasta |
| Testes | Duas igrejas de teste; o teste falha se uma enxergar algo da outra |

O administrador da plataforma (você) cria a igreja e indica o administrador dela. Daí em diante, cada igreja se configura sozinha.

### Funcionalidades propostas

**Fase 1: base e aniversariantes** (o que você pediu)
- Igrejas, papéis e aparência por igreja (logo, cores, nome no app instalado)
- Cadastro de membros, importação por planilha
- Mensagem de aniversário configurável, enviada por e-mail e push às 7h
- Resumo de aniversariantes para os líderes; lista do mês para imprimir
- Agenda de cultos e eventos com lembretes
- Mural de avisos
- Central de notificações

**Fase 2: vida da igreja**
- **Datas especiais**: aniversário de casamento e de batismo, com o mesmo motor de mensagens
- **Pedidos de oração**: o membro envia; pode ser só para os pastores ou para a igreja toda, com moderação
- **Escalas de ministérios** (louvor, recepção, infantil, mídia): o líder monta a escala, o voluntário confirma ou pede troca, e recebe lembrete
- **Dízimos e ofertas por Pix**: QR Code e "copiar chave" da igreja, sem o app tocar no dinheiro (como no Desapega)
- **Visitantes**: QR Code no culto abre um cadastro rápido; a equipe recebe aviso para fazer o acompanhamento

**Fase 3: gestão**
- **Células / pequenos grupos**: membros de cada grupo, encontros, lista de presença
- **Inscrições em eventos** (retiros, cursos): limite de vagas, lista de espera, confirmação por e-mail
- **Check-in do ministério infantil**: etiqueta com código para a retirada da criança
- **Carteirinha digital de membro** com QR Code
- **Relatórios**: membros ativos, novos membros, presença, exportação para planilha
- **Galeria de fotos** dos eventos, com limpeza automática das fotos antigas (como no Desapega)
- **Devocional / plano de leitura** com lembrete diário

### Limites do plano gratuito a acompanhar

| Serviço | Limite gratuito (confira, pode mudar) | Impacto |
|---|---|---|
| Supabase banco | 500 MB | Muitas igrejas cabem; fotos ficam no Storage |
| Supabase Storage | 1 GB | Fotos em WebP reduzido; limpeza automática |
| Supabase sem uso | Pausa após 7 dias parado | O cron diário dos aniversários mantém acordado |
| E-mail (Resend) | ~100 por dia, 3.000 por mês | Cabe no volume previsto (até 100 por dia) |
| Push (Web Push) | Sem custo | No iPhone, só funciona com o app instalado na tela inicial |
| GitHub Actions | Gratuito para repositório público | Cron diário e publicação do site |

### Decisões

Já tomadas (estão no prompt):
- **Cada igreja aparece com o próprio nome** e logo, inclusive no app instalado.
- **Endereço único** para todas, com a igreja no caminho (`.../i/nome-da-igreja/`).
- **Até 100 e-mails por dia**: cabe no plano gratuito; o app controla o limite mesmo assim.
- **Funcionalidades propostas** das Fases 2 e 3 entram no planejamento do banco desde o início.

Ainda em aberto (o prompt faz o Claude perguntar):
1. **Nome do app.**
2. **Remetente do e-mail**: sem domínio próprio, os e-mails saem do endereço do provedor; com domínio, podem sair como `aniversario@seuapp.com.br`.
3. **Quem vê aniversários e telefones**: só a liderança, ou todos os membros com autorização.
4. **Cobrança**: se no futuro as igrejas vão pagar, vale prever planos desde já (limite de membros por igreja).

### Ordem de entrega sugerida (Fase 1)
1. Projeto novo no Supabase e repositório novo no GitHub; site publicado vazio
2. Igrejas, papéis, login e a tela de configuração da aparência
3. Testes de separação entre igrejas (antes de qualquer dado real)
4. Cadastro e importação de membros
5. Mensagem de aniversário, envio por e-mail e push, registro de envios
6. Agenda, avisos e central de notificações
7. Política de privacidade e termos, exportação e exclusão de dados
