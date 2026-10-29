// =====================================================================
// NOVIDADES — o tour que o time vê na primeira vez que entra depois de uma melhoria.
//
// Para lançar uma melhoria nova:
//   1. troque a VERSAO (qualquer texto diferente do atual, ex.: '2026-11-05')
//   2. troque os PASSOS: um por novidade
// Quem já fechou o tour desta versão não vê de novo. Versão nova = todo mundo vê de novo.
//
// Cada passo:
//   titulo  — curto
//   texto   — leve, de preferência com uma pitada de humor
//   aba     — para onde o "me leva lá" vai: hoje, meta, checklist, funil, painel, config
//   alvo    — (opcional) o que piscar na tela ao chegar lá (seletor CSS)
//   soDono  — (opcional) true = só o dono vê este passo
// =====================================================================
window.CRM_NOVIDADES = {
  VERSAO: '2026-10-29',
  PASSOS: [
    {
      titulo: '🔔 Um sino que não é de igreja',
      texto: 'Mensagem nova, card que mudou de etapa e reunião do dia aparecem aqui. "Minhas" é só o que é seu; "Geral" é a fofoca completa.',
      aba: 'hoje', alvo: '.sino',
    },
    {
      titulo: '✅ Checklist do dia',
      texto: 'Conexões, mensagens e follow-ups: lance seus números todo dia. Leva 20 segundos, menos que escolher figurinha no WhatsApp.',
      aba: 'checklist', alvo: '[data-aba="checklist"]',
    },
    {
      titulo: '🎯 O funil da meta',
      texto: 'O contorno é a meta do mês, o verde é o que já foi feito. Objetivo do jogo: pintar tudo de verde.',
      aba: 'meta', alvo: '.funil-meta',
    },
    {
      titulo: '💰 Dinheiro na mesa',
      texto: 'Fez a call e já sabe o valor? Coloque no card em "Valor na mesa". O Painel soma tudo que ainda pode virar venda. Sonhar com número é permitido.',
      aba: 'painel', alvo: '.na-mesa-box',
    },
    {
      titulo: '📅 Reunião agendada',
      texto: 'Lead marcou pelo Cal.com? O card anda sozinho para "Reunião agendada". Agendou pelo card? Tem confete. Sim, confete. 🎉',
      aba: 'funil',
    },
    {
      titulo: '⚙️ Metas do checklist',
      texto: 'Você define a meta diária de cada pessoa. Quem ficar abaixo vê um aviso discreto aqui dentro, nada de cobrança no grupo.',
      aba: 'config', soDono: true,
    },
  ],
};
