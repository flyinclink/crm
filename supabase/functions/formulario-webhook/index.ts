// Recebe o aviso do Tally a cada envio e cria/atualiza o card.
// Publicar com:  supabase functions deploy formulario-webhook --no-verify-jwt
// (o Tally não manda login do Supabase; a segurança é a assinatura do Tally).
//
// Secrets necessários (supabase secrets set ...):
//   TALLY_SIGNING_SECRET  — o mesmo "Signing secret" colado no webhook do Tally
//   TALLY_FORM_IDS        — (opcional) ids dos formulários aceitos, separados por vírgula

import {
  assinaturaTallyValida, clienteSupabase, deWebhook, FORMULARIOS, gravarEnvio, TAMANHO_MAXIMO,
} from "../_shared/tally.ts";

const supabase = clienteSupabase();

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  if (Number(req.headers.get("content-length") ?? 0) > TAMANHO_MAXIMO) {
    return new Response("too large", { status: 413 });
  }
  const corpo = await req.text();
  if (corpo.length > TAMANHO_MAXIMO) return new Response("too large", { status: 413 });
  if (!(await assinaturaTallyValida(corpo, req.headers.get("tally-signature")))) {
    return new Response("invalid signature", { status: 401 });
  }

  // deno-lint-ignore no-explicit-any
  let dados: any;
  try {
    dados = JSON.parse(corpo);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (dados?.eventType !== "FORM_RESPONSE") return new Response("ignored", { status: 200 });

  const envio = deWebhook(dados.data);
  if (FORMULARIOS.length && !FORMULARIOS.includes(envio.formId)) {
    return new Response("ignored form", { status: 200 });
  }

  const { erro } = await gravarEnvio(supabase, envio, "aviso");
  if (erro) {
    console.error("erro ao gravar envio", envio.submissionId, erro);
    // 500 faz o Tally tentar de novo; e a busca de hora em hora pega o que faltar
    return new Response("error", { status: 500 });
  }
  return new Response("ok", { status: 200 });
});
