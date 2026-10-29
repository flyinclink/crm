-- =====================================================================
-- CRM comercial — banco de dados (Supabase / PostgreSQL)
-- Cole este arquivo inteiro no SQL Editor do Supabase e clique em Run.
-- Pode rodar de novo sem perder dados (usa "if not exists" / "or replace").
-- =====================================================================

create extension if not exists pg_cron;

-- Fuso horário do negócio. Troque se precisar (ex.: 'America/Cuiaba' para MT).
create or replace function public.crm_fuso() returns text
language sql immutable as $$ select 'America/Sao_Paulo' $$;

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
do $$ begin
  create type public.papel_usuario as enum ('dono', 'vendedor');
exception when duplicate_object then null; end $$;

-- Etapas "importantes": as automações e o painel usam esta marca,
-- então você pode renomear as etapas à vontade sem quebrar nada.
do $$ begin
  create type public.marco_etapa as enum
    ('novo', 'contato_feito', 'quente', 'reuniao', 'proposta', 'fechado', 'perdido');
exception when duplicate_object then null; end $$;
-- banco já criado antes da etapa "Reunião agendada" (rode esta linha sozinha antes, na primeira vez)
alter type public.marco_etapa add value if not exists 'reuniao' before 'proposta';

-- Telefone: só dígitos, com 55 e com o 9 do celular
-- (o WhatsApp às vezes manda celular brasileiro sem o 9).
create or replace function public.normalizar_telefone(p text) returns text
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d = '' then return null; end if;
  if length(d) in (10, 11) then d := '55' || d; end if;
  if length(d) = 12 and left(d, 2) = '55' and substr(d, 5, 1) in ('6','7','8','9') then
    d := left(d, 4) || '9' || substr(d, 5);
  end if;
  return d;
end $$;

-- =====================================================================
-- TABELAS
-- =====================================================================

-- Quem faz login. Nasce INATIVO: o dono precisa liberar.
create table if not exists public.perfis (
  id        uuid primary key references auth.users(id) on delete cascade,
  nome      text not null,
  email     text,
  papel     public.papel_usuario not null default 'vendedor',
  ativo     boolean not null default false,
  criado_em timestamptz not null default now()
);

-- Funis de venda (ex.: "Comercial", "Revenda").
create table if not exists public.funis (
  id        uuid primary key default gen_random_uuid(),
  nome      text not null check (char_length(nome) between 1 and 60),
  padrao    boolean not null default false,   -- onde caem os leads do WhatsApp
  ativo     boolean not null default true,
  criado_em timestamptz not null default now()
);
create unique index if not exists funis_um_padrao on public.funis (padrao) where padrao;

-- Colunas de cada funil, na ordem.
create table if not exists public.etapas (
  id        uuid primary key default gen_random_uuid(),
  funil_id  uuid not null references public.funis(id) on delete cascade,
  nome      text not null check (char_length(nome) between 1 and 40),
  ordem     int not null,
  marco     public.marco_etapa,               -- vazio = etapa comum
  criado_em timestamptz not null default now(),
  unique (id, funil_id),
  unique (funil_id, marco)
);
create index if not exists etapas_funil_idx on public.etapas (funil_id, ordem);

-- Cada cliente em potencial (o "card" do funil).
create table if not exists public.cards (
  id                 uuid primary key default gen_random_uuid(),
  funil_id           uuid not null references public.funis(id),
  etapa_id           uuid not null,
  nome               text not null check (char_length(nome) between 1 and 120),
  whatsapp           text unique check (whatsapp ~ '^[0-9]{10,15}$'),
  instagram          text check (char_length(instagram) <= 60),
  origem             text not null default 'manual'
                     check (origem in ('manual', 'whatsapp_anuncio', 'whatsapp_direto')),
  anuncio            text check (char_length(anuncio) <= 200),
  responsavel_id     uuid not null default auth.uid() references public.perfis(id),
  valor_proposta     numeric(12,2) check (valor_proposta >= 0),
  valor_venda        numeric(12,2) check (valor_venda >= 0),
  motivo_perda       text check (motivo_perda in
                     ('sem_resposta', 'preco', 'comprou_outro', 'sem_interesse', 'outro')),
  ultima_resposta_em timestamptz,   -- última mensagem que o CLIENTE mandou
  ultimo_contato_em  timestamptz,   -- último contato que NÓS registramos
  -- datas em que o card entrou em cada etapa importante
  entrou_etapa_em    timestamptz not null default now(),   -- etapa atual
  contato_em         timestamptz,
  quente_em          timestamptz,
  proposta_em        timestamptz,
  fechado_em         timestamptz,
  perdido_em         timestamptz,
  arquivado          boolean not null default false,
  criado_em          timestamptz not null default now(),
  atualizado_em      timestamptz not null default now(),
  foreign key (etapa_id, funil_id) references public.etapas (id, funil_id)  -- etapa tem que ser do mesmo funil
);
-- contato e próxima ação (alter: funciona também em banco já criado)
alter table public.cards add column if not exists email text
  check (email is null or (char_length(email) <= 120 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'));
alter table public.cards add column if not exists cargo text check (char_length(cargo) <= 80);
alter table public.cards add column if not exists proxima_acao text check (char_length(proxima_acao) <= 200);
alter table public.cards add column if not exists proxima_acao_em timestamptz;
create index if not exists cards_proxima_acao_idx on public.cards (proxima_acao_em) where proxima_acao_em is not null;
create index if not exists cards_responsavel_idx on public.cards (responsavel_id);
create index if not exists cards_etapa_idx on public.cards (etapa_id);

-- Histórico do card: cada mudança de etapa (preenchido sozinho).
create table if not exists public.historico_card (
  id            bigint generated always as identity primary key,
  card_id       uuid not null references public.cards(id) on delete cascade,
  etapa_de_id   uuid references public.etapas(id) on delete set null,
  etapa_para_id uuid references public.etapas(id) on delete set null,
  nome_de       text,                 -- nomes guardados como estavam na hora
  nome_para     text not null,
  marco_de      public.marco_etapa,
  marco_para    public.marco_etapa,
  por           uuid references public.perfis(id) on delete set null,   -- vazio = automação
  quando        timestamptz not null default now()
);
create index if not exists historico_card_idx on public.historico_card (card_id, quando desc);
create index if not exists historico_quando_idx on public.historico_card (quando);

-- Reuniões (agendadas e realizadas).
create table if not exists public.reunioes (
  id            uuid primary key default gen_random_uuid(),
  card_id       uuid not null references public.cards(id) on delete cascade,
  agendada_para timestamptz not null,
  realizada_em  timestamptz,          -- preenchido = reunião realizada
  cancelada     boolean not null default false,
  resumo        text check (char_length(resumo) <= 2000),
  criado_por    uuid default auth.uid() references public.perfis(id) on delete set null,
  criado_em     timestamptz not null default now()
);
create index if not exists reunioes_card_idx on public.reunioes (card_id);
create index if not exists reunioes_pendentes_idx on public.reunioes (agendada_para)
  where realizada_em is null and not cancelada;

-- Diário do card: mensagens recebidas, contatos, propostas, notas.
create table if not exists public.atividades (
  id        bigint generated always as identity primary key,
  card_id   uuid not null references public.cards(id) on delete cascade,
  autor_id  uuid default auth.uid() references public.perfis(id) on delete set null, -- vazio = automação
  tipo      text not null check (tipo in
            ('mensagem_recebida', 'contato', 'proposta', 'venda', 'perda', 'nota')),
  descricao text check (char_length(descricao) <= 2000),
  valor     numeric(12,2),
  criado_em timestamptz not null default now()
);
create index if not exists atividades_card_idx on public.atividades (card_id, criado_em desc);

-- Agenda de follow-up: 10 contatos (2 por dia x 5 dias).
create table if not exists public.followups (
  id            bigint generated always as identity primary key,
  card_id       uuid not null references public.cards(id) on delete cascade,
  ciclo         smallint not null default 1,
  numero        smallint not null check (numero between 1 and 10),
  agendado_para timestamptz not null,
  feito_em      timestamptz,
  feito_por     uuid references public.perfis(id) on delete set null
);
create index if not exists followups_card_idx on public.followups (card_id);

-- Cópia bruta de cada mensagem recebida no WhatsApp (evita duplicar).
create table if not exists public.mensagens_whatsapp (
  wamid       text primary key,
  telefone    text not null,
  nome_perfil text,
  tipo        text,
  texto       text,
  referral    jsonb,
  payload     jsonb,
  card_id     uuid references public.cards(id) on delete cascade,
  recebida_em timestamptz not null default now()
);

-- Meta de cada mês (mes = primeiro dia do mês).
create table if not exists public.metas (
  mes         date primary key check (extract(day from mes) = 1),
  vendas      int not null check (vendas > 0),
  faturamento numeric(12,2)
);
-- metas de cada etapa do funil (tela "Meta")
alter table public.metas add column if not exists leads int check (leads >= 0);
alter table public.metas add column if not exists quentes int check (quentes >= 0);
alter table public.metas add column if not exists reunioes_agendadas int check (reunioes_agendadas >= 0);
alter table public.metas add column if not exists reunioes_realizadas int check (reunioes_realizadas >= 0);

-- Sino de avisos: os avisos são CALCULADOS na hora (mensagens, mudanças de etapa, reuniões do dia).
-- Aqui fica só quem já leu o quê.
create table if not exists public.avisos_lidos (
  perfil_id uuid not null default auth.uid() references public.perfis(id) on delete cascade,
  chave     text not null check (char_length(chave) <= 120),   -- ex.: "m:123", "h:45", "r:<id>:2026-10-29"
  lido_em   timestamptz not null default now(),
  primary key (perfil_id, chave)
);
-- "Marcar todos como lidos": tudo até esta hora conta como lido
create table if not exists public.avisos_marca (
  perfil_id uuid primary key default auth.uid() references public.perfis(id) on delete cascade,
  lidos_ate timestamptz not null default now()
);

-- Checklist diário: cada pessoa lança os números do dia; a meta de cada um o dono define.
create table if not exists public.checklist_metas (
  perfil_id uuid primary key references public.perfis(id) on delete cascade,
  conexoes  int check (conexoes between 0 and 10000),
  mensagens int check (mensagens between 0 and 10000),
  followups int check (followups between 0 and 10000)
);
create table if not exists public.checklist_dia (
  perfil_id     uuid not null default auth.uid() references public.perfis(id) on delete cascade,
  dia           date not null,
  conexoes      int not null default 0 check (conexoes between 0 and 10000),
  mensagens     int not null default 0 check (mensagens between 0 and 10000),
  followups     int not null default 0 check (followups between 0 and 10000),
  atualizado_em timestamptz not null default now(),
  primary key (perfil_id, dia)
);

-- Cada envio do formulário (Tally). O nome do formulário vira a ETIQUETA do card.
create table if not exists public.envios_formulario (
  submission_id text primary key,          -- id do envio no Tally (evita duplicar)
  form_id       text not null,
  form_nome     text not null,             -- = nome do material = etiqueta
  email         text,
  card_id       uuid references public.cards(id) on delete cascade,
  via           text not null default 'aviso' check (via in ('aviso', 'busca')),
  payload       jsonb,
  enviado_em    timestamptz not null default now(),
  recebido_em   timestamptz not null default now()
);
-- Reuniões: dono da reunião (quem tem a agenda), de onde veio e o id na agenda (Cal.com)
alter table public.reunioes add column if not exists responsavel_id uuid default auth.uid()
  references public.perfis(id) on delete set null;
alter table public.reunioes add column if not exists origem text not null default 'crm'
  check (origem in ('crm', 'agenda'));
alter table public.reunioes add column if not exists externo_id text;
alter table public.reunioes add column if not exists titulo text check (char_length(titulo) <= 200);
alter table public.reunioes add column if not exists link text check (char_length(link) <= 500);
create unique index if not exists reunioes_externo_unico on public.reunioes (externo_id) where externo_id is not null;
alter table public.cards add column if not exists reuniao_em timestamptz;   -- quando entrou em "Reunião agendada"

create index if not exists envios_card_idx on public.envios_formulario (card_id);
create index if not exists envios_form_idx on public.envios_formulario (form_id, enviado_em desc);

-- Cards: origem "formulario", pontuação de 0 a 100 e e-mail único (para juntar envios da mesma pessoa)
alter table public.cards drop constraint if exists cards_origem_check;
alter table public.cards add constraint cards_origem_check
  check (origem in ('manual', 'whatsapp_anuncio', 'whatsapp_direto', 'formulario', 'agenda'));
alter table public.cards add column if not exists empresa text check (char_length(empresa) <= 120);
alter table public.cards add column if not exists faturamento text check (char_length(faturamento) <= 60);  -- faixa, ex.: "De 60 a 80 mil"
alter table public.cards add column if not exists pontuacao int not null default 0 check (pontuacao between 0 and 100);
alter table public.cards add column if not exists pontuacao_motivos jsonb not null default '[]'::jsonb;
create unique index if not exists cards_email_unico on public.cards (email) where email is not null;

alter table public.atividades drop constraint if exists atividades_tipo_check;
alter table public.atividades add constraint atividades_tipo_check
  check (tipo in ('mensagem_recebida', 'contato', 'proposta', 'venda', 'perda', 'nota', 'formulario', 'agenda'));

-- =====================================================================
-- FUNÇÕES DE APOIO
-- =====================================================================
create or replace function public.eu_ativo() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfis where id = auth.uid() and ativo)
$$;

create or replace function public.sou_dono() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfis where id = auth.uid() and ativo and papel = 'dono')
$$;

create or replace function public.marco_da_etapa(p_etapa uuid) returns public.marco_etapa
language sql stable security definer set search_path = public as $$
  select marco from etapas where id = p_etapa
$$;

create or replace function public.etapa_do_marco(p_funil uuid, p_marco public.marco_etapa) returns uuid
language sql stable security definer set search_path = public as $$
  select id from etapas where funil_id = p_funil and marco = p_marco
$$;

drop function if exists public.nivel_cargo(text);
drop function if exists public.calcular_pontuacao(uuid, text);

-- Pontos da faixa de faturamento (0 a 40), pelo começo da faixa:
-- até 30 mil = 5 · 30 = 10 · 40 = 15 · 60 = 20 · 80 = 25 · 100 = 30 · 150 = 35 · 250 ou mais = 40
-- "De 60 a 80 mil" para cima (20 pontos ou mais) = lead quente.
create or replace function public.pontos_faturamento(p text) returns int
language plpgsql immutable as $$
declare
  c     text := btrim(translate(lower(coalesce(p, '')), 'áàâãéêíóôõúç', 'aaaaeeiooouc'));
  n     numeric;
  menor numeric;
begin
  if c = '' then return 0; end if;
  n := nullif(replace(substring(c from '[0-9]+(?:[.,][0-9]+)?'), ',', '.'), '')::numeric;
  if n is null then return 0; end if;
  if c ~ 'milh' and c !~ '\mmil\M' then n := n * 1000; end if;     -- "1 milhão" = 1000 mil
  menor := case when c ~ '^(ate|menos de|abaixo de)' then 0 else n end;
  return case when menor >= 250 then 40 when menor >= 150 then 35 when menor >= 100 then 30
              when menor >= 80 then 25 when menor >= 60 then 20 when menor >= 40 then 15
              when menor >= 30 then 10 else 5 end;
end $$;

-- Pontuação de 0 a 100, com o motivo de cada ponto:
-- faturamento (até 40) + materiais baixados (15 cada, até 30) + respostas às nossas mensagens (até 30)
create or replace function public.calcular_pontuacao(p_card uuid, p_faturamento text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_fat      text := btrim(coalesce(p_faturamento, ''));
  v_pc       int := pontos_faturamento(p_faturamento);
  v_mat      int;
  v_pm       int;
  v_primeiro timestamptz;
  v_resp     int := 0;
  v_pr       int;
begin
  select count(distinct form_id) into v_mat from envios_formulario where card_id = p_card;
  v_pm := least(v_mat, 2) * 15;

  -- só contam mensagens do cliente recebidas DEPOIS do nosso primeiro contato
  select min(criado_em) into v_primeiro from atividades
   where card_id = p_card and tipo in ('contato', 'proposta', 'venda');
  if v_primeiro is not null then
    select count(*) into v_resp from atividades
     where card_id = p_card and tipo = 'mensagem_recebida' and criado_em > v_primeiro;
  end if;
  v_pr := case when v_resp >= 3 then 30 when v_resp >= 1 then 20 else 0 end;

  return jsonb_build_object(
    'total', least(100, v_pc + v_pm + v_pr),
    'motivos', jsonb_build_array(
      jsonb_build_object('pontos', v_pc, 'max', 40, 'motivo',
        case when v_fat = '' then 'Faturamento não informado'
             when v_pc >= 20 then 'Faturamento ' || v_fat || ' (faixa alta)'
             else 'Faturamento ' || v_fat end),
      jsonb_build_object('pontos', v_pm, 'max', 30, 'motivo',
        case when v_mat = 0 then 'Não baixou nenhum material'
             when v_mat = 1 then 'Baixou 1 material (15 por material)'
             else 'Baixou ' || v_mat || ' materiais (15 por material, máx. 30)' end),
      jsonb_build_object('pontos', v_pr, 'max', 30, 'motivo',
        case when v_resp = 0 then 'Ainda não respondeu às nossas mensagens'
             when v_resp < 3 then 'Respondeu ' || v_resp || ' vez(es) (20; com 3 ou mais vira 30)'
             else 'Respondeu ' || v_resp || ' vezes (máximo)' end)));
end $$;

-- Força o recálculo (o gatilho do card calcula a pontuação em toda atualização).
create or replace function public.recalcular_pontuacao(p_card uuid) returns void
language sql security definer set search_path = public as $$
  update cards set pontuacao = pontuacao where id = p_card
$$;

-- =====================================================================
-- GATILHOS (automações)
-- =====================================================================

-- Usuário convidado ganha um perfil inativo.
create or replace function public.tg_novo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into perfis (id, nome, email)
  values (new.id,
          coalesce(nullif(new.raw_user_meta_data->>'nome', ''), split_part(new.email, '@', 1)),
          new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists novo_usuario on auth.users;
create trigger novo_usuario after insert on auth.users
  for each row execute function public.tg_novo_usuario();

-- Nunca deixar o sistema sem um dono ativo.
create or replace function public.tg_perfis_guarda() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.papel = 'dono' and old.ativo
     and (new.papel <> 'dono' or not new.ativo)
     and not exists (select 1 from perfis where id <> old.id and papel = 'dono' and ativo) then
    raise exception 'Precisa existir pelo menos um dono ativo.';
  end if;
  new.id := old.id;
  new.email := old.email;
  return new;
end $$;

drop trigger if exists perfis_guarda on public.perfis;
create trigger perfis_guarda before update on public.perfis
  for each row execute function public.tg_perfis_guarda();

-- Funil novo já nasce com as 6 etapas padrão.
create or replace function public.tg_funil_novo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into etapas (funil_id, nome, ordem, marco) values
    (new.id, 'Novo lead',        10, 'novo'),
    (new.id, 'Contato feito',    20, 'contato_feito'),
    (new.id, 'Lead quente',      30, 'quente'),
    (new.id, 'Reunião agendada', 35, 'reuniao'),
    (new.id, 'Proposta enviada', 40, 'proposta'),
    (new.id, 'Fechado',          50, 'fechado'),
    (new.id, 'Perdido',          60, 'perdido');
  return null;
end $$;

drop trigger if exists funil_novo on public.funis;
create trigger funil_novo after insert on public.funis
  for each row execute function public.tg_funil_novo();

-- A marca de uma etapa importante não muda e ela não pode ser apagada.
create or replace function public.tg_etapas_guarda() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.marco is not null
       and exists (select 1 from funis where id = old.funil_id) then   -- (apagar o funil inteiro pode)
      raise exception 'A etapa "%" é usada pelas automações e não pode ser apagada (renomeie se quiser).', old.nome;
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    new.marco := old.marco;
    new.funil_id := old.funil_id;
  end if;
  return new;
end $$;

drop trigger if exists etapas_guarda on public.etapas;
create trigger etapas_guarda before update or delete on public.etapas
  for each row execute function public.tg_etapas_guarda();

-- Gera os 10 follow-ups: agora + próximos horários das 09h e 15h.
create or replace function public.gerar_followups(p_card uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_ciclo smallint;
  v_hoje  date := (now() at time zone crm_fuso())::date;
begin
  select coalesce(max(ciclo), 0) + 1 into v_ciclo from followups where card_id = p_card;
  delete from followups where card_id = p_card and feito_em is null;

  insert into followups (card_id, ciclo, numero, agendado_para)
  select p_card, v_ciclo, row_number() over (order by s), s
  from (
    select now() as s
    union all
    (select ((v_hoje + g) + t) at time zone crm_fuso() as s
       from generate_series(0, 7) g,
            (values (time '09:00'), (time '15:00')) v(t)
      where ((v_hoje + g) + t) at time zone crm_fuso() > now() + interval '2 hours'
      order by 1
      limit 9)
  ) x;
end $$;

-- Cards: arruma os dados, aplica as travas e grava as datas das etapas importantes.
create or replace function public.tg_cards_antes() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_usuario uuid := auth.uid();
  v_marco   marco_etapa;
  v_antigo  marco_etapa;
  v_pont    jsonb;
begin
  new.whatsapp := normalizar_telefone(new.whatsapp);
  new.instagram := nullif(regexp_replace(coalesce(new.instagram, ''), '[^A-Za-z0-9._]', '', 'g'), '');
  new.nome := btrim(new.nome);
  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.cargo := nullif(btrim(coalesce(new.cargo, '')), '');
  new.empresa := nullif(btrim(coalesce(new.empresa, '')), '');
  new.faturamento := nullif(btrim(coalesce(new.faturamento, '')), '');
  new.proxima_acao := nullif(btrim(coalesce(new.proxima_acao, '')), '');
  if new.proxima_acao is null then new.proxima_acao_em := null; end if;

  if tg_op = 'INSERT' then
    if new.funil_id is null then
      select id into new.funil_id from funis where ativo order by padrao desc, criado_em limit 1;
    end if;
    if v_usuario is not null then                 -- criado por uma pessoa pela tela
      if not sou_dono() then new.responsavel_id := v_usuario; end if;
      new.origem := 'manual';
      new.anuncio := null;
      new.ultima_resposta_em := null;
      new.arquivado := false;
      new.etapa_id := null;                       -- sempre começa na primeira etapa
    end if;
    if new.etapa_id is null then
      new.etapa_id := coalesce(etapa_do_marco(new.funil_id, 'novo'),
                               (select id from etapas where funil_id = new.funil_id order by ordem limit 1));
    end if;
    new.criado_em := now();
    new.entrou_etapa_em := now();
    v_marco := marco_da_etapa(new.etapa_id);
    v_antigo := null;
  else
    if v_usuario is not null then
      if new.responsavel_id is distinct from old.responsavel_id and not sou_dono() then
        raise exception 'Só o dono pode trocar o responsável.';
      end if;
      if new.arquivado is distinct from old.arquivado and not sou_dono() then
        raise exception 'Só o dono pode arquivar.';
      end if;
      -- campos que só a automação preenche
      new.origem := old.origem;
      new.anuncio := old.anuncio;
      new.ultima_resposta_em := old.ultima_resposta_em;
      new.criado_em := old.criado_em;
    end if;
    new.contato_em := old.contato_em;
    new.quente_em := old.quente_em;
    new.proposta_em := old.proposta_em;
    new.fechado_em := old.fechado_em;
    new.perdido_em := old.perdido_em;
    new.reuniao_em := old.reuniao_em;
    new.entrou_etapa_em := old.entrou_etapa_em;

    if new.etapa_id is distinct from old.etapa_id then
      new.entrou_etapa_em := now();
      v_marco := marco_da_etapa(new.etapa_id);
      v_antigo := marco_da_etapa(old.etapa_id);
      if v_antigo = 'perdido' and v_marco is distinct from 'perdido' then
        new.perdido_em := null; new.motivo_perda := null;
      end if;
      if v_antigo = 'fechado' and v_marco is distinct from 'fechado' then
        new.fechado_em := null;
      end if;
    end if;
  end if;

  -- datas das etapas importantes (só quando entra numa delas)
  if tg_op = 'INSERT' or new.etapa_id is distinct from old.etapa_id then
    if v_marco = 'contato_feito' then new.contato_em := coalesce(new.contato_em, now()); end if;
    if v_marco = 'quente'        then new.quente_em := coalesce(new.quente_em, now()); end if;
    if v_marco = 'reuniao'       then new.reuniao_em := now(); end if;
    if v_marco = 'proposta'      then new.proposta_em := now(); end if;
    if v_marco = 'fechado'       then new.fechado_em := now(); end if;
    if v_marco = 'perdido'       then
      new.perdido_em := now();
      new.motivo_perda := coalesce(new.motivo_perda, 'outro');
    end if;
  end if;
  -- motivo de perda só existe em card perdido
  if marco_da_etapa(new.etapa_id) is distinct from 'perdido' then new.motivo_perda := null; end if;

  -- pontuação: sempre calculada pelo banco (a tela não consegue mudar)
  v_pont := calcular_pontuacao(new.id, new.faturamento);
  new.pontuacao := (v_pont->>'total')::int;
  new.pontuacao_motivos := v_pont->'motivos';

  new.atualizado_em := now();
  return new;
end $$;

drop trigger if exists cards_antes on public.cards;
create trigger cards_antes before insert or update on public.cards
  for each row execute function public.tg_cards_antes();

-- Cards: grava o HISTÓRICO sozinho e liga o follow-up.
create or replace function public.tg_cards_depois() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  e_de   etapas;
  e_para etapas;
begin
  if tg_op = 'UPDATE' and new.etapa_id is not distinct from old.etapa_id then return null; end if;

  select * into e_para from etapas where id = new.etapa_id;
  if tg_op = 'UPDATE' then select * into e_de from etapas where id = old.etapa_id; end if;

  insert into historico_card (card_id, etapa_de_id, etapa_para_id, nome_de, nome_para, marco_de, marco_para, por)
  values (new.id, e_de.id, e_para.id, e_de.nome, e_para.nome, e_de.marco, e_para.marco, auth.uid());

  if tg_op = 'INSERT' and e_para.marco in ('novo', 'contato_feito') then
    perform gerar_followups(new.id);
  elsif tg_op = 'UPDATE' and e_de.marco = 'perdido' and e_para.marco in ('novo', 'contato_feito') then
    perform gerar_followups(new.id);                -- card reaberto: recomeça o follow-up
  end if;
  return null;
end $$;

drop trigger if exists cards_depois on public.cards;
create trigger cards_depois after insert or update on public.cards
  for each row execute function public.tg_cards_depois();

-- Um contato nosso: atualiza "último contato" e tira o card de "Novo lead".
create or replace function public.registrar_contato_no_card(p_card uuid, p_quando timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  update cards c
     set ultimo_contato_em = greatest(coalesce(c.ultimo_contato_em, p_quando), p_quando),
         etapa_id = case when marco_da_etapa(c.etapa_id) = 'novo'
                         then coalesce(etapa_do_marco(c.funil_id, 'contato_feito'), c.etapa_id)
                         else c.etapa_id end
   where c.id = p_card;
end $$;

create or replace function public.tg_atividade_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tipo in ('contato', 'proposta', 'venda') then
    perform registrar_contato_no_card(new.card_id, new.criado_em);   -- também recalcula a pontuação
  elsif new.tipo = 'mensagem_recebida' then
    perform recalcular_pontuacao(new.card_id);
  end if;
  return null;
end $$;

-- Atividade registrada pela tela fica com a hora de agora (não dá para "voltar no tempo" no histórico).
create or replace function public.tg_atividade_antes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then new.criado_em := now(); end if;
  return new;
end $$;

drop trigger if exists atividade_antes on public.atividades;
create trigger atividade_antes before insert on public.atividades
  for each row execute function public.tg_atividade_antes();

drop trigger if exists atividade_depois on public.atividades;
create trigger atividade_depois after insert on public.atividades
  for each row execute function public.tg_atividade_depois();

-- Reunião realizada também conta como contato.
-- Reunião AGENDADA leva o card para "Reunião agendada" (de Novo, Contato feito, Quente ou Perdido).
create or replace function public.tg_reuniao_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.realizada_em is not null and (tg_op = 'INSERT' or old.realizada_em is null) then
    perform registrar_contato_no_card(new.card_id, least(new.realizada_em, now()));
  end if;
  if tg_op = 'INSERT' and new.realizada_em is null and not new.cancelada then
    update cards c
       set etapa_id = coalesce(etapa_do_marco(c.funil_id, 'reuniao'), c.etapa_id)
     where c.id = new.card_id
       and marco_da_etapa(c.etapa_id) in ('novo', 'contato_feito', 'quente', 'perdido');
  end if;
  return null;
end $$;

drop trigger if exists reuniao_depois on public.reunioes;
create trigger reuniao_depois after insert or update on public.reunioes
  for each row execute function public.tg_reuniao_depois();

create or replace function public.tg_reuniao_antes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.card_id := old.card_id;
    new.criado_por := old.criado_por;
    new.criado_em := old.criado_em;
    new.origem := old.origem;
    if auth.uid() is not null then new.externo_id := old.externo_id; end if;
  elsif auth.uid() is not null then               -- agendada pela tela
    new.origem := 'crm';
    new.externo_id := null;
  end if;
  new.responsavel_id := coalesce(new.responsavel_id, auth.uid(),
                                 (select responsavel_id from cards where id = new.card_id));
  if new.realizada_em > now() + interval '5 minutes' then
    raise exception 'Uma reunião não pode ter sido realizada no futuro.';
  end if;
  return new;
end $$;

drop trigger if exists reuniao_antes on public.reunioes;
create trigger reuniao_antes before insert or update on public.reunioes
  for each row execute function public.tg_reuniao_antes();

-- Follow-up: pela tela só dá para marcar/desmarcar "feito".
create or replace function public.tg_followup_antes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    new.card_id := old.card_id;
    new.ciclo := old.ciclo;
    new.numero := old.numero;
    new.agendado_para := old.agendado_para;
    if new.feito_em is not null and old.feito_em is null then
      new.feito_em := now();
      new.feito_por := auth.uid();
    elsif new.feito_em is null then
      new.feito_por := null;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists followup_antes on public.followups;
create trigger followup_antes before update on public.followups
  for each row execute function public.tg_followup_antes();

create or replace function public.tg_followup_depois() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.feito_em is null and new.feito_em is not null then
    insert into atividades (card_id, autor_id, tipo, descricao)
    values (new.card_id, new.feito_por, 'contato', 'Follow-up ' || new.numero || '/10');
  end if;
  return null;
end $$;

drop trigger if exists followup_depois on public.followups;
create trigger followup_depois after update on public.followups
  for each row execute function public.tg_followup_depois();

-- =====================================================================
-- AUTOMAÇÃO DO WHATSAPP (chamada só pela Edge Function)
-- =====================================================================
create or replace function public.processar_mensagem_whatsapp(
  p_wamid text, p_telefone text, p_nome text, p_tipo text, p_texto text,
  p_referral jsonb, p_payload jsonb, p_recebida_em timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tel    text := normalizar_telefone(p_telefone);
  v_card   cards;
  v_id     uuid;
  v_resp   uuid;
  v_quente uuid;
  v_quando timestamptz := least(coalesce(p_recebida_em, now()), now());
begin
  if v_tel is null or v_tel !~ '^[0-9]{10,15}$' then
    raise exception 'telefone inválido';
  end if;

  insert into mensagens_whatsapp (wamid, telefone, nome_perfil, tipo, texto, referral, payload, recebida_em)
  values (p_wamid, v_tel, left(p_nome, 120), left(p_tipo, 30), left(p_texto, 2000), p_referral, p_payload, v_quando)
  on conflict (wamid) do nothing;
  if not found then return null; end if;          -- já processada

  select * into v_card from cards where whatsapp = v_tel for update;

  if v_card.id is null then
    -- card novo, no funil padrão, com o primeiro vendedor ativo (se não houver, o dono)
    select id into v_resp from perfis
     where ativo order by (papel = 'vendedor') desc, criado_em limit 1;
    if v_resp is null then raise exception 'nenhum usuário ativo para receber o lead'; end if;

    insert into cards (nome, whatsapp, origem, anuncio, responsavel_id, ultima_resposta_em)
    values (
      coalesce(nullif(btrim(left(p_nome, 120)), ''), '+' || v_tel),
      v_tel,
      case when p_referral is not null then 'whatsapp_anuncio' else 'whatsapp_direto' end,
      left(nullif(coalesce(p_referral->>'headline', p_referral->>'source_id', ''), ''), 200),
      v_resp,
      v_quando)
    on conflict (whatsapp) do nothing
    returning id into v_id;

    if v_id is null then                          -- outro processo criou ao mesmo tempo
      select id into v_id from cards where whatsapp = v_tel;
    end if;
  else
    v_id := v_card.id;
    -- respondeu ao nosso contato = quente (em "Novo lead" ainda não falamos com ele)
    if marco_da_etapa(v_card.etapa_id) in ('contato_feito', 'perdido') then
      v_quente := etapa_do_marco(v_card.funil_id, 'quente');
    end if;
    update cards
       set ultima_resposta_em = greatest(coalesce(ultima_resposta_em, v_quando), v_quando),
           etapa_id = coalesce(v_quente, etapa_id)
     where id = v_id;
  end if;

  update mensagens_whatsapp set card_id = v_id where wamid = p_wamid;
  insert into atividades (card_id, autor_id, tipo, descricao, criado_em)
  values (v_id, null, 'mensagem_recebida',
          left(coalesce(nullif(p_texto, ''), '[' || coalesce(p_tipo, 'mensagem') || ']'), 2000), v_quando);
  return v_id;
end $$;

-- =====================================================================
-- AUTOMAÇÃO DO FORMULÁRIO (Tally) — chamada só pelas Edge Functions
-- Mesmo e-mail (ou telefone) = mesmo card: só ganha mais uma etiqueta.
-- Faturamento de 60 mil para cima = entra em "Lead quente".
-- =====================================================================
drop function if exists public.processar_envio_formulario(text, text, text, text, text, text, text, timestamptz, jsonb, text);
create or replace function public.processar_envio_formulario(
  p_submission_id text, p_form_id text, p_form_nome text, p_nome text, p_email text,
  p_telefone text, p_cargo text, p_empresa text, p_faturamento text,
  p_enviado_em timestamptz, p_payload jsonb, p_via text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_email    text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_tel      text := normalizar_telefone(p_telefone);
  v_cargo    text := nullif(btrim(left(coalesce(p_cargo, ''), 80)), '');
  v_empresa  text := nullif(btrim(left(coalesce(p_empresa, ''), 120)), '');
  v_fat      text := nullif(btrim(left(coalesce(p_faturamento, ''), 60)), '');
  v_nome     text := nullif(btrim(left(coalesce(p_nome, ''), 120)), '');
  v_material text := coalesce(nullif(btrim(left(coalesce(p_form_nome, ''), 200)), ''), 'Formulário');
  v_quando   timestamptz := least(coalesce(p_enviado_em, now()), now());
  v_card     cards;
  v_id       uuid;
  v_resp     uuid;
  v_funil    uuid;
begin
  if p_submission_id is null or p_form_id is null then raise exception 'envio sem identificação'; end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_email := null; end if;
  if v_tel is not null and v_tel !~ '^[0-9]{10,15}$' then v_tel := null; end if;

  insert into envios_formulario (submission_id, form_id, form_nome, email, payload, enviado_em, via)
  values (left(p_submission_id, 200), left(p_form_id, 100), v_material, v_email, p_payload, v_quando,
          case when p_via = 'busca' then 'busca' else 'aviso' end)
  on conflict (submission_id) do nothing;
  if not found then return null; end if;          -- já processado (aviso + busca não duplicam)

  -- procura a pessoa: primeiro pelo e-mail, depois pelo telefone
  if v_email is not null then select * into v_card from cards where email = v_email for update; end if;
  if v_card.id is null and v_tel is not null then select * into v_card from cards where whatsapp = v_tel for update; end if;

  if v_card.id is null then
    select id into v_resp from perfis where ativo order by (papel = 'vendedor') desc, criado_em limit 1;
    if v_resp is null then raise exception 'nenhum usuário ativo para receber o lead'; end if;
    select id into v_funil from funis where ativo order by padrao desc, criado_em limit 1;
    begin
      insert into cards (funil_id, etapa_id, nome, email, whatsapp, cargo, empresa, faturamento, origem, anuncio,
                         responsavel_id, proxima_acao, proxima_acao_em)
      values (v_funil,
              case when pontos_faturamento(v_fat) >= 20
                   then etapa_do_marco(v_funil, 'quente') end,      -- vazio = "Novo lead"
              coalesce(v_nome, split_part(v_email, '@', 1), '+' || v_tel, 'Lead do formulário'),
              v_email, v_tel, v_cargo, v_empresa, v_fat, 'formulario', v_material, v_resp,
              left('Primeiro contato: baixou "' || v_material || '"', 200), now())
      returning id into v_id;
    exception when unique_violation then          -- outro envio da mesma pessoa chegou junto
      select id into v_id from cards where (v_email is not null and email = v_email)
                                        or (v_tel is not null and whatsapp = v_tel) limit 1;
    end;
  else
    v_id := v_card.id;
    update cards c
       set cargo       = coalesce(v_cargo, c.cargo),          -- vale o dado mais recente informado
           empresa     = coalesce(v_empresa, c.empresa),
           faturamento = coalesce(v_fat, c.faturamento),

           email    = coalesce(c.email, v_email),
           whatsapp = coalesce(c.whatsapp,
                        case when not exists (select 1 from cards x where x.whatsapp = v_tel) then v_tel end),
           nome     = case when c.nome like '+%' and v_nome is not null then v_nome else c.nome end,
           etapa_id = case when marco_da_etapa(c.etapa_id) in ('novo', 'contato_feito')
                            and pontos_faturamento(coalesce(v_fat, c.faturamento)) >= 20
                           then coalesce(etapa_do_marco(c.funil_id, 'quente'), c.etapa_id)
                           else c.etapa_id end
     where c.id = v_id;
  end if;

  update envios_formulario set card_id = v_id where submission_id = left(p_submission_id, 200);
  -- juntou pelo telefone com outro e-mail: o e-mail novo fica anotado no histórico
  select email into v_card.email from cards where id = v_id;
  insert into atividades (card_id, autor_id, tipo, descricao, criado_em)
  values (v_id, null, 'formulario',
          left('Baixou "' || v_material || '"'
               || case when v_email is not null and v_email is distinct from v_card.email
                       then ' · usou outro e-mail: ' || v_email else '' end, 2000),
          v_quando);
  perform recalcular_pontuacao(v_id);
  return v_id;
end $$;

-- =====================================================================
-- AUTOMAÇÃO DA AGENDA (Cal.com) — chamada só pela Edge Function
-- Mesmo e-mail (ou telefone) = mesmo card, que anda para "Reunião agendada".
-- O dono da reunião é quem tem a agenda (pelo e-mail do login no CRM).
-- =====================================================================
create or replace function public.processar_agendamento(
  p_evento text, p_uid text, p_uid_anterior text, p_inicio timestamptz,
  p_organizador_email text, p_nome text, p_email text, p_telefone text,
  p_titulo text, p_link text, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email  text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_tel    text := normalizar_telefone(p_telefone);
  v_nome   text := nullif(btrim(left(coalesce(p_nome, ''), 120)), '');
  v_titulo text := nullif(btrim(left(coalesce(p_titulo, ''), 200)), '');
  v_link   text := case when p_link ~ '^https://' then left(p_link, 500) end;
  v_dono   uuid;
  v_card   cards;
  v_id     uuid;
  v_novo   boolean := false;
  v_reun   reunioes;
  v_funil  uuid;
begin
  if p_uid is null or p_uid = '' then raise exception 'agendamento sem identificação'; end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_email := null; end if;
  if v_tel is not null and v_tel !~ '^[0-9]{10,15}$' then v_tel := null; end if;

  -- cancelou
  if p_evento = 'cancelada' then
    update reunioes set cancelada = true
     where externo_id = p_uid and not cancelada and realizada_em is null
     returning * into v_reun;
    if v_reun.id is null then return null; end if;
    insert into atividades (card_id, autor_id, tipo, descricao)
    values (v_reun.card_id, null, 'agenda',
            'Cancelou a reunião de ' || to_char(v_reun.agendada_para at time zone crm_fuso(), 'DD/MM "às" HH24:MI'));
    v_id := v_reun.card_id;
  end if;

  -- remarcou: a mesma reunião muda de horário
  if p_evento = 'remarcada' and p_inicio is not null then
    update reunioes set agendada_para = p_inicio, externo_id = p_uid, cancelada = false,
                        titulo = coalesce(v_titulo, titulo), link = coalesce(v_link, link)
     where externo_id in (p_uid_anterior, p_uid) and realizada_em is null
     returning * into v_reun;
    if v_reun.id is not null then
      insert into atividades (card_id, autor_id, tipo, descricao)
      values (v_reun.card_id, null, 'agenda',
              'Remarcou a reunião para ' || to_char(p_inicio at time zone crm_fuso(), 'DD/MM "às" HH24:MI'));
      v_id := v_reun.card_id;
    end if;
  end if;

  -- marcou (ou remarcou uma reunião que o CRM não conhecia)
  if v_id is null and p_evento in ('criada', 'remarcada') then
    if p_inicio is null then raise exception 'agendamento sem data'; end if;
    if exists (select 1 from reunioes where externo_id = p_uid) then return null; end if;   -- já recebido

    select id into v_dono from perfis
     where ativo and lower(email) = lower(btrim(coalesce(p_organizador_email, ''))) limit 1;

    if v_email is not null then select * into v_card from cards where email = v_email for update; end if;
    if v_card.id is null and v_tel is not null then select * into v_card from cards where whatsapp = v_tel for update; end if;

    if v_card.id is null then
      if v_dono is null then
        select id into v_dono from perfis where ativo order by (papel = 'vendedor') desc, criado_em limit 1;
      end if;
      if v_dono is null then raise exception 'nenhum usuário ativo para receber o lead'; end if;
      select id into v_funil from funis where ativo order by padrao desc, criado_em limit 1;
      begin
        insert into cards (funil_id, etapa_id, nome, email, whatsapp, origem, anuncio, responsavel_id)
        values (v_funil, etapa_do_marco(v_funil, 'reuniao'),     -- já entra em "Reunião agendada"
                coalesce(v_nome, split_part(v_email, '@', 1), '+' || v_tel, 'Lead da agenda'),
                v_email, v_tel, 'agenda', v_titulo, v_dono)
        returning id into v_id;
        v_novo := true;
      exception when unique_violation then
        select id into v_id from cards where (v_email is not null and email = v_email)
                                          or (v_tel is not null and whatsapp = v_tel) limit 1;
      end;
    else
      v_id := v_card.id;
      update cards c
         set email    = coalesce(c.email, v_email),
             whatsapp = coalesce(c.whatsapp,
                          case when not exists (select 1 from cards x where x.whatsapp = v_tel) then v_tel end),
             nome     = case when c.nome like '+%' and v_nome is not null then v_nome else c.nome end
       where c.id = v_id;
    end if;

    insert into reunioes (card_id, agendada_para, responsavel_id, origem, externo_id, titulo, link, criado_por)
    values (v_id, p_inicio, coalesce(v_dono, (select responsavel_id from cards where id = v_id)),
            'agenda', left(p_uid, 200), v_titulo, v_link, null)
    on conflict (externo_id) where externo_id is not null do nothing
    returning * into v_reun;                       -- o gatilho leva o card para "Reunião agendada"
    if v_reun.id is null then return null; end if;

    insert into atividades (card_id, autor_id, tipo, descricao)
    values (v_id, null, 'agenda',
            left('Marcou reunião pela agenda' || coalesce(': ' || v_titulo, '') || ' · '
                 || to_char(p_inicio at time zone crm_fuso(), 'DD/MM "às" HH24:MI'), 2000));
  end if;

  if v_id is null then return null; end if;
  return (
    select jsonb_build_object(
      'acao', p_evento, 'card_novo', v_novo, 'card_id', c.id, 'nome', c.nome,
      'email', c.email, 'whatsapp', c.whatsapp, 'empresa', c.empresa, 'etapa', e.nome,
      'inicio', v_reun.agendada_para, 'titulo', v_reun.titulo, 'link', v_reun.link,
      'dono', (select nome from perfis where id = v_reun.responsavel_id))
    from cards c join etapas e on e.id = c.etapa_id where c.id = v_id);
end $$;

-- A busca automática (de hora em hora) prova quem é com um segredo guardado no Vault.
create or replace function public.conferir_segredo_sincronizacao(p_segredo text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = 'crm_sincronizacao' limit 1;
  return v is not null and p_segredo is not null and v = p_segredo;
exception when others then
  return false;
end $$;

-- =====================================================================
-- AUTOMAÇÃO DIÁRIA: 5 dias de follow-up sem resposta = Perdido
-- =====================================================================
create or replace function public.marcar_perdidos_sem_resposta() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update cards c
     set etapa_id = ep.id, motivo_perda = 'sem_resposta'
    from etapas e, etapas ep
   where e.id = c.etapa_id and e.marco in ('novo', 'contato_feito')
     and ep.funil_id = c.funil_id and ep.marco = 'perdido'
     and not c.arquivado
     and coalesce(c.ultima_resposta_em, '-infinity') < now() - interval '5 days'
     and (select max(f.agendado_para) from followups f where f.card_id = c.id)
         < now() - interval '12 hours';
  get diagnostics n = row_count;
  return n;
end $$;

-- 10h UTC = 07h em Brasília (06h em Cuiabá).
select cron.schedule('crm-perdidos-sem-resposta', '0 10 * * *',
                     $$select public.marcar_perdidos_sem_resposta()$$);

-- =====================================================================
-- NÚMEROS DO MÊS (respeita as regras de acesso: vendedor vê só os dele)
-- =====================================================================
drop function if exists public.numeros_do_mes(date, uuid);
create or replace function public.numeros_do_mes(
  p_mes date, p_responsavel uuid default null, p_funil uuid default null
) returns jsonb
language sql stable security invoker set search_path = public as $$
  with lim as (
    select date_trunc('month', p_mes::timestamp) at time zone crm_fuso() as ini,
           (date_trunc('month', p_mes::timestamp) + interval '1 month') at time zone crm_fuso() as fim
  ),
  c as (
    select cards.*, e.marco from cards join etapas e on e.id = cards.etapa_id
     where (p_responsavel is null or responsavel_id = p_responsavel)
       and (p_funil is null or cards.funil_id = p_funil)
  ),
  h as (
    select distinct hc.card_id, hc.marco_para
      from historico_card hc join c on c.id = hc.card_id, lim
     where hc.quando >= lim.ini and hc.quando < lim.fim and hc.marco_para is not null
  ),
  fechados as (select c.* from c, lim where c.marco = 'fechado' and c.fechado_em >= lim.ini and c.fechado_em < lim.fim),
  perdas   as (select c.* from c, lim where c.marco = 'perdido' and c.perdido_em >= lim.ini and c.perdido_em < lim.fim),
  novos    as (select c.* from c, lim where c.criado_em >= lim.ini and c.criado_em < lim.fim)
  select jsonb_build_object(
    'novos',       (select count(*) from novos),
    'contatados',  (select count(*) from h where marco_para = 'contato_feito'),
    -- virou quente no mês (conta mesmo se já avançou, ou se pulou direto para reunião/proposta/venda)
    'quentes',     (select count(*) from c, lim
                     where least(c.quente_em, c.reuniao_em, c.proposta_em, c.fechado_em) >= lim.ini
                       and least(c.quente_em, c.reuniao_em, c.proposta_em, c.fechado_em) < lim.fim),
    'propostas',   (select count(*) from h where marco_para = 'proposta'),
    'com_reuniao', (select count(*) from h where marco_para = 'reuniao'),
    'vendas',      (select count(*) from fechados),
    'faturamento', (select coalesce(sum(valor_venda), 0) from fechados),
    'perdidos',    (select count(*) from perdas),
    'perdidos_por_motivo',
      (select coalesce(jsonb_object_agg(motivo, n), '{}'::jsonb)
         from (select coalesce(motivo_perda, 'outro') motivo, count(*) n from perdas group by 1) x),
    'reunioes',
      (select count(*) from reunioes r join c on c.id = r.card_id, lim
        where r.realizada_em >= lim.ini and r.realizada_em < lim.fim),
    -- marcadas no mês (pela agenda ou pelo card), menos as canceladas
    'reunioes_agendadas',
      (select count(*) from reunioes r join c on c.id = r.card_id, lim
        where not r.cancelada and r.criado_em >= lim.ini and r.criado_em < lim.fim),
    'dias_ate_fechar',
      (select round(avg(extract(epoch from fechado_em - criado_em) / 86400)::numeric, 1) from fechados),
    'por_anuncio',
      (select coalesce(jsonb_agg(x order by x.leads desc), '[]'::jsonb)
         from (select coalesce(anuncio,
                        case origem when 'manual' then 'Cadastro manual'
                                    when 'whatsapp_direto' then 'WhatsApp direto'
                                    when 'agenda' then 'Agenda'
                                    else 'Anúncio sem nome' end) as anuncio,
                      count(*) as leads,
                      count(*) filter (where marco = 'fechado') as vendas
                 from novos group by 1) x),
    -- dinheiro na mesa AGORA (não depende do mês): valor de tudo que está aberto (nem fechou nem perdeu)
    'na_mesa',       (select coalesce(sum(valor_proposta), 0) from c
                       where not arquivado and valor_proposta > 0 and marco is distinct from 'fechado' and marco is distinct from 'perdido'),
    'na_mesa_cards', (select count(*) from c
                       where not arquivado and valor_proposta > 0 and marco is distinct from 'fechado' and marco is distinct from 'perdido'),
    'meta',        (select vendas from metas where mes = date_trunc('month', p_mes::timestamp)::date),
    'meta_faturamento',
                   (select faturamento from metas where mes = date_trunc('month', p_mes::timestamp)::date)
  )
$$;

-- =====================================================================
-- META DO MÊS CORRENTE (tela "Meta"): números do TIME inteiro contra a meta.
-- Devolve só contagens e somas (nenhum dado de lead). Sem meta no mês, vale a do último mês definido.
-- =====================================================================
-- (p_dia só existe para os testes da virada do mês; a tela chama sem nada = hoje)
drop function if exists public.progresso_do_mes();
create or replace function public.progresso_do_mes(p_dia date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_mes date := date_trunc('month', coalesce(p_dia, (now() at time zone crm_fuso())::date))::date;
  v_ini timestamptz := v_mes::timestamp at time zone crm_fuso();
  v_fim timestamptz := (v_mes + interval '1 month')::timestamp at time zone crm_fuso();
  m     metas;
begin
  if not eu_ativo() then raise exception 'acesso negado'; end if;
  select * into m from metas where mes <= v_mes order by mes desc limit 1;
  return jsonb_build_object(
    'mes', v_mes,
    'meta_de', m.mes,
    'feito', jsonb_build_object(
      'leads',   (select count(*) from cards where criado_em >= v_ini and criado_em < v_fim),
      'quentes', (select count(*) from cards
                   where least(quente_em, reuniao_em, proposta_em, fechado_em) >= v_ini
                     and least(quente_em, reuniao_em, proposta_em, fechado_em) < v_fim),
      'reunioes_agendadas',  (select count(*) from reunioes
                               where not cancelada and criado_em >= v_ini and criado_em < v_fim),
      'reunioes_realizadas', (select count(*) from reunioes
                               where realizada_em >= v_ini and realizada_em < v_fim),
      'vendas',      (select count(*) from cards where fechado_em >= v_ini and fechado_em < v_fim),
      'faturamento', (select coalesce(sum(valor_venda), 0) from cards
                       where fechado_em >= v_ini and fechado_em < v_fim)),
    'meta', jsonb_build_object(
      'leads', m.leads, 'quentes', m.quentes,
      'reunioes_agendadas', m.reunioes_agendadas, 'reunioes_realizadas', m.reunioes_realizadas,
      'vendas', m.vendas, 'faturamento', m.faturamento));
end $$;

-- =====================================================================
-- SINO: avisos calculados com o que já existe (respeita o RLS: cada um vê o que pode ver)
-- mensagem nova · card que mudou de etapa (feito por outra pessoa ou pela automação) · reunião do dia
-- "minha" = card (ou reunião) em que eu sou o responsável
-- =====================================================================
create or replace function public.meus_avisos() returns jsonb
language sql stable security invoker set search_path = public as $$
  with hoje as (
    select (now() at time zone crm_fuso())::date as d
  ),
  marca as (
    select coalesce((select lidos_ate from avisos_marca where perfil_id = auth.uid()),
                    now() - interval '7 days') as t
  ),
  ev as (
    select 'm:' || a.id as chave, 'mensagem' as tipo, a.criado_em as quando, a.card_id, c.nome,
           left(a.descricao, 140) as texto, c.responsavel_id = auth.uid() as minha
      from atividades a join cards c on c.id = a.card_id
     where a.tipo = 'mensagem_recebida' and a.criado_em > now() - interval '7 days'
    union all
    select 'h:' || h.id, 'etapa', h.quando, h.card_id, c.nome,
           coalesce(h.nome_de || ' → ' || h.nome_para, 'Novo card em ' || h.nome_para),
           c.responsavel_id = auth.uid()
      from historico_card h join cards c on c.id = h.card_id
     where h.quando > now() - interval '7 days' and h.por is distinct from auth.uid()
    union all
    select 'r:' || r.id || ':' || hoje.d, 'reuniao', r.agendada_para, r.card_id, c.nome,
           coalesce(r.titulo, 'Reunião') || ' às ' || to_char(r.agendada_para at time zone crm_fuso(), 'HH24:MI'),
           coalesce(r.responsavel_id, c.responsavel_id) = auth.uid()
      from reunioes r join cards c on c.id = r.card_id, hoje
     where not r.cancelada and r.realizada_em is null
       and (r.agendada_para at time zone crm_fuso())::date = hoje.d
  ),
  x as (
    select ev.*,
           exists (select 1 from avisos_lidos l where l.perfil_id = auth.uid() and l.chave = ev.chave)
           or (ev.tipo <> 'reuniao' and ev.quando <= marca.t) as lido
      from ev, marca
     order by (ev.tipo = 'reuniao') desc, ev.quando desc
     limit 80
  )
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from x
$$;

-- Checklist: só a própria pessoa lança, e só dos últimos 7 dias (dá para completar o dia de ontem).
create or replace function public.tg_checklist_dia() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_hoje date := (now() at time zone crm_fuso())::date;
begin
  if auth.uid() is not null then
    new.perfil_id := auth.uid();
    if new.dia > v_hoje or new.dia < v_hoje - 7 then
      raise exception 'Só dá para lançar os números de hoje e dos últimos 7 dias.';
    end if;
  end if;
  new.atualizado_em := now();
  return new;
end $$;

drop trigger if exists checklist_dia_antes on public.checklist_dia;
create trigger checklist_dia_antes before insert or update on public.checklist_dia
  for each row execute function public.tg_checklist_dia();

-- Meta do último dia útil: bati ou não? (para a janela de aviso; "já viu" = deu Ok)
drop function if exists public.checklist_ontem();
create or replace function public.checklist_ontem(p_hoje date default null) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_hoje date := coalesce(p_hoje, (now() at time zone crm_fuso())::date);
  v_dia  date;
  m      checklist_metas;
  d      checklist_dia;
  v_itens jsonb := '[]'::jsonb;
begin
  v_dia := v_hoje - case extract(isodow from v_hoje)::int when 1 then 3 when 7 then 2 else 1 end;  -- sexta, se hoje é fim de semana ou segunda
  select * into m from checklist_metas where perfil_id = auth.uid();
  if m.perfil_id is null then return null; end if;
  select * into d from checklist_dia where perfil_id = auth.uid() and dia = v_dia;

  if coalesce(m.conexoes, 0) > 0 then
    v_itens := v_itens || jsonb_build_object('item', 'conexoes', 'feito', coalesce(d.conexoes, 0), 'meta', m.conexoes); end if;
  if coalesce(m.mensagens, 0) > 0 then
    v_itens := v_itens || jsonb_build_object('item', 'mensagens', 'feito', coalesce(d.mensagens, 0), 'meta', m.mensagens); end if;
  if coalesce(m.followups, 0) > 0 then
    v_itens := v_itens || jsonb_build_object('item', 'followups', 'feito', coalesce(d.followups, 0), 'meta', m.followups); end if;
  if jsonb_array_length(v_itens) = 0 then return null; end if;

  return jsonb_build_object(
    'dia', v_dia,
    'preencheu', d.perfil_id is not null,
    'bateu', not exists (select 1 from jsonb_array_elements(v_itens) i where (i->>'feito')::int < (i->>'meta')::int),
    'ja_viu', exists (select 1 from avisos_lidos where perfil_id = auth.uid() and chave = 'checklist:' || v_dia),
    'itens', v_itens);
end $$;

-- Limpeza diária: "já li" com mais de 30 dias não serve para nada
-- (menos o "já vi o tour da versão X": esse fica, senão o tour voltaria depois de um mês)
select cron.schedule('crm-limpar-avisos', '30 10 * * *',
                     $$delete from public.avisos_lidos where lido_em < now() - interval '30 days' and chave not like 'tour:%'$$);

-- =====================================================================
-- REGRAS DE ACESSO (RLS) — ligadas em TODAS as tabelas
-- Só usuário logado e ATIVO lê e escreve. Anônimo não acessa nada.
-- =====================================================================
alter table public.perfis             enable row level security;
alter table public.funis              enable row level security;
alter table public.etapas             enable row level security;
alter table public.cards              enable row level security;
alter table public.historico_card     enable row level security;
alter table public.reunioes           enable row level security;
alter table public.atividades         enable row level security;
alter table public.followups          enable row level security;
alter table public.mensagens_whatsapp enable row level security;
alter table public.metas              enable row level security;
alter table public.envios_formulario  enable row level security;
alter table public.avisos_lidos       enable row level security;
alter table public.avisos_marca       enable row level security;
alter table public.checklist_metas    enable row level security;
alter table public.checklist_dia      enable row level security;

-- "já li": cada um só vê e grava o seu
drop policy if exists avisos_lidos_meus on public.avisos_lidos;
create policy avisos_lidos_meus on public.avisos_lidos for all to authenticated
  using (perfil_id = auth.uid() and eu_ativo()) with check (perfil_id = auth.uid() and eu_ativo());
drop policy if exists avisos_marca_minha on public.avisos_marca;
create policy avisos_marca_minha on public.avisos_marca for all to authenticated
  using (perfil_id = auth.uid() and eu_ativo()) with check (perfil_id = auth.uid() and eu_ativo());

-- metas do checklist: cada um vê a sua, o dono vê e define as de todos
drop policy if exists checklist_metas_ler on public.checklist_metas;
create policy checklist_metas_ler on public.checklist_metas for select to authenticated
  using (eu_ativo() and (perfil_id = auth.uid() or sou_dono()));
drop policy if exists checklist_metas_dono on public.checklist_metas;
create policy checklist_metas_dono on public.checklist_metas for all to authenticated
  using (sou_dono()) with check (sou_dono());

-- números do dia: cada um lança os seus; o dono vê os de todos
drop policy if exists checklist_dia_ler on public.checklist_dia;
create policy checklist_dia_ler on public.checklist_dia for select to authenticated
  using (eu_ativo() and (perfil_id = auth.uid() or sou_dono()));
drop policy if exists checklist_dia_lancar on public.checklist_dia;
create policy checklist_dia_lancar on public.checklist_dia for insert to authenticated
  with check (eu_ativo() and perfil_id = auth.uid());
drop policy if exists checklist_dia_corrigir on public.checklist_dia;
create policy checklist_dia_corrigir on public.checklist_dia for update to authenticated
  using (eu_ativo() and perfil_id = auth.uid()) with check (eu_ativo() and perfil_id = auth.uid());

-- envios do formulário (etiquetas): vê quem vê o card; só a automação grava
drop policy if exists envios_ler on public.envios_formulario;
create policy envios_ler on public.envios_formulario for select to authenticated
  using (exists (select 1 from cards c where c.id = card_id));

-- perfis: cada um vê o próprio; ativos veem a equipe; só o dono altera
drop policy if exists perfis_ler on public.perfis;
create policy perfis_ler on public.perfis for select to authenticated
  using (id = auth.uid() or eu_ativo());
drop policy if exists perfis_alterar on public.perfis;
create policy perfis_alterar on public.perfis for update to authenticated
  using (sou_dono()) with check (sou_dono());

-- funis e etapas: todos ativos veem; só o dono cria, altera e apaga
drop policy if exists funis_ler on public.funis;
create policy funis_ler on public.funis for select to authenticated using (eu_ativo());
drop policy if exists funis_dono on public.funis;
create policy funis_dono on public.funis for all to authenticated
  using (sou_dono()) with check (sou_dono());

drop policy if exists etapas_ler on public.etapas;
create policy etapas_ler on public.etapas for select to authenticated using (eu_ativo());
drop policy if exists etapas_dono on public.etapas;
create policy etapas_dono on public.etapas for all to authenticated
  using (sou_dono()) with check (sou_dono());

-- cards: vendedor só os dele; dono todos; apagar só o dono
drop policy if exists cards_ler on public.cards;
create policy cards_ler on public.cards for select to authenticated
  using (eu_ativo() and (sou_dono() or responsavel_id = auth.uid()));
drop policy if exists cards_criar on public.cards;
create policy cards_criar on public.cards for insert to authenticated
  with check (eu_ativo() and (sou_dono() or responsavel_id = auth.uid()));
drop policy if exists cards_alterar on public.cards;
create policy cards_alterar on public.cards for update to authenticated
  using (eu_ativo() and (sou_dono() or responsavel_id = auth.uid()))
  with check (eu_ativo() and (sou_dono() or responsavel_id = auth.uid()));
drop policy if exists cards_apagar on public.cards;
create policy cards_apagar on public.cards for delete to authenticated
  using (sou_dono());

-- histórico: só leitura (quem grava é o gatilho)
drop policy if exists historico_ler on public.historico_card;
create policy historico_ler on public.historico_card for select to authenticated
  using (exists (select 1 from cards c where c.id = card_id));

-- reuniões: quem vê o card vê, cria e atualiza; apaga quem criou ou o dono
drop policy if exists reunioes_ler on public.reunioes;
create policy reunioes_ler on public.reunioes for select to authenticated
  using (exists (select 1 from cards c where c.id = card_id));
drop policy if exists reunioes_criar on public.reunioes;
create policy reunioes_criar on public.reunioes for insert to authenticated
  with check (criado_por = auth.uid() and eu_ativo() and exists (select 1 from cards c where c.id = card_id));
drop policy if exists reunioes_alterar on public.reunioes;
create policy reunioes_alterar on public.reunioes for update to authenticated
  using (exists (select 1 from cards c where c.id = card_id))
  with check (exists (select 1 from cards c where c.id = card_id));
drop policy if exists reunioes_apagar on public.reunioes;
create policy reunioes_apagar on public.reunioes for delete to authenticated
  using (sou_dono() or (criado_por = auth.uid() and eu_ativo()));

-- atividades: vê e escreve quem vê o card; não se edita
drop policy if exists atividades_ler on public.atividades;
create policy atividades_ler on public.atividades for select to authenticated
  using (exists (select 1 from cards c where c.id = card_id));
-- (pela tela só os tipos que uma pessoa registra; mensagem, formulário e agenda só a automação cria)
drop policy if exists atividades_criar on public.atividades;
create policy atividades_criar on public.atividades for insert to authenticated
  with check (autor_id = auth.uid() and tipo in ('contato', 'proposta', 'venda', 'perda', 'nota')
              and eu_ativo() and exists (select 1 from cards c where c.id = card_id));

-- follow-ups: vê e marca quem vê o card
drop policy if exists followups_ler on public.followups;
create policy followups_ler on public.followups for select to authenticated
  using (exists (select 1 from cards c where c.id = card_id));
drop policy if exists followups_marcar on public.followups;
create policy followups_marcar on public.followups for update to authenticated
  using (exists (select 1 from cards c where c.id = card_id))
  with check (exists (select 1 from cards c where c.id = card_id));

-- mensagens brutas: só o dono lê; só a automação grava
drop policy if exists mensagens_ler on public.mensagens_whatsapp;
create policy mensagens_ler on public.mensagens_whatsapp for select to authenticated
  using (sou_dono());

-- metas: todos ativos leem; só o dono altera
drop policy if exists metas_ler on public.metas;
create policy metas_ler on public.metas for select to authenticated using (eu_ativo());
drop policy if exists metas_dono on public.metas;
create policy metas_dono on public.metas for all to authenticated
  using (sou_dono()) with check (sou_dono());

-- =====================================================================
-- PERMISSÕES: o visitante sem login (anon) não tem acesso a nada
-- =====================================================================
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon, public;
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon, public;

-- usuário logado: só o que cada tabela precisa (o RLS decide QUAIS linhas)
-- (projetos novos do Supabase não dão essas permissões automaticamente)
grant usage on schema public to authenticated, service_role;
grant select, update                 on public.perfis             to authenticated;
grant select, insert, update, delete on public.funis              to authenticated;
grant select, insert, update, delete on public.etapas             to authenticated;
grant select, insert, update, delete on public.cards              to authenticated;
grant select                         on public.historico_card     to authenticated;
grant select, insert, update, delete on public.reunioes           to authenticated;
grant select, insert                 on public.atividades         to authenticated;
grant select, update                 on public.followups          to authenticated;
grant select                         on public.mensagens_whatsapp to authenticated;
grant select, insert, update, delete on public.metas              to authenticated;
grant select                         on public.envios_formulario  to authenticated;
grant select, insert, update, delete on public.avisos_lidos       to authenticated;
grant select, insert, update         on public.avisos_marca       to authenticated;
grant select, insert, update, delete on public.checklist_metas    to authenticated;
grant select, insert, update         on public.checklist_dia      to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- funções que a tela pode usar
grant execute on function public.eu_ativo()                       to authenticated;
grant execute on function public.sou_dono()                       to authenticated;
grant execute on function public.marco_da_etapa(uuid)             to authenticated;
grant execute on function public.etapa_do_marco(uuid, public.marco_etapa) to authenticated;
grant execute on function public.numeros_do_mes(date, uuid, uuid) to authenticated;
grant execute on function public.progresso_do_mes(date)           to authenticated;
grant execute on function public.meus_avisos()                    to authenticated;
grant execute on function public.checklist_ontem(date)            to authenticated;
grant execute on function public.normalizar_telefone(text)        to authenticated;
grant execute on function public.crm_fuso()                       to authenticated;

-- funções internas: nem o usuário logado chama direto
revoke execute on function public.gerar_followups(uuid)                       from authenticated;
revoke execute on function public.registrar_contato_no_card(uuid, timestamptz) from authenticated;
revoke execute on function public.marcar_perdidos_sem_resposta()               from authenticated;
revoke execute on function public.processar_mensagem_whatsapp(text, text, text, text, text, jsonb, jsonb, timestamptz)
  from authenticated;
grant execute on function public.processar_mensagem_whatsapp(text, text, text, text, text, jsonb, jsonb, timestamptz)
  to service_role;
grant execute on function public.pontos_faturamento(text) to authenticated;
revoke execute on function public.calcular_pontuacao(uuid, text)  from authenticated;
revoke execute on function public.recalcular_pontuacao(uuid)      from authenticated;
revoke execute on function public.processar_envio_formulario(text, text, text, text, text, text, text, text, text, timestamptz, jsonb, text)
  from authenticated;
revoke execute on function public.conferir_segredo_sincronizacao(text) from authenticated;
grant execute on function public.processar_envio_formulario(text, text, text, text, text, text, text, text, text, timestamptz, jsonb, text)
  to service_role;
grant execute on function public.conferir_segredo_sincronizacao(text) to service_role;
revoke execute on function public.processar_agendamento(text, text, text, timestamptz, text, text, text, text, text, text, jsonb)
  from authenticated;
grant execute on function public.processar_agendamento(text, text, text, timestamptz, text, text, text, text, text, text, jsonb)
  to service_role;

-- =====================================================================
-- DADOS INICIAIS: o primeiro funil (cria as 6 etapas sozinho)
-- =====================================================================
insert into public.funis (nome, padrao)
select 'Comercial', true
where not exists (select 1 from public.funis);

-- funis que já existiam ganham a etapa "Reunião agendada", entre "Lead quente" e a seguinte
insert into public.etapas (funil_id, nome, ordem, marco)
select q.funil_id, 'Reunião agendada',
       q.ordem + greatest(1, (coalesce((select min(x.ordem) from public.etapas x
                                          where x.funil_id = q.funil_id and x.ordem > q.ordem), q.ordem + 10)
                              - q.ordem) / 2),
       'reuniao'
  from public.etapas q
 where q.marco = 'quente'
   and not exists (select 1 from public.etapas r where r.funil_id = q.funil_id and r.marco = 'reuniao');

-- calcula a pontuação dos cards que já existiam
update public.cards set pontuacao = pontuacao;

-- =====================================================================
-- TEMPO REAL: a tela se atualiza sozinha quando chega lead do WhatsApp
-- =====================================================================
do $$ begin
  alter publication supabase_realtime add table public.cards;
exception when duplicate_object or undefined_object then null; end $$;
