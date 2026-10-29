# CRM Comercial

CRM simples para 2 pessoas: os leads entram sozinhos pelo WhatsApp e seguem um funil em colunas, com follow-up automático (2 contatos por dia durante 5 dias) e um painel da meta do mês.

**Funil:** Novo lead → Contato feito → Lead quente → Proposta enviada → Fechado (+ Perdido)

| Regra | Como funciona |
|---|---|
| Lead novo | Quem manda mensagem no WhatsApp vira lead em **Novo**, com o **vendedor** como responsável. Se veio de um anúncio, o nome do anúncio fica salvo. |
| Contato feito | Quando vocês marcam um follow-up ou registram um contato. |
| Lead quente | Quando o cliente **responde** depois de um contato nosso (automático). |
| Proposta | Botão "Enviei proposta" + valor. |
| Venda | Botão "Fechou" + valor (entrega fechada e pagamento feito). |
| Perdido | Automático às 07h, quando acabam os 5 dias de follow-up sem resposta. Também pode ser marcado à mão, com motivo. |
| Visibilidade | O vendedor vê só os leads dele. O dono vê tudo, troca responsáveis, define a meta e libera usuários. |

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html`, `app.js`, `styles.css` | A página (vai para o GitHub Pages) |
| `config.js` | URL e chave **pública** do Supabase |
| `supabase/schema.sql` | Banco: tabelas, regras de acesso, automações |
| `supabase/functions/whatsapp-webhook/index.ts` | Recebe as mensagens do WhatsApp |
| `supabase/functions/formulario-webhook`, `formulario-sincronizar` | Recebem os envios do Tally |
| `supabase/functions/agenda-webhook/index.ts` | Recebe as reuniões marcadas no Cal.com e avisa o time por e-mail |

---

## Passo 1 — Supabase (banco e login)

1. Crie um projeto em [supabase.com](https://supabase.com) (plano Free). Guarde a senha do banco.
2. **SQL Editor → New query**: cole todo o `supabase/schema.sql` e clique em **Run**.
   - Se aparecer erro sobre `pg_cron`, vá em **Database → Extensions**, ative **pg_cron** e rode de novo.
   - Se o negócio fica em Mato Grosso, troque `'America/Sao_Paulo'` por `'America/Cuiaba'` na função `crm_fuso()` antes de rodar.
3. **Authentication → Sign In / Providers → Email**:
   - **Desligue "Allow new users to sign up"** (sem cadastro aberto).
   - Deixe "Confirm email" ligado.
   - Em **Password**, defina **tamanho mínimo 10**.
4. **Authentication → URL Configuration**:
   - **Site URL**: o endereço do seu GitHub Pages (ex.: `https://seuusuario.github.io/crm/`).
   - **Redirect URLs**: só esse mesmo endereço.
5. **Authentication → Users → Invite user**: convide o seu e-mail e o do vendedor. Cada um recebe o link, abre a página e define a senha.
6. Faça de você o **dono**. No SQL Editor, rode (troque o e-mail):
   ```sql
   update perfis set papel = 'dono', ativo = true, nome = 'Seu Nome'
   where email = 'seu@email.com';
   ```
   Depois disso você libera o vendedor pela própria página (**Configurações → Usuários → Ativo**).
7. **Project Settings → API**: copie a **Project URL** e a chave **anon / public** para o `config.js`.
   **Nunca** use a chave `service_role` na página.

## Passo 2 — GitHub Pages (a página)

1. Crie um repositório no GitHub (ex.: `crm`) e envie `index.html`, `app.js`, `styles.css`, `config.js` e `README.md`. A pasta `supabase/` pode ir junto, porque não tem nada secreto.
2. **Settings → Pages → Source: Deploy from a branch → main / (root)**.
3. Abra o endereço gerado e entre com seu e-mail e senha.

> O repositório fica público (exigência do Pages gratuito). Isso é seguro: a chave pública sem login não lê nada, porque as regras de acesso (RLS) bloqueiam.

## Passo 3 — WhatsApp (entrada automática dos leads)

**Você precisa de:** uma conta no Meta Business e o número no **WhatsApp Business app**. Se hoje você usa o WhatsApp comum, migre o número para o Business antes.

1. Em [developers.facebook.com](https://developers.facebook.com) → **Criar app** → tipo **Empresa** → adicione o produto **WhatsApp**.
2. Em **WhatsApp → Configuração da API**, adicione o seu número. Escolha **conectar o número do WhatsApp Business app** (modo *coexistência*) para continuar usando o app no celular.
3. Instale o [Supabase CLI](https://supabase.com/docs/guides/cli) e, na pasta do projeto, rode:
   ```bash
   supabase login
   ```
   ```bash
   supabase link --project-ref SEU-PROJECT-REF
   ```
   ```bash
   supabase secrets set WHATSAPP_APP_SECRET=xxxxx WHATSAPP_VERIFY_TOKEN=uma-frase-aleatoria-longa WHATSAPP_PHONE_NUMBER_ID=1234567890
   ```
   ```bash
   supabase functions deploy whatsapp-webhook --no-verify-jwt
   ```
   - **App Secret**: no Meta, em **Configurações do app → Básico**.
   - **Phone number ID**: em **WhatsApp → Configuração da API**.
   - **Verify token**: invente uma frase longa; ela vai nos dois lados.
4. No Meta, em **WhatsApp → Configuração → Webhook**:
   - **URL de callback**: `https://SEU-PROJETO.supabase.co/functions/v1/whatsapp-webhook`
   - **Token de verificação**: a mesma frase do `WHATSAPP_VERIFY_TOKEN`.
   - Clique em **Verificar e salvar** e depois **assine o campo `messages`**.
5. Teste: mande uma mensagem de outro celular para o seu número. O card aparece em **Novo** (a página atualiza sozinha), e em **Configurações → WhatsApp** aparece "última mensagem recebida".

> **Custo:** receber mensagens é gratuito. Este CRM não envia mensagens pela API: vocês respondem pelo app do celular (botão "WhatsApp" no card).

## Passo 4 — Formulários do Tally (lead entra sozinho)

**Regras:**
- **Faturamento de 60 mil para cima** ("De 60 a 80 mil" ou maior): o card entra em **Lead quente** e a data em que virou quente fica gravada. Faixas menores, ou sem resposta, entram em **Novo lead**.
- **Empresa e faturamento** aparecem no card, entram na busca e no CSV. O CRM reconhece as perguntas pelo título: "nome", "e-mail", "WhatsApp", "empresa" e "faturamento".
- **Etiquetas:** o **nome do formulário** vira a etiqueta do material.
- **Mesma pessoa:** mesmo e-mail (ou mesmo telefone) não cria card novo, só ganha mais uma etiqueta. Vale o faturamento mais recente informado.
- **Pontuação de 0 a 100**, com o motivo de cada ponto mostrado no card:
  - faturamento: até 40 (até 30 mil = 5, sobe 5 por faixa, acima de 250 mil = 40);
  - materiais: 15 por material, até 30;
  - respostas às nossas mensagens: 20 se respondeu, 30 se respondeu 3 vezes ou mais.
- **Card novo do formulário** já sai com a próxima ação "Primeiro contato" para agora e aparece em **Hoje**.
- **Envios perdidos:** se o aviso falhar, a busca automática de hora em hora traz os envios que ficaram para trás. Um envio nunca entra duas vezes.

**Instalação:**
1. Rode de novo o `supabase/schema.sql` no SQL Editor.
2. Publique as funções (precisa do Node instalado):
   ```bash
   npx supabase login
   ```
   ```bash
   npx supabase link --project-ref nvdhmoyulmdlyfgxhxsd
   ```
   ```bash
   npx supabase functions deploy formulario-webhook --no-verify-jwt --use-api
   ```
   ```bash
   npx supabase functions deploy formulario-sincronizar --no-verify-jwt --use-api
   ```
3. Guarde os segredos no Supabase. O "signing secret" é uma senha longa inventada por você; a chave da API vem do Tally, em **Settings → API keys**:
   ```bash
   npx supabase secrets set TALLY_SIGNING_SECRET=SENHA-LONGA TALLY_API_KEY=CHAVE-DO-TALLY
   ```
4. No Tally, em cada formulário, vá em **Integrations → Webhooks → Connect**:
   - **Endpoint URL**: `https://nvdhmoyulmdlyfgxhxsd.supabase.co/functions/v1/formulario-webhook`
   - **Signing secret**: a mesma senha longa do passo 3
5. Rode o `supabase/formulario-agendamento.sql` no SQL Editor. Ele liga a busca automática de hora em hora.

## Passo 5 — Agenda do Cal.com (reunião marcada vira card)

**Regras:**
- Lead marcou reunião: se já tem card (mesmo e-mail, ou mesmo telefone), o card anda para **Reunião agendada**. Se não tem, o card é criado já nessa etapa.
- A reunião entra no card com data, hora, link da chamada e **dono**. O dono é quem tem a agenda: o e-mail da conta do Cal.com precisa ser **o mesmo e-mail do login no CRM**.
- Remarcou: a reunião muda de horário. Cancelou: ela fica como cancelada. As duas coisas ficam no histórico.
- O time recebe um **e-mail** a cada reunião marcada, remarcada ou cancelada.
- Agendou pelo próprio card (botão **🤝 Reunião → Vai acontecer**): o card também anda para Reunião agendada, e aparece confete na tela.
- Card em **Proposta** ou **Fechado** não volta de etapa ao marcar reunião. Card em **Perdido** é reaberto em Reunião agendada.

**Instalação:**
1. No SQL Editor, rode **sozinha, antes de tudo**, esta linha:
   ```sql
   alter type public.marco_etapa add value if not exists 'reuniao' before 'proposta';
   ```
   Depois rode de novo o `supabase/schema.sql` inteiro.
2. Publique a função:
   ```bash
   npx supabase functions deploy agenda-webhook --no-verify-jwt --use-api
   ```
3. E-mail de aviso: crie uma conta gratuita no [Resend](https://resend.com) → **API Keys → Create** e guarde a chave:
   ```bash
   npx supabase secrets set RESEND_API_KEY=re_xxxxx
   ```
   - Sem domínio próprio, o Resend só entrega para o e-mail da sua conta do Resend. Para o vendedor também receber, verifique um domínio no Resend (**Domains**) e defina `AVISO_EMAIL_DE="CRM <avisos@seudominio.com.br>"`.
   - Por padrão recebem todos os usuários ativos. Para escolher, defina `AVISO_EMAILS=voce@x.com,vendedor@x.com`.
4. No Cal.com, em **Settings → Developer → Webhooks → New**:
   - **Subscriber URL**: `https://nvdhmoyulmdlyfgxhxsd.supabase.co/functions/v1/agenda-webhook`
   - **Secret**: o mesmo valor do segredo `CALCOM_WEBHOOK_SECRET`
   - **Events**: Booking Created, Booking Rescheduled, Booking Cancelled
   - Para o telefone vir junto, adicione no tipo de evento uma pergunta de telefone (ou uma pergunta com "WhatsApp" no nome).

## Lançar uma melhoria (tour das novidades)

O arquivo `novidades.js` tem a **VERSAO** e os **PASSOS** do tour (um passo por novidade, com o botão "me leva lá").
1. Escreva os passos novos (título, texto, aba e, se quiser, o que piscar na tela).
2. **Troque a VERSAO** (ex.: `'2026-11-05'`). Isso faz o tour aparecer de novo para todo mundo.
3. Publique a página. Cada pessoa vê o tour uma vez, na primeira entrada; fechou, não volta.

## Uso no dia a dia

- **Hoje**: primeiro quem respondeu e está esperando; depois os follow-ups do dia. Abra o WhatsApp pelo botão, fale com a pessoa e toque em **✓ Feito** / **✓ Respondi**.
- **Funil**: arraste os cards no computador; no celular, toque no card e troque a **Etapa**.
- **Reuniões**: no card, botão **🤝 Reunião**, que registra uma reunião já realizada ou agenda uma nova. As agendadas aparecem em **Hoje** no dia.
- **Funis e etapas** (dono, em **Configurações**): crie funis, renomeie e reordene etapas, crie etapas extras (ex.: "Negociação"). As 6 etapas com ⭐ são usadas pelas automações e não podem ser apagadas. O funil **padrão** é o que recebe os leads do WhatsApp.
- **🔔 Sino** (no topo): mensagens novas, cards que mudaram de etapa (por outra pessoa ou pela automação) e reuniões do dia. "Minhas" = cards em que você é o responsável; "Geral" = tudo que você pode ver. Os avisos são calculados na hora; o banco guarda só o que cada um já leu.
- **Checklist**: cada pessoa lança os números do dia (conexões enviadas, mensagens, follow-ups). O dono define a meta de cada um em **Configurações → Checklist diário**. Quem ficou abaixo da meta no último dia útil vê uma janela ao abrir o CRM; o "Ok" leva direto ao checklist.
- **Meta**: funil do mês corrente (contorno = meta, verde = feito) e barra de faturamento.
- **Painel**: dinheiro na mesa agora, vendas contra a meta, quanto falta por dia útil, conversão e qual anúncio traz venda.
- **Backup**: toda semana, **Painel → Exportar CSV**. O plano gratuito do Supabase não tem backup que você possa baixar.

## Segurança: o que já está protegido

- **RLS em todas as tabelas.** Sem login não se lê nada, e o vendedor só vê os leads dele. Isso vale no banco, não só na tela.
- **Usuário novo nasce inativo.** Mesmo que alguém crie uma conta, não vê nada até o dono liberar. O cadastro aberto fica desligado.
- **Travas no banco.** Só o dono troca responsável, arquiva, apaga e muda papéis. O sistema impede ficar sem dono.
- **Campos da automação** (origem, anúncio, "respondeu em") não podem ser alterados pela tela.
- **Webhook com assinatura do Meta.** Chamadas falsas recebem 401, e mensagens repetidas são ignoradas.
- **Chaves secretas** (`service_role` e App Secret) ficam só nos Secrets do Supabase.
- **Textos tratados como texto**, então nome ou mensagem com código não executa nada. Há também CSP restritiva e a biblioteca da CDN fixada com hash de integridade.
- **Exportação CSV** protegida contra injeção de fórmulas no Excel.
- **LGPD**: o dono pode apagar um lead definitivamente (com todo o histórico e as mensagens), a pedido do cliente.

**Se um vendedor sair:** em **Configurações → Usuários**, desmarque **Ativo** (corta o acesso na hora). Depois passe os leads dele para outra pessoa, abrindo cada card e trocando o **Responsável**.
