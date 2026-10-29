'use strict';
// CRM comercial — página única. Todo texto vindo do banco entra na tela como
// TEXTO (textContent), nunca como HTML: proteção contra XSS.

const CFG = window.CRM_CONFIG;

// Etapas "importantes" (marcos). Os nomes das etapas vêm do banco.
const EM_FOLLOWUP = ['novo', 'contato_feito'];
const ENCERRADOS = ['fechado', 'perdido'];
const MOTIVOS = {
  sem_resposta: 'Sem resposta', preco: 'Preço', comprou_outro: 'Comprou de outro',
  sem_interesse: 'Sem interesse', outro: 'Outro',
};
const TIPOS = {
  mensagem_recebida: '💬 Mensagem recebida', contato: '📞 Contato',
  proposta: '📄 Proposta', venda: '✅ Venda', perda: '✖ Perda', nota: '📝 Nota',
  formulario: '📥 Formulário', agenda: '📅 Agenda',
};
const NOME_MARCO = {
  novo: 'Novo lead', contato_feito: 'Contato feito', quente: 'Lead quente', reuniao: 'Reunião agendada',
  proposta: 'Proposta enviada', fechado: 'Fechado', perdido: 'Perdido',
};
// Faixas de faturamento (iguais às do formulário). De 60 mil para cima = lead quente.
const FAIXAS = ['até 30 mil', 'De 30 a 40 mil', 'De 40 a 60 mil', 'De 60 a 80 mil', 'De 80 a 100 mil',
  'De 100 a 150 mil', 'De 150 a 250 mil', 'Acima de 250 mil'];
const opcoesFaixa = atual => [['', '—'], ...FAIXAS.map(f => [f, f]),
  ...(atual && !FAIXAS.includes(atual) ? [[atual, atual]] : [])];

const SELECT_CARD ='*, followups(id,ciclo,numero,agendado_para,feito_em), envios_formulario(form_nome,enviado_em)';

// Etiquetas = materiais baixados pelo formulário (sem repetir)
const etiquetas = card => [...new Set((card.envios_formulario || []).map(e => e.form_nome))];

// Selo da pontuação: verde (70+), amarelo (40+), cinza
function seloPontos(card) {
  const p = card.pontuacao ?? 0;
  return el('span', { class: 'pontos ' + (p >= 70 ? 'alta' : p >= 40 ? 'media' : 'baixa'), title: 'Pontuação do lead (0 a 100)' }, `${p} pts`);
}

function nomeOrigem(card) {
  if (card.origem === 'whatsapp_anuncio') return `🤖 Anúncio: ${card.anuncio || 'sem nome'}`;
  if (card.origem === 'whatsapp_direto') return '🤖 WhatsApp direto';
  if (card.origem === 'formulario') return '📥 Formulário';
  if (card.origem === 'agenda') return '📅 Agenda';
  return 'Cadastro manual';
}

// O link do convite / "esqueci a senha" chega com #type=invite|recovery
const tipoLink = new URLSearchParams(location.hash.slice(1)).get('type');

const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

const S = {
  perfil: null,
  perfis: [],
  funis: [],
  etapas: [],
  cards: [],
  reunioes: [],       // reuniões agendadas e ainda não realizadas
  funilId: null,
  aba: 'hoje',
  busca: '',
  filtroResp: '',
  mes: mesAtual(),
  canal: null,
};
const app = document.getElementById('app');

// ---------------------------------------------------------------- utilidades

function el(tag, props, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) {
    if (f == null || f === false) continue;
    n.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return n;
}

function opcoes(lista, atual) {
  return lista.map(([v, t]) => {
    const o = el('option', { value: v }, t);
    if (String(v) === String(atual ?? '')) o.selected = true;
    return o;
  });
}

const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dinheiro = v => moeda.format(Number(v) || 0);
const dataHora = d => new Date(d).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function ha(d) {
  if (!d) return '';
  const min = Math.round((Date.now() - new Date(d)) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

function mesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fimDeHoje() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

// "2026-10-27T14:30" (campo datetime-local) no horário do navegador
function paraCampoData(d) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 16);
}

// Para a busca: minúsculas e sem acento ("João" acha "joao")
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function bateBusca(card, termo) {
  const t = semAcento(termo).trim();
  if (!t) return true;
  const digitos = t.replace(/\D/g, '');
  return [card.nome, card.email, card.cargo, card.empresa, ...etiquetas(card)].some(v => semAcento(v).includes(t)) ||
    (digitos.length >= 3 && (card.whatsapp || '').includes(digitos));
}

function linkWhats(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  return d ? `https://wa.me/${d}` : null;
}

function linkInsta(user) {
  const u = String(user || '').replace(/[^A-Za-z0-9._]/g, '');
  return u ? `https://instagram.com/${u}` : null;
}

function btnWhats(tel, texto = 'WhatsApp') {
  const href = linkWhats(tel);
  return href ? el('a', { class: 'btn wa peq', href, target: '_blank', rel: 'noopener noreferrer' }, texto) : null;
}

let toastTimer;
function toast(msg, erro = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'mostra' + (erro ? ' erro' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, erro ? 5000 : 2500);
}

function traduzErro(e) {
  const m = e?.message || String(e);
  if (e?.code === '23505') return 'Esse WhatsApp ou e-mail já está cadastrado (talvez com outro responsável).';
  if (e?.code === '23503' && /etapas/.test(m)) return 'Ainda há cards nessa etapa. Mova-os antes de apagar.';
  if (/cards_email_check/.test(m)) return 'E-mail inválido.';
  if (e?.code === '42501' || /row-level security/.test(m)) return 'Você não tem permissão para isso.';
  if (/Invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
  if (/Password should be/i.test(m)) return 'Senha fraca: use pelo menos 10 caracteres.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Sem conexão. Tente de novo.';
  return m;
}

// Executa uma chamada do Supabase; mostra o erro e interrompe se falhar.
async function q(promessa) {
  const { data, error, count } = await promessa;
  if (error) { toast(traduzErro(error), true); throw error; }
  return count != null && data == null ? count : data;
}

const nomePerfil = id => S.perfis.find(p => p.id === id)?.nome || '—';
const souDono = () => S.perfil?.papel === 'dono';

// ---- funis e etapas
const etapaDe = id => S.etapas.find(e => e.id === id);
const nomeEtapa = id => etapaDe(id)?.nome || '—';
const marco = card => etapaDe(card.etapa_id)?.marco || null;
const etapasDoFunil = fid => S.etapas.filter(e => e.funil_id === fid).sort((a, b) => a.ordem - b.ordem);
const etapaDoMarco = (fid, m) => S.etapas.find(e => e.funil_id === fid && e.marco === m);
const aberto = card => !ENCERRADOS.includes(marco(card));

// Follow-ups do ciclo atual do card
function fupsDoCard(card) {
  const todos = card.followups || [];
  const ciclo = Math.max(0, ...todos.map(f => f.ciclo));
  return todos.filter(f => f.ciclo === ciclo).sort((a, b) => a.numero - b.numero);
}

function estaEsperando(card) {
  return aberto(card) && card.ultima_resposta_em &&
    (!card.ultimo_contato_em || new Date(card.ultima_resposta_em) > new Date(card.ultimo_contato_em));
}

function fupAtrasado(card) {
  if (!EM_FOLLOWUP.includes(marco(card))) return false;
  return fupsDoCard(card).some(f => !f.feito_em && new Date(f.agendado_para) < new Date());
}

// ---------------------------------------------------------------- modais

function abrirModal(conteudo, peq = false, aoFechar = null) {
  const fundo = el('div', { class: 'fundo-modal' });
  const caixa = el('div', { class: 'modal' + (peq ? ' peq' : ''), role: 'dialog', 'aria-modal': 'true' });
  caixa.append(conteudo);
  fundo.append(caixa);
  const fechar = () => {
    fundo.remove();
    document.removeEventListener('keydown', esc);
    if (aoFechar) aoFechar();
  };
  const esc = e => { if (e.key === 'Escape' && fundo === document.querySelector('.fundo-modal:last-of-type')) fechar(); };
  fundo.addEventListener('mousedown', e => { if (e.target === fundo) fechar(); });
  document.addEventListener('keydown', esc);
  document.body.append(fundo);
  return { fundo, caixa, fechar };
}

// Pequeno formulário. Resolve com os valores ou null se cancelar.
function pedir(titulo, campos, textoOk = 'Salvar') {
  return new Promise(resolve => {
    let pronto = false;
    const form = el('form', {});
    const m = abrirModal(form, true, () => sair(null));
    function sair(v) { if (pronto) return; pronto = true; m.fechar(); resolve(v); }
    form.append(el('div', { class: 'modal-topo' },
      el('h2', {}, titulo),
      el('button', { type: 'button', class: 'fechar', 'aria-label': 'Fechar', onclick: () => sair(null) }, '×')));
    for (const c of campos) {
      let input;
      if (c.tipo === 'select') {
        input = el('select', { name: c.nome, required: c.obrigatorio }, opcoes(c.opcoes, c.valor));
      } else if (c.tipo === 'textarea') {
        input = el('textarea', { name: c.nome, maxlength: 2000, required: c.obrigatorio });
        input.value = c.valor || '';
      } else {
        input = el('input', {
          name: c.nome, type: c.tipo || 'text', value: c.valor ?? '', required: c.obrigatorio,
          maxlength: c.max, step: c.tipo === 'number' ? '0.01' : null, min: c.tipo === 'number' ? '0' : null,
          inputmode: c.tipo === 'number' ? 'decimal' : c.tipo === 'tel' ? 'tel' : null,
          placeholder: c.dica, autocomplete: 'off',
        });
      }
      form.append(el('div', { class: 'campo' }, el('label', {}, c.rotulo), input));
    }
    form.append(el('div', { class: 'acoes' },
      el('button', { class: 'btn prim', type: 'submit' }, textoOk),
      el('button', { class: 'btn', type: 'button', onclick: () => sair(null) }, 'Cancelar')));
    form.addEventListener('submit', e => {
      e.preventDefault();
      sair(Object.fromEntries(new FormData(form)));
    });
    setTimeout(() => form.querySelector('input,select,textarea')?.focus(), 30);
  });
}

function confirmar(texto) {
  return pedir(texto, [], 'Confirmar').then(r => r !== null);
}

// ---------------------------------------------------------------- login

function telaLogin(msg) {
  const form = el('form', { class: 'login' },
    el('h1', {}, '📈 CRM Comercial'),
    msg ? el('p', { class: 'mudo' }, msg) : null,
    el('div', { class: 'campo' }, el('label', { for: 'email' }, 'E-mail'),
      el('input', { id: 'email', name: 'email', type: 'email', required: true, autocomplete: 'username' })),
    el('div', { class: 'campo' }, el('label', { for: 'senha' }, 'Senha'),
      el('input', { id: 'senha', name: 'senha', type: 'password', required: true, autocomplete: 'current-password' })),
    el('button', { class: 'btn prim', type: 'submit' }, 'Entrar'),
    el('button', { class: 'link', type: 'button', onclick: esqueci }, 'Esqueci a senha'));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const b = form.querySelector('.btn.prim');
    b.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: form.email.value.trim(), password: form.senha.value });
    b.disabled = false;
    if (error) return toast(traduzErro(error), true);
    entrar();
  });
  app.replaceChildren(form);

  async function esqueci() {
    const email = form.email.value.trim();
    if (!email) { toast('Digite seu e-mail primeiro.', true); return form.email.focus(); }
    await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    // Mensagem igual exista ou não o e-mail (não revela quem tem conta)
    toast('Se o e-mail estiver cadastrado, você vai receber um link.');
  }
}

function telaNovaSenha() {
  const form = el('form', { class: 'login' },
    el('h1', {}, 'Defina sua senha'),
    el('p', { class: 'mudo' }, 'Mínimo de 10 caracteres.'),
    el('div', { class: 'campo' }, el('label', { for: 's1' }, 'Nova senha'),
      el('input', { id: 's1', type: 'password', minlength: 10, required: true, autocomplete: 'new-password' })),
    el('div', { class: 'campo' }, el('label', { for: 's2' }, 'Repita a senha'),
      el('input', { id: 's2', type: 'password', minlength: 10, required: true, autocomplete: 'new-password' })),
    el('button', { class: 'btn prim', type: 'submit' }, 'Salvar senha'));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const [s1, s2] = [form.s1.value, form.s2.value];
    if (s1 !== s2) return toast('As senhas não são iguais.', true);
    const { error } = await sb.auth.updateUser({ password: s1 });
    if (error) return toast(traduzErro(error), true);
    toast('Senha salva!');
    entrar();
  });
  app.replaceChildren(form);
}

async function sair() {
  if (S.canal) await sb.removeChannel(S.canal);
  S.canal = null;
  await sb.auth.signOut();
  telaLogin();
}

// ---------------------------------------------------------------- entrada

async function entrar() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return telaLogin();
  const { data: perfil } = await sb.from('perfis').select('*').eq('id', user.id).maybeSingle();
  if (!perfil || !perfil.ativo) {
    app.replaceChildren(el('div', { class: 'login' },
      el('h1', {}, 'Acesso ainda não liberado'),
      el('p', { class: 'mudo' }, 'Peça ao dono do CRM para ativar seu usuário.'),
      el('button', { class: 'btn', onclick: sair }, 'Sair')));
    return;
  }
  S.perfil = perfil;
  S.perfis = await q(sb.from('perfis').select('id,nome,papel,ativo').order('nome'));
  await carregarFunis();
  montarCasca();
  await carregarCards();
  render();
  assinarTempoReal();
  carregarAvisos();
  setInterval(carregarAvisos, 60000);
  // primeiro o tour das novidades; se a pessoa usou o "me leva lá", o aviso do checklist fica para a próxima entrada
  if (!(await mostrarTour())) avisoChecklist();
}

async function carregarFunis() {
  const [funis, etapas] = await Promise.all([
    q(sb.from('funis').select('*').order('padrao', { ascending: false }).order('criado_em')),
    q(sb.from('etapas').select('*').order('ordem')),
  ]);
  S.funis = funis;
  S.etapas = etapas;
  const ativos = funis.filter(f => f.ativo);
  if (!ativos.some(f => f.id === S.funilId)) S.funilId = (ativos[0] || funis[0])?.id || null;
}

function montarCasca() {
  const abas = [['hoje', 'Hoje'], ['meta', 'Meta'], ['checklist', 'Checklist'], ['funil', 'Funil'], ['painel', 'Painel']];
  if (souDono()) abas.push(['config', 'Configurações']);
  app.replaceChildren(
    el('header', { class: 'topo' },
      el('h1', {}, '📈 CRM'),
      el('nav', { class: 'abas' }, abas.map(([id, t]) =>
        el('button', { class: 'aba', 'data-aba': id, onclick: () => { S.aba = id; render(); } }, t))),
      montarSino(),
      el('span', { class: 'quem' }, `${S.perfil.nome} · ${souDono() ? 'dono' : 'vendedor'}`),
      el('button', { class: 'btn peq', onclick: sair }, 'Sair')),
    el('main', { id: 'conteudo' }));
}

// Cards em aberto + encerrados nos últimos 45 dias, e reuniões pendentes.
async function carregarCards() {
  const corte = new Date(Date.now() - 45 * 864e5).toISOString();
  const [cards, reunioes] = await Promise.all([
    q(sb.from('cards').select(SELECT_CARD)
      .eq('arquivado', false)
      .or(`and(fechado_em.is.null,perdido_em.is.null),atualizado_em.gte."${corte}"`)
      .order('criado_em', { ascending: false })
      .limit(2000)),
    q(sb.from('reunioes').select('*, cards(nome,whatsapp,responsavel_id)')
      .is('realizada_em', null).eq('cancelada', false)
      .order('agendada_para').limit(500)),
  ]);
  S.cards = cards;
  S.reunioes = reunioes;
}

let recargaTimer;
function agendarRecarga() {
  clearTimeout(recargaTimer);
  recargaTimer = setTimeout(async () => {
    await carregarCards();
    if (S.aba !== 'painel' && S.aba !== 'config' && S.aba !== 'checklist') render();
    carregarAvisos();
  }, 800);
}

function assinarTempoReal() {
  if (S.canal) return;
  S.canal = sb.channel('crm-cards')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, agendarRecarga)
    .subscribe();
  window.addEventListener('focus', agendarRecarga);
}

function render() {
  document.querySelectorAll('.aba').forEach(b => b.classList.toggle('ativa', b.dataset.aba === S.aba));
  const main = document.getElementById('conteudo');
  if (!main) return;
  const telas = { hoje: telaHoje, meta: telaMeta, checklist: telaChecklist, funil: telaFunil, painel: telaPainel, config: telaConfig };
  (telas[S.aba] || telaHoje)(main);
}

async function atualizarTudo() {
  await carregarCards();
  render();
}

// ---------------------------------------------------------------- ações

async function registrarAtividade(card, tipo, descricao, valor) {
  await q(sb.from('atividades').insert({ card_id: card.id, tipo, descricao: descricao || null, valor: valor ?? null }));
}

// "Registrei um contato": marca o próximo follow-up vencido; se não houver, só registra.
async function registrarContato(card) {
  const pendente = EM_FOLLOWUP.includes(marco(card)) &&
    fupsDoCard(card).find(f => !f.feito_em && new Date(f.agendado_para) <= fimDeHoje());
  if (pendente) await q(sb.from('followups').update({ feito_em: new Date().toISOString() }).eq('id', pendente.id));
  else await registrarAtividade(card, 'contato', 'Contato registrado');
  toast('Contato registrado ✓');
}

const num = v => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));

async function moverEtapa(card, etapaId) {
  if (!etapaId || etapaId === card.etapa_id) return false;
  const m = etapaDe(etapaId)?.marco;
  const mudanca = { etapa_id: etapaId };
  let atv = null;
  if (m === 'proposta') {
    const r = await pedir(nomeEtapa(etapaId), [{ nome: 'valor', rotulo: 'Valor da proposta (R$)', tipo: 'number', valor: card.valor_proposta, obrigatorio: true }]);
    if (!r) return false;
    mudanca.valor_proposta = num(r.valor);
    atv = ['proposta', 'Proposta enviada', mudanca.valor_proposta];
  } else if (m === 'fechado') {
    const r = await pedir('Venda fechada 🎉', [{ nome: 'valor', rotulo: 'Valor da venda (R$) — entrega fechada e pagamento feito', tipo: 'number', valor: card.valor_venda ?? card.valor_proposta, obrigatorio: true }]);
    if (!r) return false;
    mudanca.valor_venda = num(r.valor);
    atv = ['venda', 'Venda fechada', mudanca.valor_venda];
  } else if (m === 'perdido') {
    const r = await pedir('Marcar como perdido', [
      { nome: 'motivo', rotulo: 'Motivo', tipo: 'select', opcoes: Object.entries(MOTIVOS), valor: 'sem_interesse' },
      { nome: 'obs', rotulo: 'Observação (opcional)', tipo: 'textarea' },
    ]);
    if (!r) return false;
    mudanca.motivo_perda = r.motivo;
    atv = ['perda', [MOTIVOS[r.motivo], r.obs].filter(Boolean).join(' — '), null];
  }
  if (!(await atualizarComTrava(card, mudanca))) return false;
  if (atv) await registrarAtividade(card, ...atv);
  toast(`Movido para ${nomeEtapa(etapaId)}`);
  await atualizarTudo();
  return true;
}

// Grava só se o card não mudou desde que esta tela o carregou. Assim, quem está com a
// tela desatualizada não desfaz o que outra pessoa (ou a automação) acabou de fazer.
async function atualizarComTrava(card, mudanca) {
  const feito = await q(sb.from('cards').update(mudanca)
    .eq('id', card.id).eq('atualizado_em', card.atualizado_em).select('id'));
  if (feito.length) return true;
  toast('Este card acabou de ser alterado por outra pessoa ou pela automação. Atualizei a tela: confira e faça de novo.', true);
  await atualizarTudo();
  return false;
}

// Leva o card para outro funil, na etapa equivalente (mesma etapa ⭐) ou na primeira.
async function moverDeFunil(card, funilId) {
  if (!funilId || funilId === card.funil_id) return false;
  const destino = etapaDoMarco(funilId, marco(card)) || etapasDoFunil(funilId)[0];
  if (!destino) { toast('Esse funil não tem etapas.', true); return false; }
  if (!(await atualizarComTrava(card, { funil_id: funilId, etapa_id: destino.id }))) return false;
  toast(`Movido para o funil ${S.funis.find(f => f.id === funilId)?.nome} · ${destino.nome}`);
  await atualizarTudo();
  return true;
}

// Move para a etapa importante (marco) do funil do card.
function moverParaMarco(card, m) {
  const etapa = etapaDoMarco(card.funil_id, m);
  if (!etapa) { toast(`Este funil não tem a etapa "${NOME_MARCO[m]}".`, true); return Promise.resolve(false); }
  return moverEtapa(card, etapa.id);
}

async function novoCard() {
  const campos = [
    { nome: 'nome', rotulo: 'Nome', obrigatorio: true, max: 120 },
    { nome: 'whatsapp', rotulo: 'WhatsApp (com DDD)', tipo: 'tel', dica: '(66) 99999-9999', max: 20 },
    { nome: 'email', rotulo: 'E-mail (opcional)', tipo: 'email', max: 120 },
    { nome: 'empresa', rotulo: 'Empresa (opcional)', max: 120 },
    { nome: 'faturamento', rotulo: 'Faturamento (opcional)', tipo: 'select', opcoes: opcoesFaixa(''), valor: '' },
    { nome: 'cargo', rotulo: 'Cargo (opcional)', max: 80 },
    { nome: 'instagram', rotulo: '@ do Instagram (opcional)', max: 60 },
  ];
  const funisAtivos = S.funis.filter(f => f.ativo);
  if (funisAtivos.length > 1) {
    campos.push({ nome: 'funil_id', rotulo: 'Funil', tipo: 'select', opcoes: funisAtivos.map(f => [f.id, f.nome]), valor: S.funilId });
  }
  if (souDono()) {
    campos.push({ nome: 'responsavel_id', rotulo: 'Responsável', tipo: 'select',
      opcoes: S.perfis.filter(p => p.ativo).map(p => [p.id, p.nome]), valor: S.perfil.id });
  }
  const r = await pedir('Novo lead', campos, 'Criar');
  if (!r) return;
  const novo = {
    nome: r.nome.trim(), whatsapp: r.whatsapp || null, email: r.email || null, cargo: r.cargo || null,
    empresa: r.empresa || null, faturamento: r.faturamento || null,
    instagram: r.instagram || null, funil_id: r.funil_id || S.funilId,
  };
  if (r.responsavel_id) novo.responsavel_id = r.responsavel_id;
  const criado = await q(sb.from('cards').insert(novo).select('id').single());
  toast('Lead criado ✓');
  await atualizarTudo();
  abrirCard(criado.id);
}

async function novaReuniao(card) {
  const r = await pedir('Reunião', [
    { nome: 'quando', rotulo: 'Data e hora', tipo: 'datetime-local', valor: paraCampoData(new Date()), obrigatorio: true },
    { nome: 'situacao', rotulo: 'Situação', tipo: 'select', opcoes: [['realizada', 'Já aconteceu (realizada)'], ['agendada', 'Vai acontecer (agendar)']], valor: 'realizada' },
    { nome: 'resumo', rotulo: 'Resumo (opcional)', tipo: 'textarea' },
  ]);
  if (!r) return false;
  const quando = new Date(r.quando);
  if (r.situacao === 'realizada' && quando > new Date()) { toast('Reunião realizada não pode ter data no futuro.', true); return false; }
  await q(sb.from('reunioes').insert({
    card_id: card.id,
    agendada_para: quando.toISOString(),
    realizada_em: r.situacao === 'realizada' ? quando.toISOString() : null,
    resumo: r.resumo || null,
  }));
  if (r.situacao === 'realizada') toast('Reunião registrada ✓');
  else comemorar();
  return true;
}

// Reunião agendada pelo card: confete e uma frase curta. Comercial vive de pequena vitória.
const FRASES = [
  'Reunião marcada! Bora fechar 🚀', 'Mais uma na agenda! 🎯', 'Isso! Um passo mais perto da venda 💪',
  'Agenda cheia é venda chegando 📈', 'Boa! Agora é preparar e brilhar ✨', 'Reunião no bolso! 🔥',
];
function comemorar() {
  const frase = el('div', { class: 'vitoria', role: 'status' }, FRASES[Math.floor(Math.random() * FRASES.length)]);
  document.body.append(frase);
  setTimeout(() => frase.remove(), 2600);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const tela = el('canvas', { class: 'confete', 'aria-hidden': 'true' });
  document.body.append(tela);
  const ctx = tela.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  tela.width = innerWidth * dpr; tela.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const cores = ['#3222AA', '#6c5ce7', '#00b894', '#fdcb6e', '#e17055', '#0984e3'];
  const pedacos = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 4,
    giro: Math.random() * 6, vg: (Math.random() - 0.5) * 0.4,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, cor: cores[Math.floor(Math.random() * cores.length)],
  }));
  const inicio = performance.now();
  (function quadro(agora) {
    const t = agora - inicio;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - 1800) / 700);
    for (const p of pedacos) {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.giro += p.vg;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.giro);
      ctx.fillStyle = p.cor; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.cos(p.giro * 2));
      ctx.restore();
    }
    if (t < 2500) requestAnimationFrame(quadro); else tela.remove();
  })(inicio);
}

async function concluirReuniao(reuniao) {
  const r = await pedir('Reunião realizada', [{ nome: 'resumo', rotulo: 'Como foi? (opcional)', tipo: 'textarea', valor: reuniao.resumo }]);
  if (!r) return false;
  const quando = new Date(reuniao.agendada_para) < new Date() ? reuniao.agendada_para : new Date().toISOString();
  await q(sb.from('reunioes').update({ realizada_em: quando, resumo: r.resumo || null }).eq('id', reuniao.id));
  toast('Reunião realizada ✓');
  return true;
}

// ---------------------------------------------------------------- tela: Hoje

function telaHoje(main) {
  const esperando = S.cards.filter(estaEsperando)
    .sort((a, b) => new Date(a.ultima_resposta_em) - new Date(b.ultima_resposta_em));

  const fim = fimDeHoje();
  const agora = new Date();
  const reunioesHoje = S.reunioes.filter(r => new Date(r.agendada_para) <= fim);
  const fups = [];
  for (const c of S.cards) {
    if (!EM_FOLLOWUP.includes(marco(c)) || estaEsperando(c)) continue;
    const prox = fupsDoCard(c).find(f => !f.feito_em);
    if (prox && new Date(prox.agendado_para) <= fim) fups.push({ card: c, f: prox });
  }
  fups.sort((a, b) => new Date(a.f.agendado_para) - new Date(b.f.agendado_para));
  const acoes = S.cards.filter(c => aberto(c) && c.proxima_acao && c.proxima_acao_em && new Date(c.proxima_acao_em) <= fim)
    .sort((a, b) => new Date(a.proxima_acao_em) - new Date(b.proxima_acao_em));

  main.replaceChildren(
    el('section', { class: 'secao' },
      el('h3', {}, `Responderam e estão esperando você (${esperando.length})`),
      esperando.length ? esperando.map(c => el('div', { class: 'item esperando' },
        el('div', { class: 'info', onclick: () => abrirCard(c.id) },
          el('div', { class: 'nome' }, c.nome),
          el('div', { class: 'mudo' }, `${nomeEtapa(c.etapa_id)} · mandou mensagem ${ha(c.ultima_resposta_em)}`,
            souDono() ? ` · ${nomePerfil(c.responsavel_id)}` : '')),
        btnWhats(c.whatsapp, 'Responder'),
        el('button', { class: 'btn ok peq', onclick: async () => { await registrarContato(c); agendarRecarga(); } }, '✓ Respondi')))
        : el('p', { class: 'vazio' }, 'Ninguém esperando resposta. 👌')),
    el('section', { class: 'secao' },
      el('h3', {}, `Reuniões de hoje e atrasadas (${reunioesHoje.length})`),
      reunioesHoje.length ? reunioesHoje.map(r => {
        const atrasada = new Date(r.agendada_para) < agora;
        return el('div', { class: 'item' + (atrasada ? ' atrasado' : '') },
          el('div', { class: 'info', onclick: () => abrirCard(r.card_id) },
            el('div', { class: 'nome' }, r.cards?.nome || '—'),
            el('div', { class: 'mudo' }, `🤝 ${dataHora(r.agendada_para)}`, souDono() && r.cards ? ` · ${nomePerfil(r.cards.responsavel_id)}` : '')),
          btnWhats(r.cards?.whatsapp),
          el('button', { class: 'btn ok peq', onclick: async () => { if (await concluirReuniao(r)) await atualizarTudo(); } }, '✓ Realizada'));
      }) : el('p', { class: 'vazio' }, 'Nenhuma reunião para hoje.')),
    el('section', { class: 'secao' },
      el('h3', {}, `Próximas ações de hoje e atrasadas (${acoes.length})`),
      acoes.length ? acoes.map(c => {
        const atrasada = new Date(c.proxima_acao_em) < agora;
        return el('div', { class: 'item' + (atrasada ? ' atrasado' : '') },
          el('div', { class: 'info', onclick: () => abrirCard(c.id) },
            el('div', { class: 'nome' }, c.nome),
            el('div', { class: 'mudo' }, `⏭ ${c.proxima_acao} · ${atrasada ? 'atrasada, era ' : ''}${dataHora(c.proxima_acao_em)}`,
              souDono() ? ` · ${nomePerfil(c.responsavel_id)}` : '')),
          btnWhats(c.whatsapp),
          el('button', { class: 'btn peq', onclick: () => abrirCard(c.id) }, 'Abrir'));
      }) : el('p', { class: 'vazio' }, 'Nenhuma ação marcada para hoje.')),
    el('section', { class: 'secao' },
      el('h3', {}, `Follow-ups de hoje e atrasados (${fups.length})`),
      fups.length ? fups.map(({ card: c, f }) => {
        const atrasado = new Date(f.agendado_para) < agora;
        return el('div', { class: 'item' + (atrasado ? ' atrasado' : '') },
          el('div', { class: 'info', onclick: () => abrirCard(c.id) },
            el('div', { class: 'nome' }, c.nome),
            el('div', { class: 'mudo' }, `Contato ${f.numero}/10 · ${atrasado ? 'atrasado, era ' : ''}${dataHora(f.agendado_para)}`,
              souDono() ? ` · ${nomePerfil(c.responsavel_id)}` : '')),
          btnWhats(c.whatsapp),
          el('button', { class: 'btn ok peq', onclick: async e => {
            e.currentTarget.disabled = true;
            await q(sb.from('followups').update({ feito_em: new Date().toISOString() }).eq('id', f.id));
            toast(`Follow-up ${f.numero}/10 feito ✓`);
            await atualizarTudo();
          } }, '✓ Feito'));
      }) : el('p', { class: 'vazio' }, 'Nenhum follow-up pendente hoje.')),
    el('div', { class: 'linha' }, el('button', { class: 'btn prim', onclick: novoCard }, '+ Novo lead')));
}

// ---------------------------------------------------------------- tela: Funil

function telaFunil(main) {
  const barra = el('div', { class: 'barra-funil' });
  const funisAtivos = S.funis.filter(f => f.ativo);
  if (funisAtivos.length > 1) {
    const selFunil = el('select', { 'aria-label': 'Funil' }, opcoes(funisAtivos.map(f => [f.id, f.nome]), S.funilId));
    selFunil.addEventListener('change', () => { S.funilId = selFunil.value; desenharColunas(); });
    barra.append(selFunil);
  }
  const busca = el('input', { type: 'search', placeholder: 'Buscar nome, e-mail, telefone ou cargo…', value: S.busca });
  busca.addEventListener('input', () => { S.busca = busca.value; desenharColunas(); });
  barra.append(busca);
  if (souDono()) {
    const filtro = el('select', { 'aria-label': 'Responsável' },
      opcoes([['', 'Todos os responsáveis'], ...S.perfis.map(p => [p.id, p.nome])], S.filtroResp));
    filtro.addEventListener('change', () => { S.filtroResp = filtro.value; desenharColunas(); });
    barra.append(filtro);
  }
  barra.append(el('button', { class: 'btn prim', onclick: novoCard }, '+ Novo lead'));
  const funil = el('div', { class: 'funil' });
  main.replaceChildren(barra, funil);
  desenharColunas();

  function desenharColunas() {
    const lista = S.cards.filter(c =>
      c.funil_id === S.funilId &&
      (!S.filtroResp || c.responsavel_id === S.filtroResp) &&
      bateBusca(c, S.busca));

    const etapas = etapasDoFunil(S.funilId);
    if (!etapas.length) { funil.replaceChildren(el('p', { class: 'vazio' }, 'Este funil não tem etapas.')); return; }
    funil.replaceChildren(...etapas.map(et => {
      // dentro da coluna, os de maior pontuação primeiro
      const daqui = lista.filter(c => c.etapa_id === et.id)
        .sort((a, b) => (b.pontuacao ?? 0) - (a.pontuacao ?? 0) || new Date(b.criado_em) - new Date(a.criado_em));
      // fechado: soma das vendas · etapas abertas: soma do valor na mesa (proposta mostra mesmo zerada)
      const mesa = daqui.reduce((s, c) => s + Number(c.valor_proposta || 0), 0);
      const soma = et.marco === 'fechado' ? daqui.reduce((s, c) => s + Number(c.valor_venda || 0), 0)
        : et.marco === 'perdido' ? null
        : et.marco === 'proposta' || mesa ? mesa : null;
      const col = el('div', { class: 'coluna', 'data-etapa': et.id },
        el('div', { class: 'coluna-topo' },
          el('strong', {}, `${et.nome} (${daqui.length})`),
          soma != null ? el('span', {}, dinheiro(soma)) : null),
        daqui.length ? daqui.map(cartao) : el('p', { class: 'mudo' }, '—'));
      col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('sobre'); });
      col.addEventListener('dragleave', () => col.classList.remove('sobre'));
      col.addEventListener('drop', e => {
        e.preventDefault();
        col.classList.remove('sobre');
        const card = S.cards.find(c => c.id === e.dataTransfer.getData('text/plain'));
        if (card) moverEtapa(card, et.id);
      });
      return col;
    }));
  }

  function cartao(c) {
    const fups = fupsDoCard(c);
    const feitos = fups.filter(f => f.feito_em).length;
    const m = marco(c);
    const desde = [c.ultimo_contato_em, c.ultima_resposta_em, c.criado_em].filter(Boolean)
      .map(d => new Date(d)).sort((a, b) => b - a)[0];
    const div = el('div', { class: 'card', draggable: 'true', onclick: () => abrirCard(c.id) },
      estaEsperando(c) ? el('span', { class: 'bolinha aviso', title: 'Respondeu e está esperando' })
        : fupAtrasado(c) ? el('span', { class: 'bolinha', title: 'Follow-up atrasado' }) : null,
      el('div', { class: 'nome' }, c.nome),
      [c.empresa, c.faturamento, c.cargo].some(Boolean)
        ? el('div', { class: 'mudo' }, [c.empresa, c.faturamento, c.cargo].filter(Boolean).join(' · ')) : null,
      c.proxima_acao ? el('div', { class: 'prox' + (c.proxima_acao_em && new Date(c.proxima_acao_em) < new Date() ? ' atrasada' : '') },
        `⏭ ${c.proxima_acao}${c.proxima_acao_em ? ` · ${dataHora(c.proxima_acao_em)}` : ''}`) : null,
      el('div', { class: 'meta' },
        seloPontos(c),
        c.origem.startsWith('whatsapp') ? el('span', { class: 'selo', title: 'Entrou pelo WhatsApp' }, '🤖 WhatsApp') : null,
        etiquetas(c).map(t => el('span', { class: 'etiqueta', title: 'Material baixado' }, t)),
        EM_FOLLOWUP.includes(m) && fups.length ? el('span', {}, `follow-up ${feitos}/10`) : null,
        aberto(c) && c.valor_proposta ? el('span', { class: 'na-mesa', title: 'Valor na mesa' }, `💰 ${dinheiro(c.valor_proposta)}`) : null,
        m === 'fechado' && c.valor_venda ? el('span', {}, dinheiro(c.valor_venda)) : null,
        m === 'perdido' && c.motivo_perda ? el('span', {}, MOTIVOS[c.motivo_perda]) : null,
        el('span', {}, `parado ${ha(desde).replace('há ', '')}`),
        souDono() ? el('span', {}, nomePerfil(c.responsavel_id)) : null));
    div.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', c.id));
    return div;
  }
}

// ---------------------------------------------------------------- card do lead

async function abrirCard(id) {
  const corpo = el('div', {}, el('p', { class: 'mudo' }, 'Carregando…'));
  const m = abrirModal(corpo);
  await preencher();

  async function recarregar() {
    await atualizarTudo();
    await preencher();
  }

  async function preencher() {
    const [card, atividades, historico, reunioes] = await Promise.all([
      q(sb.from('cards').select(SELECT_CARD).eq('id', id).maybeSingle()),
      q(sb.from('atividades').select('*').eq('card_id', id).order('criado_em', { ascending: false }).limit(200)),
      q(sb.from('historico_card').select('*').eq('card_id', id).order('quando', { ascending: false }).limit(100)),
      q(sb.from('reunioes').select('*').eq('card_id', id).order('agendada_para', { ascending: false }).limit(50)),
    ]);
    if (!card) { m.fechar(); return toast('Card não encontrado.', true); }
    const mc = marco(card);

    // Dados
    const fNome = el('input', { value: card.nome, maxlength: 120, required: true });
    const fTel = el('input', { value: card.whatsapp || '', type: 'tel', inputmode: 'tel', maxlength: 20 });
    const fInsta = el('input', { value: card.instagram || '', maxlength: 60 });
    const fEmail = el('input', { value: card.email || '', type: 'email', maxlength: 120 });
    const fCargo = el('input', { value: card.cargo || '', maxlength: 80 });
    const fEmpresa = el('input', { value: card.empresa || '', maxlength: 120 });
    const fFat = el('select', {}, opcoes(opcoesFaixa(card.faturamento), card.faturamento || ''));
    const salvarDados = el('button', { class: 'btn peq', onclick: async () => {
      if (!fNome.value.trim()) return toast('O nome é obrigatório.', true);
      const ok = await atualizarComTrava(card, {
        nome: fNome.value.trim(), whatsapp: fTel.value || null, instagram: fInsta.value || null,
        email: fEmail.value.trim() || null, cargo: fCargo.value.trim() || null,
        empresa: fEmpresa.value.trim() || null, faturamento: fFat.value || null,
      });
      if (ok) toast('Dados salvos ✓');
      await recarregar();
    } }, 'Salvar dados');

    // Próxima ação
    const fAcao = el('input', { value: card.proxima_acao || '', maxlength: 200, placeholder: 'Ex.: Ligar para confirmar o orçamento' });
    const fAcaoEm = el('input', { type: 'datetime-local', value: card.proxima_acao_em ? paraCampoData(card.proxima_acao_em) : '' });
    const salvarAcao = el('button', { class: 'btn prim peq', onclick: async () => {
      if (!fAcao.value.trim()) return toast('Descreva a próxima ação.', true);
      if (!fAcaoEm.value) return toast('Escolha a data da próxima ação.', true);
      await q(sb.from('cards').update({ proxima_acao: fAcao.value.trim(), proxima_acao_em: new Date(fAcaoEm.value).toISOString() }).eq('id', id));
      toast('Próxima ação salva ✓'); await recarregar();
    } }, 'Salvar');
    const concluirAcao = card.proxima_acao ? el('button', { class: 'btn ok peq', onclick: async () => {
      await registrarAtividade(card, 'nota', `Ação concluída: ${card.proxima_acao}`);
      await q(sb.from('cards').update({ proxima_acao: null, proxima_acao_em: null }).eq('id', id));
      toast('Ação concluída ✓'); await recarregar();
    } }, '✓ Concluída') : null;
    const acaoAtrasada = card.proxima_acao_em && new Date(card.proxima_acao_em) < new Date();

    // Valor na mesa: o valor da negociação, em qualquer etapa aberta (não muda a etapa)
    const fMesa = el('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: card.valor_proposta ?? '', placeholder: 'Ex.: 4000' });
    const salvarMesa = el('button', { class: 'btn prim peq', onclick: async () => {
      const v = num(fMesa.value);
      if (v == null || v <= 0) return toast('Informe um valor maior que zero.', true);
      await q(sb.from('cards').update({ valor_proposta: v }).eq('id', id));
      await registrarAtividade(card, 'nota', `Valor na mesa: ${dinheiro(v)}`);
      toast('Valor na mesa salvo ✓'); await recarregar();
    } }, 'Salvar');
    const tirarMesa = card.valor_proposta != null ? el('button', { class: 'btn peq', onclick: async () => {
      await q(sb.from('cards').update({ valor_proposta: null }).eq('id', id));
      await registrarAtividade(card, 'nota', 'Valor tirado da mesa');
      toast('Valor tirado da mesa'); await recarregar();
    } }, 'Tirar da mesa') : null;

    // Etapa e responsável
    const selEtapa = el('select', {}, opcoes(etapasDoFunil(card.funil_id).map(e => [e.id, e.nome]), card.etapa_id));
    selEtapa.addEventListener('change', async () => {
      await moverEtapa(card, selEtapa.value);
      await preencher();                              // movido ou recusado: mostra o card como está agora
    });
    const funisAtivos = S.funis.filter(f => f.ativo || f.id === card.funil_id);
    let selFunil = null;
    if (funisAtivos.length > 1) {
      selFunil = el('select', {}, opcoes(funisAtivos.map(f => [f.id, f.nome]), card.funil_id));
      selFunil.addEventListener('change', async () => { await moverDeFunil(card, selFunil.value); await preencher(); });
    }
    let selResp = null;
    if (souDono()) {
      selResp = el('select', {}, opcoes(S.perfis.filter(p => p.ativo || p.id === card.responsavel_id).map(p => [p.id, p.nome]), card.responsavel_id));
      selResp.addEventListener('change', async () => {
        await q(sb.from('cards').update({ responsavel_id: selResp.value }).eq('id', id));
        toast('Responsável alterado ✓'); await recarregar();
      });
    }

    // Follow-ups
    const fups = fupsDoCard(card);
    const agora = new Date();
    const listaFups = el('ul', { class: 'fups' }, fups.map(f => {
      const cx = el('input', { type: 'checkbox' });
      cx.checked = !!f.feito_em;
      cx.addEventListener('change', async () => {
        await q(sb.from('followups').update({ feito_em: cx.checked ? new Date().toISOString() : null }).eq('id', f.id));
        await recarregar();
      });
      const atrasado = !f.feito_em && new Date(f.agendado_para) < agora && EM_FOLLOWUP.includes(mc);
      return el('li', {}, el('label', { class: atrasado ? 'atrasado' : null }, cx, `${f.numero}. ${dataHora(f.agendado_para)}`));
    }));

    // Reuniões
    const listaReunioes = el('ul', { class: 'tempo' }, reunioes.map(r => el('li', {},
      el('div', {}, el('strong', {},
        r.cancelada ? '🚫 Cancelada' : r.realizada_em ? '✅ Realizada' : '🕒 Agendada', ` · ${dataHora(r.realizada_em || r.agendada_para)}`)),
      el('div', { class: 'mudo' }, [
        r.titulo, r.origem === 'agenda' ? '📅 pela agenda' : null,
        r.responsavel_id ? `dono: ${nomePerfil(r.responsavel_id)}` : null,
      ].filter(Boolean).join(' · ')),
      r.link && !r.cancelada && !r.realizada_em
        ? el('a', { class: 'btn peq', href: r.link, target: '_blank', rel: 'noopener noreferrer' }, '🎥 Entrar na reunião') : null,
      r.resumo ? el('div', { class: 'txt' }, r.resumo) : null,
      !r.realizada_em && !r.cancelada ? el('div', { class: 'acoes' },
        el('button', { class: 'btn ok peq', onclick: async () => { if (await concluirReuniao(r)) await recarregar(); } }, '✓ Realizada'),
        el('button', { class: 'btn peq', onclick: async () => {
          await q(sb.from('reunioes').update({ cancelada: true }).eq('id', r.id));
          toast('Reunião cancelada'); await recarregar();
        } }, 'Cancelar')) : null)));

    // Nota
    const nota = el('textarea', { maxlength: 2000, placeholder: 'Escreva uma anotação…' });
    const salvarNota = el('button', { class: 'btn peq', onclick: async () => {
      if (!nota.value.trim()) return;
      await registrarAtividade(card, 'nota', nota.value.trim());
      toast('Nota salva ✓'); await preencher();
    } }, 'Salvar nota');

    // Linha do tempo: atividades + histórico de etapas
    const eventos = [
      ...atividades.map(a => ({
        quando: a.criado_em,
        titulo: TIPOS[a.tipo] + (a.valor != null ? ` · ${dinheiro(a.valor)}` : ''),
        quem: a.autor_id ? nomePerfil(a.autor_id) : 'automação',
        texto: a.descricao,
      })),
      ...historico.map(h => ({
        quando: h.quando,
        titulo: h.nome_de ? `➡ ${h.nome_de} → ${h.nome_para}` : `✨ Lead criado em ${h.nome_para}`,
        quem: h.por ? nomePerfil(h.por) : 'automação',
        texto: null,
      })),
    ].sort((a, b) => new Date(b.quando) - new Date(a.quando));

    const origem = nomeOrigem(card);
    const motivos = Array.isArray(card.pontuacao_motivos) ? card.pontuacao_motivos : [];
    const tags = etiquetas(card);
    const funil = S.funis.find(f => f.id === card.funil_id);

    corpo.replaceChildren(...[
      el('div', { class: 'modal-topo' },
        el('h2', {}, card.nome),
        el('button', { class: 'fechar', 'aria-label': 'Fechar', onclick: m.fechar }, '×')),
      el('div', { class: 'linha' },
        btnWhats(card.whatsapp, 'Abrir WhatsApp'),
        card.email ? el('a', { class: 'btn peq', href: `mailto:${encodeURIComponent(card.email).replace('%40', '@')}` }, card.email) : null,
        card.empresa ? el('span', { class: 'selo' }, `🏢 ${card.empresa}`) : null,
        card.faturamento ? el('span', { class: 'selo' }, `💰 ${card.faturamento}`) : null,
        card.cargo ? el('span', { class: 'selo' }, card.cargo) : null,
        linkInsta(card.instagram) ? el('a', { class: 'btn peq', href: linkInsta(card.instagram), target: '_blank', rel: 'noopener noreferrer' }, `@${card.instagram}`) : null,
        el('span', { class: 'selo' }, origem),
        S.funis.length > 1 && funil ? el('span', { class: 'selo' }, `Funil: ${funil.nome}`) : null,
        el('span', { class: 'mudo' }, `criado ${ha(card.criado_em)} · nesta etapa ${ha(card.entrou_etapa_em)}`)),

      el('div', { class: 'bloco' },
        el('div', { class: 'grade2' },
          selFunil ? el('div', { class: 'campo' }, el('label', {}, 'Funil'), selFunil) : null,
          el('div', { class: 'campo' }, el('label', {}, 'Etapa'), selEtapa),
          el('div', { class: 'campo' }, el('label', {}, 'Responsável'), selResp || el('input', { value: nomePerfil(card.responsavel_id), disabled: true }))),
        el('div', { class: 'acoes' },
          el('button', { class: 'btn', onclick: async () => { await registrarContato(card); await recarregar(); } }, '📞 Registrar contato'),
          el('button', { class: 'btn', onclick: async () => { if (await novaReuniao(card)) await recarregar(); } }, '🤝 Reunião'),
          el('button', { class: 'btn', onclick: async () => { if (await enviarProposta(card)) await preencher(); } }, '📄 Enviei proposta'),
          el('button', { class: 'btn ok', onclick: async () => { if (await moverParaMarco(card, 'fechado')) await preencher(); } }, '✅ Fechou'),
          el('button', { class: 'btn perigo', onclick: async () => { if (await moverParaMarco(card, 'perdido')) await preencher(); } }, '✖ Perdido'))),

      aberto(card) ? el('div', { class: 'bloco' },
        el('h3', {}, '💰 Valor na mesa'),
        el('p', { class: 'mudo' }, 'Quanto vale esta negociação, mesmo sem proposta formal. Entra no "Na mesa agora" do Painel até fechar ou ser perdido.'),
        el('div', { class: 'linha' }, el('div', { class: 'cresce' }, fMesa), salvarMesa, tirarMesa)) : null,

      el('div', { class: 'bloco' },
        el('h3', {}, 'Pontuação ', seloPontos(card)),
        el('ul', { class: 'motivos' }, motivos.map(x => el('li', { class: x.pontos ? null : 'zero' },
          el('b', {}, `+${x.pontos}`), el('span', { class: 'mudo' }, ` / ${x.max}`), ` ${x.motivo}`))),
        tags.length ? el('div', { class: 'linha' }, el('span', { class: 'mudo' }, 'Materiais:'),
          tags.map(t => el('span', { class: 'etiqueta' }, t))) : null),

      el('div', { class: 'bloco' },
        el('h3', {}, 'Próxima ação', acaoAtrasada ? el('span', { class: 'selo alerta' }, 'atrasada') : null),
        el('div', { class: 'grade2' },
          el('div', { class: 'campo' }, el('label', {}, 'O que fazer'), fAcao),
          el('div', { class: 'campo' }, el('label', {}, 'Quando'), fAcaoEm)),
        el('div', { class: 'acoes' }, salvarAcao, concluirAcao)),

      fups.length ? el('div', { class: 'bloco' },
        el('h3', {}, `Follow-up ${fups.filter(f => f.feito_em).length}/10`),
        !EM_FOLLOWUP.includes(mc) ? el('p', { class: 'mudo' }, 'O follow-up automático só vale para Novo lead e Contato feito.') : null,
        listaFups) : null,

      reunioes.length ? el('div', { class: 'bloco' }, el('h3', {}, 'Reuniões'), listaReunioes) : null,

      el('div', { class: 'bloco' },
        el('h3', {}, 'Anotação'), nota, el('div', { class: 'acoes' }, salvarNota)),

      el('div', { class: 'bloco' },
        el('h3', {}, 'Histórico'),
        el('ul', { class: 'tempo' }, eventos.map(ev => el('li', {},
          el('div', {}, el('strong', {}, ev.titulo)),
          ev.texto ? el('div', { class: 'txt' }, ev.texto) : null,
          el('div', { class: 'quando' }, `${dataHora(ev.quando)} · ${ev.quem}`))))),

      el('div', { class: 'bloco' },
        el('h3', {}, 'Dados'),
        el('div', { class: 'campo' }, el('label', {}, 'Nome'), fNome),
        el('div', { class: 'grade2' },
          el('div', { class: 'campo' }, el('label', {}, 'WhatsApp'), fTel),
          el('div', { class: 'campo' }, el('label', {}, 'E-mail'), fEmail),
          el('div', { class: 'campo' }, el('label', {}, 'Empresa'), fEmpresa),
          el('div', { class: 'campo' }, el('label', {}, 'Faturamento'), fFat),
          el('div', { class: 'campo' }, el('label', {}, 'Cargo'), fCargo),
          el('div', { class: 'campo' }, el('label', {}, 'Instagram'), fInsta)),
        el('div', { class: 'acoes' }, salvarDados,
          souDono() ? el('button', { class: 'btn peq', onclick: async () => {
            if (!(await confirmar('Arquivar este lead? Ele some do funil.'))) return;
            await q(sb.from('cards').update({ arquivado: true }).eq('id', id));
            toast('Lead arquivado'); m.fechar(); await atualizarTudo();
          } }, 'Arquivar') : null,
          souDono() ? el('button', { class: 'btn peq perigo', onclick: async () => {
            if (!(await confirmar('Apagar DEFINITIVAMENTE este lead e todo o histórico? (pedido do cliente / LGPD)'))) return;
            await q(sb.from('cards').delete().eq('id', id));
            toast('Lead apagado'); m.fechar(); await atualizarTudo();
          } }, 'Apagar definitivamente') : null)),
    ].filter(Boolean));
  }
}

// "Enviei proposta": move para a etapa de proposta; se já estiver lá, só atualiza o valor.
async function enviarProposta(card) {
  if (marco(card) !== 'proposta') return moverParaMarco(card, 'proposta');
  const r = await pedir('Atualizar proposta', [{ nome: 'valor', rotulo: 'Novo valor (R$)', tipo: 'number', valor: card.valor_proposta, obrigatorio: true }]);
  if (!r) return false;
  await q(sb.from('cards').update({ valor_proposta: num(r.valor) }).eq('id', card.id));
  await registrarAtividade(card, 'proposta', 'Proposta atualizada', num(r.valor));
  await atualizarTudo();
  return true;
}

// ---------------------------------------------------------------- tela: Painel

function diasUteisRestantes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const ini = new Date(a, m - 1, 1);
  const fim = new Date(a, m, 0);
  let n = 0;
  for (const d = new Date(hoje > ini ? hoje : ini); d <= fim; d.setDate(d.getDate() + 1)) if (d.getDay() % 6 !== 0) n++;
  return n;
}

async function telaPainel(main) {
  // sem mês escolhido à mão, o Painel acompanha o mês corrente (mesmo com a página aberta na virada)
  if (!S.mesEscolhido) S.mes = mesAtual();
  const selMes = el('input', { type: 'month', value: S.mes, 'aria-label': 'Mês' });
  selMes.addEventListener('change', () => { if (selMes.value) { S.mes = selMes.value; S.mesEscolhido = S.mes !== mesAtual(); render(); } });
  const exportar = el('button', { class: 'btn', onclick: exportarCSV }, '⬇ Exportar CSV (backup)');
  const area = el('div', {}, el('p', { class: 'mudo' }, 'Calculando…'));
  main.replaceChildren(el('div', { class: 'barra-funil' }, selMes, exportar), area);

  const n = await q(sb.rpc('numeros_do_mes', { p_mes: `${S.mes}-01` }));
  if (S.aba !== 'painel') return;
  const meta = n.meta || 0;
  const falta = Math.max(0, meta - n.vendas);
  const dias = diasUteisRestantes(S.mes);
  const pct = meta ? Math.min(100, Math.round((n.vendas / meta) * 100)) : 0;
  const conv = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

  const trilho = el('div', {});
  trilho.style.width = `${pct}%`;

  // Faturamento contra a meta de faturamento (se definida)
  const metaFat = Number(n.meta_faturamento) || 0;
  const pctFat = metaFat ? Math.min(100, Math.round((Number(n.faturamento) / metaFat) * 100)) : 0;
  const trilhoFat = el('div', {});
  trilhoFat.style.width = `${pctFat}%`;
  const faltaFat = Math.max(0, metaFat - Number(n.faturamento));

  const blocos = [
    el('div', { class: 'meta-box na-mesa-box' },
      el('div', { class: 'meta-rotulo' }, '💰 Na mesa agora'),
      el('div', { class: 'meta-num' }, dinheiro(n.na_mesa ?? 0), ' ',
        el('small', {}, `${n.na_mesa_cards ?? 0} negociaç${n.na_mesa_cards === 1 ? 'ão' : 'ões'} em aberto`)),
      el('div', { class: 'mudo' }, 'Soma do valor de tudo que ainda não fechou nem foi perdido. Não depende do mês.')),
    el('div', { class: 'metas-grade' },
      el('div', { class: 'meta-box' },
        el('div', { class: 'meta-rotulo' }, 'Vendas'),
        el('div', { class: 'meta-num' }, `${n.vendas} `, el('small', {}, meta ? `de ${meta}` : '(sem meta)')),
        el('div', { class: 'trilho' }, trilho),
        el('div', { class: 'mudo' }, meta
          ? (falta ? `Faltam ${falta} · ${dias} dias úteis · ${dias ? (falta / dias).toFixed(1) : falta} por dia útil`
            : 'Meta batida! 🎉')
          : souDono() ? 'Defina a meta em Configurações.' : 'O dono ainda não definiu a meta deste mês.')),
      el('div', { class: 'meta-box' },
        el('div', { class: 'meta-rotulo' }, 'Faturamento'),
        el('div', { class: 'meta-num' }, dinheiro(n.faturamento), ' ', el('small', {}, metaFat ? `de ${dinheiro(metaFat)}` : '(sem meta)')),
        el('div', { class: 'trilho' }, trilhoFat),
        el('div', { class: 'mudo' }, metaFat
          ? (faltaFat ? `Faltam ${dinheiro(faltaFat)} · ${pctFat}% da meta` : 'Meta de faturamento batida! 🎉')
          : souDono() ? 'Defina a meta de faturamento em Configurações (opcional).' : 'Sem meta de faturamento neste mês.'))),
    el('div', { class: 'numeros' }, [
      ['Leads novos', n.novos], ['Ficaram quentes', n.quentes],
      ['Reuniões agendadas', n.reunioes_agendadas], ['Reuniões realizadas', n.reunioes],
      ['Propostas', n.propostas], ['Vendas', n.vendas], ['Faturamento', dinheiro(n.faturamento)],
      ['Perdidos', n.perdidos], ['Dias até fechar', n.dias_ate_fechar ?? '—'],
    ].map(([t, v]) => el('div', { class: 'num' }, el('b', {}, String(v)), el('span', {}, t)))),
    el('h3', {}, 'Conversão no mês'),
    el('div', { class: 'tabela-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Passo'), el('th', { class: 'n' }, 'Taxa'))),
      el('tbody', {},
        el('tr', {}, el('td', {}, 'Novo → Quente'), el('td', { class: 'n' }, conv(n.quentes, n.novos))),
        el('tr', {}, el('td', {}, 'Quente → Reunião'), el('td', { class: 'n' }, conv(n.com_reuniao ?? 0, n.quentes))),
        el('tr', {}, el('td', {}, 'Reunião → Proposta'), el('td', { class: 'n' }, conv(n.propostas, n.com_reuniao ?? 0))),
        el('tr', {}, el('td', {}, 'Proposta → Venda'), el('td', { class: 'n' }, conv(n.vendas, n.propostas))),
        el('tr', {}, el('td', {}, 'Novo → Venda'), el('td', { class: 'n' }, conv(n.vendas, n.novos)))))),
  ];

  const motivos = Object.entries(n.perdidos_por_motivo || {});
  if (motivos.length) {
    blocos.push(el('h3', {}, 'Perdidos por motivo'), el('div', { class: 'tabela-wrap' }, el('table', {},
      el('tbody', {}, motivos.map(([k, v]) => el('tr', {}, el('td', {}, MOTIVOS[k] || k), el('td', { class: 'n' }, String(v))))))));
  }

  blocos.push(el('h3', {}, 'De onde vieram os leads do mês'), el('div', { class: 'tabela-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Anúncio / origem'), el('th', { class: 'n' }, 'Leads'), el('th', { class: 'n' }, 'Vendas'))),
    el('tbody', {}, n.por_anuncio.length
      ? n.por_anuncio.map(a => el('tr', {}, el('td', {}, a.anuncio), el('td', { class: 'n' }, String(a.leads)), el('td', { class: 'n' }, String(a.vendas))))
      : el('tr', {}, el('td', { colspan: '3', class: 'mudo' }, 'Nenhum lead novo neste mês.'))))));

  if (souDono()) {
    const equipe = S.perfis.filter(p => p.ativo);
    const porPessoa = await Promise.all(equipe.map(p => q(sb.rpc('numeros_do_mes', { p_mes: `${S.mes}-01`, p_responsavel: p.id }))));
    if (S.aba !== 'painel') return;
    blocos.push(el('h3', {}, 'Por pessoa'), el('div', { class: 'tabela-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Quem', 'Novos', 'Quentes', 'Reun. agend.', 'Reun. realiz.', 'Propostas', 'Vendas', 'Faturamento', 'Na mesa'].map((t, i) => el('th', { class: i ? 'n' : null }, t)))),
      el('tbody', {}, equipe.map((p, i) => {
        const x = porPessoa[i];
        return el('tr', {}, el('td', {}, p.nome),
          [x.novos, x.quentes, x.reunioes_agendadas, x.reunioes, x.propostas, x.vendas, dinheiro(x.faturamento), dinheiro(x.na_mesa ?? 0)].map(v => el('td', { class: 'n' }, String(v))));
      })))));
  }
  area.replaceChildren(...blocos);
}

// Planilha com todos os cards que você pode ver (backup).
async function exportarCSV() {
  const todos = [];
  for (let de = 0; ; de += 1000) {
    const pag = await q(sb.from('cards').select('*').order('criado_em').range(de, de + 999));
    todos.push(...pag);
    if (pag.length < 1000) break;
  }
  const colunas = ['nome', 'whatsapp', 'email', 'empresa', 'faturamento', 'pontuacao', 'cargo', 'instagram', 'proxima_acao', 'proxima_acao_em', 'origem', 'anuncio', 'funil', 'etapa', 'responsavel', 'valor_proposta',
    'valor_venda', 'motivo_perda', 'criado_em', 'contato_em', 'quente_em', 'proposta_em', 'fechado_em', 'perdido_em', 'arquivado'];
  // Evita "injeção de fórmula" ao abrir no Excel (células que começam com = + - @)
  const cel = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const valor = (c, col) => col === 'responsavel' ? nomePerfil(c.responsavel_id)
    : col === 'etapa' ? nomeEtapa(c.etapa_id)
    : col === 'funil' ? (S.funis.find(f => f.id === c.funil_id)?.nome || '')
    : c[col];
  const linhas = [colunas.join(';'), ...todos.map(c => colunas.map(col => cel(valor(c, col))).join(';'))];
  const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `crm-cards-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${todos.length} cards exportados ✓`);
}

// ---------------------------------------------------------------- sino de avisos

// Os avisos são calculados pelo banco (mensagem nova, card que mudou de etapa, reunião do dia).
// O banco guarda só o que cada um já leu.
const ICONE_AVISO = { mensagem: '💬', etapa: '➡', reuniao: '🤝' };
S.avisos = [];
S.abaSino = 'minhas';

function montarSino() {
  const contador = el('span', { class: 'sino-num', hidden: true });
  const lista = el('div', { class: 'sino-lista' });
  const painel = el('div', { class: 'sino-painel', hidden: true, role: 'dialog', 'aria-label': 'Avisos' });
  const botao = el('button', { class: 'btn peq sino', 'aria-label': 'Avisos', 'aria-expanded': 'false', onclick: e => {
    e.stopPropagation();
    painel.hidden = !painel.hidden;
    botao.setAttribute('aria-expanded', String(!painel.hidden));
    if (!painel.hidden) desenharAvisos();
  } }, '🔔', contador);
  painel.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => { painel.hidden = true; botao.setAttribute('aria-expanded', 'false'); });

  const abaSino = (id, t) => el('button', { class: 'aba', 'data-sino': id, onclick: () => { S.abaSino = id; desenharAvisos(); } }, t);
  painel.append(
    el('div', { class: 'sino-topo' },
      el('div', { class: 'sino-abas' }, abaSino('minhas', 'Minhas'), abaSino('geral', 'Geral')),
      el('button', { class: 'link', onclick: marcarTodosLidos }, 'Marcar todos como lidos')),
    lista);

  S.sino = { contador, lista, painel };
  return el('div', { class: 'sino-wrap' }, botao, painel);
}

async function carregarAvisos() {
  if (!S.sino) return;
  const { data, error } = await sb.rpc('meus_avisos');
  if (error) return;                               // aviso não é crítico: tenta de novo no próximo minuto
  S.avisos = data || [];
  const naoLidos = S.avisos.filter(a => !a.lido).length;
  S.sino.contador.hidden = !naoLidos;
  S.sino.contador.textContent = naoLidos > 99 ? '99+' : String(naoLidos);
  if (!S.sino.painel.hidden) desenharAvisos();
}

function desenharAvisos() {
  const { lista, painel } = S.sino;
  painel.querySelectorAll('[data-sino]').forEach(b => {
    const n = S.avisos.filter(a => !a.lido && (b.dataset.sino === 'geral' || a.minha)).length;
    b.classList.toggle('ativa', b.dataset.sino === S.abaSino);
    b.textContent = `${b.dataset.sino === 'geral' ? 'Geral' : 'Minhas'}${n ? ` (${n})` : ''}`;
  });
  const itens = S.avisos.filter(a => S.abaSino === 'geral' || a.minha);
  lista.replaceChildren(...(itens.length ? itens.map(a => el('button', {
    class: 'sino-item' + (a.lido ? ' lido' : ''),
    onclick: async () => {
      if (!a.lido) await sb.from('avisos_lidos').upsert({ perfil_id: S.perfil.id, chave: a.chave }, { onConflict: 'perfil_id,chave' });
      painel.hidden = true;
      abrirCard(a.card_id);
      carregarAvisos();
    } },
    el('span', { class: 'sino-icone', 'aria-hidden': 'true' }, ICONE_AVISO[a.tipo] || '•'),
    el('span', { class: 'sino-txt' },
      el('strong', {}, a.nome),
      el('span', {}, a.texto || ''),
      el('small', { class: 'mudo' }, a.tipo === 'reuniao' ? 'reunião de hoje' : ha(a.quando))))) : [
    el('p', { class: 'mudo sino-vazio' }, S.abaSino === 'minhas' ? 'Nada de novo nos seus cards.' : 'Nada de novo.')]));
}

async function marcarTodosLidos() {
  const reunioes = S.avisos.filter(a => a.tipo === 'reuniao' && !a.lido).map(a => ({ perfil_id: S.perfil.id, chave: a.chave }));
  await q(sb.from('avisos_marca').upsert({ perfil_id: S.perfil.id, lidos_ate: new Date().toISOString() }, { onConflict: 'perfil_id' }));
  if (reunioes.length) await q(sb.from('avisos_lidos').upsert(reunioes, { onConflict: 'perfil_id,chave' }));
  await carregarAvisos();
}

// ---------------------------------------------------------------- tour das novidades

// Conteúdo e versão ficam em novidades.js. Fechou = viu (guardado no banco, por pessoa).
// Resolve true se a pessoa usou o "me leva lá".
async function mostrarTour() {
  const N = window.CRM_NOVIDADES;
  const passos = (N?.PASSOS || []).filter(p => !p.soDono || souDono());
  if (!N?.VERSAO || !passos.length) return false;
  const chave = `tour:${N.VERSAO}`.slice(0, 120);
  const { data: visto, error } = await sb.from('avisos_lidos').select('chave').eq('chave', chave).maybeSingle();
  if (error || visto) return false;

  return new Promise(resolve => {
    let i = 0;
    const fundo = el('div', { class: 'fundo-modal tour-fundo' });
    const caixa = el('div', { class: 'modal peq tour', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-tit' });
    fundo.append(caixa);
    const esc = e => { if (e.key === 'Escape') fechar(false); };

    async function fechar(levou) {
      document.removeEventListener('keydown', esc);
      fundo.remove();
      await sb.from('avisos_lidos').upsert({ perfil_id: S.perfil.id, chave }, { onConflict: 'perfil_id,chave' });
      resolve(levou);
    }

    function desenhar() {
      const p = passos[i];
      const ultimo = i === passos.length - 1;
      caixa.replaceChildren(
        el('div', { class: 'modal-topo' },
          el('span', { class: 'mudo' }, `Novidade ${i + 1} de ${passos.length}`),
          el('button', { class: 'fechar', 'aria-label': 'Fechar o tour', onclick: () => fechar(false) }, '×')),
        el('h2', { id: 'tour-tit' }, p.titulo),
        el('p', { class: 'tour-texto' }, p.texto),
        el('div', { class: 'tour-pontos', 'aria-hidden': 'true' },
          passos.map((_, j) => el('span', { class: j === i ? 'ativo' : null }))),
        el('div', { class: 'acoes tour-acoes' },
          i > 0 ? el('button', { class: 'btn', onclick: () => { i--; desenhar(); } }, 'Anterior') : null,
          p.aba ? el('button', { class: 'btn', onclick: () => { fechar(true); levarPara(p); } }, 'Me leva lá →') : null,
          el('button', { class: 'btn prim', onclick: () => { if (ultimo) fechar(false); else { i++; desenhar(); } } },
            ultimo ? 'Fechou!' : 'Próximo')));
      caixa.querySelector('.btn.prim').focus();
    }

    document.addEventListener('keydown', esc);
    document.body.append(fundo);
    desenhar();
  });
}

// Vai para a aba da novidade e faz o elemento piscar (espera a tela carregar)
function levarPara(p) {
  S.aba = p.aba;
  render();
  if (!p.alvo) return;
  let tentativas = 0;
  const procurar = () => {
    const alvo = document.querySelector(p.alvo);
    if (!alvo) { if (++tentativas < 15) setTimeout(procurar, 200); return; }
    alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    alvo.classList.add('destaque');
    setTimeout(() => alvo.classList.remove('destaque'), 3000);
  };
  setTimeout(procurar, 150);
}

// ---------------------------------------------------------------- checklist diário

const ITENS_CHECKLIST = [['conexoes', 'Conexões enviadas'], ['mensagens', 'Mensagens'], ['followups', 'Follow-ups']];
const diaLocal = (d = new Date()) => {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
};
const nomeDia = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });

// Quem não bateu a meta do último dia útil vê uma janela curta: só fecha no "Ok", que leva ao checklist.
async function avisoChecklist() {
  const { data: r } = await sb.rpc('checklist_ontem');
  if (!r || r.bateu || r.ja_viu) return;
  const nomes = Object.fromEntries(ITENS_CHECKLIST);
  const fundo = el('div', { class: 'fundo-modal' });
  const ok = el('button', { class: 'btn prim', onclick: async () => {
    await sb.from('avisos_lidos').upsert({ perfil_id: S.perfil.id, chave: `checklist:${r.dia}` }, { onConflict: 'perfil_id,chave' });
    fundo.remove();
    S.aba = 'checklist';
    render();
  } }, 'Ok');
  fundo.append(el('div', { class: 'modal peq aviso-meta', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'aviso-meta-tit' },
    el('h2', { id: 'aviso-meta-tit' }, r.preencheu ? 'A meta de ontem ficou para trás' : 'Faltou lançar os números de ontem'),
    el('p', { class: 'mudo' }, `${nomeDia(r.dia)}:`),
    el('ul', { class: 'aviso-itens' }, r.itens.map(i => el('li', { class: i.feito >= i.meta ? 'bateu' : null },
      `${i.feito >= i.meta ? '✓' : '·'} ${nomes[i.item]}: `, el('b', {}, String(i.feito)), ` de ${i.meta}`))),
    el('p', {}, r.preencheu ? 'Hoje é dia de recuperar. 💪' : 'Se esqueceu de lançar, ainda dá tempo de completar.'),
    el('div', { class: 'acoes' }, ok)));
  document.body.append(fundo);
  ok.focus();
}

async function telaChecklist(main) {
  main.replaceChildren(el('p', { class: 'mudo' }, 'Carregando…'));
  const hoje = diaLocal();
  const semana = diaLocal(Date.now() - 7 * 864e5);
  const inicioHoje = new Date(); inicioHoje.setHours(0, 0, 0, 0);
  const [metas, dias, fupsHoje] = await Promise.all([
    q(sb.from('checklist_metas').select('*')),
    q(sb.from('checklist_dia').select('*').gte('dia', semana).order('dia', { ascending: false })),
    q(sb.from('followups').select('id', { count: 'exact', head: true }).eq('feito_por', S.perfil.id).gte('feito_em', inicioHoje.toISOString())),
  ]);
  if (S.aba !== 'checklist') return;
  const minhaMeta = metas.find(m => m.perfil_id === S.perfil.id) || {};
  const meus = dias.filter(d => d.perfil_id === S.perfil.id);

  // Formulário do dia (hoje ou um dos últimos 7 dias)
  const fDia = el('input', { type: 'date', value: hoje, min: semana, max: hoje, 'aria-label': 'Dia' });
  const campos = Object.fromEntries(ITENS_CHECKLIST.map(([k]) => [k, el('input', { type: 'number', min: '0', max: '10000', step: '1', inputmode: 'numeric' })]));
  const barras = Object.fromEntries(ITENS_CHECKLIST.map(([k]) => [k, el('div', {})]));
  const notas = Object.fromEntries(ITENS_CHECKLIST.map(([k]) => [k, el('span', { class: 'mudo' })]));
  const atualizarBarras = () => {
    for (const [k] of ITENS_CHECKLIST) {
      const meta = minhaMeta[k] || 0, v = parseInt(campos[k].value, 10) || 0;
      barras[k].style.width = `${meta ? Math.min(100, (v / meta) * 100) : 0}%`;
      notas[k].textContent = meta ? (v >= meta ? `meta ${meta} · batida 🎉` : `meta ${meta} · faltam ${meta - v}`) : 'sem meta';
    }
  };
  const preencher = () => {
    const d = meus.find(x => x.dia === fDia.value);
    for (const [k] of ITENS_CHECKLIST) campos[k].value = d?.[k] ?? '';
    atualizarBarras();
  };
  fDia.addEventListener('change', preencher);
  Object.values(campos).forEach(c => c.addEventListener('input', atualizarBarras));
  preencher();

  const salvar = el('button', { class: 'btn prim', onclick: async () => {
    const linha = { perfil_id: S.perfil.id, dia: fDia.value };
    for (const [k] of ITENS_CHECKLIST) linha[k] = Math.max(0, parseInt(campos[k].value, 10) || 0);
    await q(sb.from('checklist_dia').upsert(linha, { onConflict: 'perfil_id,dia' }));
    toast('Números do dia salvos ✓');
    render();
  } }, 'Salvar');

  const blocos = [
    el('section', { class: 'secao' },
      el('h3', {}, 'Meus números'),
      el('div', { class: 'linha' }, el('label', { class: 'mudo' }, 'Dia '), fDia),
      ITENS_CHECKLIST.map(([k, rotulo]) => el('div', { class: 'item-check' },
        el('label', {}, rotulo, campos[k]),
        el('div', { class: 'trilho verde' }, barras[k]),
        notas[k],
        k === 'followups' && fDia.value === hoje && fupsHoje ? el('button', { class: 'link', onclick: () => { campos.followups.value = fupsHoje; atualizarBarras(); } },
          `No CRM você marcou ${fupsHoje} follow-up${fupsHoje > 1 ? 's' : ''} hoje: usar esse número`) : null)),
      el('div', { class: 'acoes' }, salvar)),
    el('section', { class: 'secao' },
      el('h3', {}, 'Meus últimos 7 dias'),
      el('div', { class: 'tabela-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Dia'), ITENS_CHECKLIST.map(([, t]) => el('th', { class: 'n' }, t)))),
        el('tbody', {}, meus.length ? meus.map(d => el('tr', {}, el('td', {}, nomeDia(d.dia)),
          ITENS_CHECKLIST.map(([k]) => celulaMeta(d[k], minhaMeta[k])))) :
          el('tr', {}, el('td', { colspan: '4', class: 'mudo' }, 'Nenhum dia lançado ainda.')))))),
  ];

  // O dono vê o time: hoje e o último dia útil
  if (souDono()) {
    const equipe = S.perfis.filter(p => p.ativo);
    const ontem = (() => { const d = new Date(); d.setDate(d.getDate() - ({ 1: 3, 0: 2 }[d.getDay()] ?? 1)); return diaLocal(d); })();
    const tabelaDia = dia => el('div', { class: 'tabela-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Quem'), ITENS_CHECKLIST.map(([, t]) => el('th', { class: 'n' }, t)))),
      el('tbody', {}, equipe.map(p => {
        const d = dias.find(x => x.perfil_id === p.id && x.dia === dia);
        const m = metas.find(x => x.perfil_id === p.id) || {};
        return el('tr', {}, el('td', {}, p.nome), ITENS_CHECKLIST.map(([k]) => d ? celulaMeta(d[k], m[k]) : el('td', { class: 'n mudo' }, '—')));
      }))));
    blocos.push(el('section', { class: 'secao' },
      el('h3', {}, 'Time hoje'), tabelaDia(hoje),
      el('h3', {}, `Time · ${nomeDia(ontem)}`), tabelaDia(ontem),
      el('p', { class: 'mudo' }, 'As metas de cada pessoa ficam em Configurações → Checklist diário.')));
  }
  main.replaceChildren(...blocos);
}

// "12 / 20" — verde quando bateu; sem vermelho
function celulaMeta(v, meta) {
  return el('td', { class: 'n' + (meta && v >= meta ? ' bateu' : '') }, meta ? `${v} / ${meta}` : String(v));
}

// ---------------------------------------------------------------- tela: Meta (funil do mês corrente)

// Funil de verdade: o contorno de cada etapa é a meta; o verde dentro é o que já foi feito.
// Sempre o mês corrente e sempre o time inteiro. Só verde: o tamanho mostra o quanto falta.
const ETAPAS_META = [
  ['leads', 'Leads'], ['quentes', 'Leads quentes'], ['reunioes_agendadas', 'Reuniões agendadas'],
  ['reunioes_realizadas', 'Reuniões realizadas'], ['vendas', 'Vendas'],
];
const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...filhos) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  n.append(...filhos);
  return n;
}

function degrauDoFunil(i, total, rotulo, feito, meta) {
  const passo = 30 / total;                       // cada degrau estreita um pouco de cada lado
  const a = i * passo, b = (i + 1) * passo;       // recuo em cima e embaixo (em %)
  const forma = `${a},0 ${100 - a},0 ${100 - b},10 ${b},10`;
  const pct = meta ? Math.min(1, feito / meta) : 0;
  const id = `degrau-${i}`;
  const desenho = svg('svg', { viewBox: '0 0 100 10', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    svg('defs', {}, svg('clipPath', { id }, svg('polygon', { points: forma }))),
    svg('rect', { class: 'feito', x: a, y: 0, width: (100 - 2 * a) * pct, height: 10, 'clip-path': `url(#${id})` }),
    svg('polygon', { class: meta ? 'contorno' : 'contorno sem-meta', points: forma }));
  const falta = meta ? meta - feito : null;
  return el('div', { class: 'degrau', role: 'img', 'aria-label': `${rotulo}: ${feito} de ${meta ?? 'sem meta'}` },
    desenho,
    el('div', { class: 'degrau-texto' },
      el('span', { class: 'degrau-rotulo' }, rotulo),
      el('b', {}, String(feito), el('small', {}, meta ? ` de ${meta}` : ' (sem meta)')),
      meta ? el('span', { class: 'degrau-falta' }, falta > 0 ? `faltam ${falta}` : `meta batida${falta < 0 ? ` (+${-falta})` : ''} 🎉`) : null));
}

async function telaMeta(main) {
  main.replaceChildren(el('p', { class: 'mudo' }, 'Carregando…'));
  const p = await q(sb.rpc('progresso_do_mes'));
  if (S.aba !== 'meta') return;
  const { feito, meta } = p;
  const [ano, mes] = p.mes.split('-').map(Number);
  const nomeMes = new Date(ano, mes - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const hoje = new Date();
  const diasFim = new Date(ano, mes, 0).getDate() - hoje.getDate();

  const fat = Number(feito.faturamento) || 0;
  const metaFat = Number(meta.faturamento) || 0;
  const barra = el('div', {});
  barra.style.width = `${metaFat ? Math.min(100, (fat / metaFat) * 100) : 0}%`;

  const temMeta = ETAPAS_META.some(([k]) => meta[k]) || metaFat;
  main.replaceChildren(...[
    el('div', { class: 'meta-topo' },
      el('h2', {}, `Meta de ${nomeMes}`),
      el('span', { class: 'mudo' }, diasFim > 0 ? `faltam ${diasFim} dia${diasFim > 1 ? 's' : ''} para acabar o mês` : 'último dia do mês'),
      el('span', { class: 'mudo' }, 'Números do time inteiro.' +
        (p.meta_de && p.meta_de.slice(0, 7) !== p.mes.slice(0, 7) ? ' Usando a última meta definida.' : ''))),
    temMeta ? null : el('p', { class: 'vazio' }, souDono() ? 'Defina as metas em Configurações → Meta do mês.' : 'O dono ainda não definiu a meta.'),
    el('div', { class: 'funil-meta' },
      ETAPAS_META.map(([k, rotulo], i) => degrauDoFunil(i, ETAPAS_META.length, rotulo, Number(feito[k]) || 0, meta[k] || null))),
    el('div', { class: 'meta-box fat-meta' },
      el('div', { class: 'meta-rotulo' }, 'Faturamento'),
      el('div', { class: 'meta-num' }, dinheiro(fat), ' ', el('small', {}, metaFat ? `de ${dinheiro(metaFat)}` : '(sem meta)')),
      el('div', { class: 'trilho verde' }, barra),
      metaFat ? el('div', { class: 'mudo' }, fat < metaFat ? `Faltam ${dinheiro(metaFat - fat)}` : 'Meta de faturamento batida! 🎉') : null),
  ].filter(Boolean));
}

// ---------------------------------------------------------------- tela: Configurações (dono)

async function telaConfig(main) {
  if (!souDono()) { S.aba = 'hoje'; return render(); }
  const [metas, perfis, ultima, ult24h, metasCheck] = await Promise.all([
    q(sb.from('metas').select('*').order('mes', { ascending: false }).limit(12)),
    q(sb.from('perfis').select('*').order('criado_em')),
    q(sb.from('mensagens_whatsapp').select('recebida_em').order('recebida_em', { ascending: false }).limit(1)),
    q(sb.from('mensagens_whatsapp').select('wamid', { count: 'exact', head: true }).gte('recebida_em', new Date(Date.now() - 864e5).toISOString())),
    q(sb.from('checklist_metas').select('*')),
  ]);
  if (S.aba !== 'config') return;

  // Checklist diário: a meta de cada pessoa (vazio = sem meta naquele item)
  const linhasCheck = perfis.filter(p => p.ativo).map(p => {
    const m = metasCheck.find(x => x.perfil_id === p.id) || {};
    const ins = Object.fromEntries(ITENS_CHECKLIST.map(([k, t]) => [k, el('input', {
      type: 'number', min: '0', max: '10000', step: '1', inputmode: 'numeric', value: m[k] ?? '', 'aria-label': `${t} — ${p.nome}` })]));
    Object.values(ins).forEach(i => { i.style.width = '90px'; });
    return el('tr', {}, el('td', {}, p.nome), ITENS_CHECKLIST.map(([k]) => el('td', {}, ins[k])),
      el('td', {}, el('button', { class: 'btn peq', onclick: async () => {
        const linha = { perfil_id: p.id };
        for (const [k] of ITENS_CHECKLIST) linha[k] = ins[k].value === '' ? null : Math.max(0, parseInt(ins[k].value, 10) || 0);
        await q(sb.from('checklist_metas').upsert(linha, { onConflict: 'perfil_id' }));
        toast(`Metas de ${p.nome} salvas ✓`);
      } }, 'Salvar')));
  });

  const recarregarConfig = async () => { await carregarFunis(); await carregarCards(); render(); };

  // Meta
  const fMes = el('input', { type: 'month', value: S.mes });
  const fVendas = el('input', { type: 'number', min: '1', step: '1', inputmode: 'numeric', placeholder: 'Vendas', 'aria-label': 'Meta de vendas' });
  const fFat = el('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: 'Faturamento R$ (opcional)', 'aria-label': 'Meta de faturamento' });
  const campoEtapa = (rotulo) => el('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', placeholder: rotulo, 'aria-label': `Meta: ${rotulo}` });
  const fEtapas = {
    leads: campoEtapa('Leads'), quentes: campoEtapa('Leads quentes'),
    reunioes_agendadas: campoEtapa('Reuniões agendadas'), reunioes_realizadas: campoEtapa('Reuniões realizadas'),
  };
  const preencheMeta = () => {
    const m = metas.find(x => x.mes.slice(0, 7) === fMes.value);
    fVendas.value = m?.vendas ?? '';
    fFat.value = m?.faturamento ?? '';
    for (const [k, f] of Object.entries(fEtapas)) f.value = m?.[k] ?? '';
  };
  fMes.addEventListener('change', preencheMeta);
  preencheMeta();
  const salvarMeta = el('button', { class: 'btn prim', onclick: async () => {
    const v = parseInt(fVendas.value, 10);
    if (!fMes.value || !(v > 0)) return toast('Informe o mês e a quantidade de vendas.', true);
    const etapas = Object.fromEntries(Object.entries(fEtapas).map(([k, f]) => [k, f.value === '' ? null : Math.max(0, parseInt(f.value, 10) || 0)]));
    await q(sb.from('metas').upsert({ mes: `${fMes.value}-01`, vendas: v, faturamento: num(fFat.value), ...etapas }, { onConflict: 'mes' }));
    toast('Meta salva ✓'); render();
  } }, 'Salvar meta');

  // Funis e etapas
  const blocoFunis = S.funis.map(f => {
    const nomeFunil = el('input', { value: f.nome, maxlength: 60, 'aria-label': 'Nome do funil' });
    const linhas = etapasDoFunil(f.id).map(e => {
      const nome = el('input', { value: e.nome, maxlength: 40, 'aria-label': 'Nome da etapa' });
      const ordem = el('input', { type: 'number', value: e.ordem, step: '1', 'aria-label': 'Ordem' });
      ordem.style.width = '80px';
      return el('tr', {},
        el('td', {}, nome),
        el('td', {}, ordem),
        el('td', { class: 'mudo' }, e.marco ? `⭐ ${NOME_MARCO[e.marco]}` : 'comum'),
        el('td', {}, el('div', { class: 'acoes' },
          el('button', { class: 'btn peq', onclick: async () => {
            if (!nome.value.trim()) return toast('A etapa precisa de nome.', true);
            await q(sb.from('etapas').update({ nome: nome.value.trim(), ordem: parseInt(ordem.value, 10) || e.ordem }).eq('id', e.id));
            toast('Etapa salva ✓'); await recarregarConfig();
          } }, 'Salvar'),
          !e.marco ? el('button', { class: 'btn peq perigo', onclick: async () => {
            if (!(await confirmar(`Apagar a etapa "${e.nome}"?`))) return;
            await q(sb.from('etapas').delete().eq('id', e.id));
            toast('Etapa apagada'); await recarregarConfig();
          } }, 'Apagar') : null)));
    });
    return el('div', { class: 'bloco' },
      el('div', { class: 'linha' },
        el('div', { class: 'cresce' }, nomeFunil),
        f.padrao ? el('span', { class: 'selo' }, '⭐ padrão (recebe o WhatsApp)') : el('button', { class: 'btn peq', onclick: async () => {
          const atual = S.funis.find(x => x.padrao);
          if (atual) await q(sb.from('funis').update({ padrao: false }).eq('id', atual.id));
          await q(sb.from('funis').update({ padrao: true, ativo: true }).eq('id', f.id));
          toast('Funil padrão alterado ✓'); await recarregarConfig();
        } }, 'Tornar padrão'),
        el('button', { class: 'btn peq', onclick: async () => {
          if (!nomeFunil.value.trim()) return toast('O funil precisa de nome.', true);
          await q(sb.from('funis').update({ nome: nomeFunil.value.trim() }).eq('id', f.id));
          toast('Funil salvo ✓'); await recarregarConfig();
        } }, 'Salvar nome'),
        !f.padrao ? el('button', { class: 'btn peq', onclick: async () => {
          await q(sb.from('funis').update({ ativo: !f.ativo }).eq('id', f.id));
          await recarregarConfig();
        } }, f.ativo ? 'Desativar' : 'Reativar') : null),
      el('div', { class: 'tabela-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Etapa'), el('th', {}, 'Ordem'), el('th', {}, 'Tipo'), el('th', {}, ''))),
        el('tbody', {}, linhas))),
      el('button', { class: 'btn peq', onclick: async () => {
        const r = await pedir(`Nova etapa em "${f.nome}"`, [
          { nome: 'nome', rotulo: 'Nome da etapa', obrigatorio: true, max: 40 },
          { nome: 'ordem', rotulo: 'Ordem (ex.: 45 fica entre 40 e 50)', tipo: 'number', obrigatorio: true, valor: 45 },
        ], 'Criar');
        if (!r) return;
        await q(sb.from('etapas').insert({ funil_id: f.id, nome: r.nome.trim(), ordem: parseInt(r.ordem, 10) }));
        toast('Etapa criada ✓'); await recarregarConfig();
      } }, '+ Nova etapa'));
  });

  // Usuários
  const linhasUsuarios = perfis.map(p => {
    const eu = p.id === S.perfil.id;
    const papel = el('select', { disabled: eu }, opcoes([['vendedor', 'Vendedor'], ['dono', 'Dono']], p.papel));
    const ativo = el('input', { type: 'checkbox', disabled: eu, 'aria-label': 'Ativo' });
    ativo.checked = p.ativo;
    const salvar = async mudanca => {
      try { await q(sb.from('perfis').update(mudanca).eq('id', p.id)); toast('Usuário atualizado ✓'); }
      catch { /* erro já mostrado */ }
      finally { S.perfis = await q(sb.from('perfis').select('id,nome,papel,ativo').order('nome')); render(); }
    };
    papel.addEventListener('change', () => salvar({ papel: papel.value }));
    ativo.addEventListener('change', () => salvar({ ativo: ativo.checked }));
    return el('tr', {}, el('td', {}, p.nome, eu ? ' (você)' : ''), el('td', {}, p.email || ''), el('td', {}, papel), el('td', {}, ativo));
  });

  main.replaceChildren(
    el('section', { class: 'secao' },
      el('h3', {}, 'Meta do mês'),
      el('p', { class: 'mudo' }, 'Os números de cada etapa formam o funil da aba Meta. Sem meta no mês, vale a do último mês definido.'),
      el('div', { class: 'grade-metas' },
        el('label', {}, 'Mês', fMes),
        el('label', {}, 'Leads', fEtapas.leads), el('label', {}, 'Leads quentes', fEtapas.quentes),
        el('label', {}, 'Reuniões agendadas', fEtapas.reunioes_agendadas),
        el('label', {}, 'Reuniões realizadas', fEtapas.reunioes_realizadas),
        el('label', {}, 'Vendas', fVendas), el('label', {}, 'Faturamento (R$)', fFat)),
      el('div', { class: 'acoes' }, salvarMeta)),
    el('section', { class: 'secao' },
      el('h3', {}, 'Checklist diário'),
      el('p', { class: 'mudo' }, 'A meta de cada pessoa por dia. Quem ficar abaixo no último dia útil vê um aviso ao abrir o CRM. Deixe vazio o que não tiver meta.'),
      el('div', { class: 'tabela-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Quem'), ITENS_CHECKLIST.map(([, t]) => el('th', {}, t)), el('th', {}, ''))),
        el('tbody', {}, linhasCheck)))),
    el('section', { class: 'secao' },
      el('h3', {}, 'Funis e etapas'),
      el('p', { class: 'mudo' }, 'As etapas com ⭐ são usadas pelas automações (follow-up, "respondeu = quente", perdido automático e o painel). Você pode renomear e reordenar, mas não apagar.'),
      blocoFunis,
      el('div', { class: 'bloco' }, el('button', { class: 'btn', onclick: async () => {
        const r = await pedir('Novo funil', [{ nome: 'nome', rotulo: 'Nome do funil', obrigatorio: true, max: 60 }], 'Criar');
        if (!r) return;
        await q(sb.from('funis').insert({ nome: r.nome.trim() }));
        toast('Funil criado com as 6 etapas padrão ✓'); await recarregarConfig();
      } }, '+ Novo funil'))),
    el('section', { class: 'secao' },
      el('h3', {}, 'Usuários'),
      el('p', { class: 'mudo' }, 'Para adicionar alguém: Supabase → Authentication → Users → Invite user. A pessoa aparece aqui como inativa; marque "ativo" para liberar. Desmarcar corta o acesso na hora.'),
      el('div', { class: 'tabela-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Nome'), el('th', {}, 'E-mail'), el('th', {}, 'Papel'), el('th', {}, 'Ativo'))),
        el('tbody', {}, linhasUsuarios)))),
    el('section', { class: 'secao' },
      el('h3', {}, 'WhatsApp'),
      el('p', {}, ultima.length
        ? `Última mensagem recebida ${ha(ultima[0].recebida_em)} (${dataHora(ultima[0].recebida_em)}). Nas últimas 24 h: ${ult24h} mensagens.`
        : 'Nenhuma mensagem recebida ainda. Confira a configuração do webhook (README).')));
}

// ---------------------------------------------------------------- início

(async function iniciar() {
  if (!CFG || CFG.SUPABASE_URL.includes('SEU-PROJETO')) {
    app.replaceChildren(el('div', { class: 'login' }, el('h1', {}, 'Falta configurar'),
      el('p', {}, 'Preencha o arquivo config.js com a URL e a chave pública do Supabase.')));
    return;
  }
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') setTimeout(() => telaLogin(), 0); });
  const { data: { session } } = await sb.auth.getSession();
  if (tipoLink) history.replaceState(null, '', location.pathname);
  if (session && (tipoLink === 'invite' || tipoLink === 'recovery')) return telaNovaSenha();
  if (session) return entrar();
  telaLogin();
})();
