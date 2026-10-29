// Recebe as mensagens do WhatsApp (Meta Cloud API) e cria/atualiza cards
// (card novo cai no funil padrão, na etapa "Novo lead").
// Publicar com:  supabase functions deploy whatsapp-webhook --no-verify-jwt
// (o Meta não manda login do Supabase; a segurança é a assinatura do Meta).
//
// Secrets necessários (supabase secrets set ...):
//   WHATSAPP_APP_SECRET       — App Secret do app no Meta (assina cada chamada)
//   WHATSAPP_VERIFY_TOKEN     — texto aleatório que você inventa e cola no Meta
//   WHATSAPP_PHONE_NUMBER_ID  — (opcional) só aceita mensagens deste número
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const APP_SECRET = Deno.env.get("WHATSAPP_APP_SECRET") ?? "";
const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
const PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const TAMANHO_MAXIMO = 1_000_000; // 1 MB

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const encoder = new TextEncoder();

function iguais(a: string, b: string): boolean {
  // comparação em tempo constante
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function assinaturaValida(corpo: string, cabecalho: string | null): Promise<boolean> {
  if (!APP_SECRET || !cabecalho?.startsWith("sha256=")) return false;
  const chave = await crypto.subtle.importKey(
    "raw", encoder.encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", chave, encoder.encode(corpo)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return iguais(hex, cabecalho.slice(7).toLowerCase());
}

// deno-lint-ignore no-explicit-any
function textoDaMensagem(msg: any): string | null {
  switch (msg.type) {
    case "text": return msg.text?.body ?? null;
    case "button": return msg.button?.text ?? null;
    case "interactive":
      return msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? null;
    case "image": case "video": case "document":
      return msg[msg.type]?.caption ?? `[${msg.type}]`;
    case "audio": return "[áudio]";
    case "sticker": return "[figurinha]";
    case "location": return "[localização]";
    case "contacts": return "[contato]";
    case "reaction": return msg.reaction?.emoji ? `[reação ${msg.reaction.emoji}]` : null;
    default: return `[${msg.type ?? "mensagem"}]`;
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 1) Verificação inicial do webhook (o Meta chama uma vez, ao configurar)
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && VERIFY_TOKEN !== "" &&
      iguais(url.searchParams.get("hub.verify_token") ?? "", VERIFY_TOKEN);
    return ok
      ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 })
      : new Response("forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // 2) Confere tamanho e assinatura ANTES de ler o conteúdo
  if (Number(req.headers.get("content-length") ?? 0) > TAMANHO_MAXIMO) {
    return new Response("too large", { status: 413 });
  }
  const corpo = await req.text();
  if (corpo.length > TAMANHO_MAXIMO) return new Response("too large", { status: 413 });
  if (!(await assinaturaValida(corpo, req.headers.get("x-hub-signature-256")))) {
    return new Response("invalid signature", { status: 401 });
  }

  // deno-lint-ignore no-explicit-any
  let dados: any;
  try {
    dados = JSON.parse(corpo);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (dados?.object !== "whatsapp_business_account") return new Response("ignored", { status: 200 });

  // 3) Processa cada mensagem recebida
  for (const entry of dados.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const v = change.value ?? {};
      if (PHONE_NUMBER_ID && v.metadata?.phone_number_id !== PHONE_NUMBER_ID) continue;

      const nomes = new Map<string, string>();
      for (const c of v.contacts ?? []) if (c.wa_id) nomes.set(c.wa_id, c.profile?.name ?? "");

      for (const msg of v.messages ?? []) {
        if (!msg.id || !msg.from) continue;
        const quando = msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : null;
        const { error } = await supabase.rpc("processar_mensagem_whatsapp", {
          p_wamid: String(msg.id).slice(0, 200),
          p_telefone: String(msg.from),
          p_nome: nomes.get(msg.from) ?? null,
          p_tipo: msg.type ?? null,
          p_texto: textoDaMensagem(msg),
          p_referral: msg.referral ?? null, // vem preenchido quando a pessoa clicou num anúncio
          p_payload: msg,
          p_recebida_em: quando,
        });
        if (error) {
          console.error("erro ao processar", msg.id, error.message);
          // 500 faz o Meta tentar de novo; mensagens já salvas são ignoradas na repetição
          return new Response("error", { status: 500 });
        }
      }
      // "statuses" (entregue/lido) são ignorados
    }
  }

  return new Response("ok", { status: 200 });
});
