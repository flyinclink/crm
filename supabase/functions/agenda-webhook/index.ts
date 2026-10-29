// Recebe o aviso do Cal.com quando um lead marca, remarca ou cancela reunião,
// cria/atualiza o card e avisa o time por e-mail.
// Publicar com:  supabase functions deploy agenda-webhook --no-verify-jwt
// (o Cal.com não manda login do Supabase; a segurança é a assinatura do Cal.com).
//
// Secrets necessários (supabase secrets set ...):
//   CALCOM_WEBHOOK_SECRET — o mesmo "Secret" colado no webhook do Cal.com
//   RESEND_API_KEY        — chave do Resend (envio dos e-mails de aviso)
//   AVISO_EMAIL_DE        — (opcional) remetente, ex.: "CRM <avisos@seudominio.com.br>"
//   AVISO_EMAILS          — (opcional) quem recebe, separado por vírgula. Vazio = todos os usuários ativos
//   CRM_URL               — (opcional) endereço da página do CRM, para o link no e-mail
// deno-lint-ignore-file no-explicit-any

import { clienteSupabase, iguais, TAMANHO_MAXIMO } from "../_shared/tally.ts";

const supabase = clienteSupabase();
const encoder = new TextEncoder();

// O Cal.com assina cada aviso: cabeçalho X-Cal-Signature-256 = HMAC-SHA256 do corpo, em hexadecimal.
async function assinaturaValida(corpo: string, cabecalho: string | null): Promise<boolean> {
  const segredo = Deno.env.get("CALCOM_WEBHOOK_SECRET") ?? "";
  if (!segredo || !cabecalho) return false;
  const chave = await crypto.subtle.importKey(
    "raw", encoder.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", chave, encoder.encode(corpo)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return iguais(hex, cabecalho.trim().toLowerCase());
}

const EVENTOS: Record<string, string> = {
  BOOKING_CREATED: "criada",
  BOOKING_RESCHEDULED: "remarcada",
  BOOKING_CANCELLED: "cancelada",
};

const texto = (v: any): string => {
  if (v == null) return "";
  if (typeof v === "object") {
    if ("value" in v) return texto(v.value);
    return [v.firstName, v.lastName].filter(Boolean).join(" ");
  }
  return String(v).trim();
};

// Telefone: campo padrão do Cal.com ou qualquer pergunta com "telefone/whats/celular" no nome
function telefoneDe(p: any): string {
  const r = p?.responses ?? {};
  const direto = texto(r.attendeePhoneNumber) || texto(p?.attendees?.[0]?.phoneNumber) || texto(p?.smsReminderNumber);
  if (direto) return direto;
  for (const [chave, valor] of Object.entries(r)) {
    const rotulo = `${chave} ${(valor as any)?.label ?? ""}`.toLowerCase();
    if (/phone|whats|telefone|celular|fone/.test(rotulo)) {
      const t = texto(valor);
      if (/\d{8,}/.test(t.replace(/\D/g, ""))) return t;
    }
  }
  return "";
}

const umaLinha = (s: string) => s.replace(/[\r\n]+/g, " ").slice(0, 150);

function quando(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso)).replace(",", "").replace(/ (\d{2}:\d{2})$/, " às $1");
}

async function destinatarios(): Promise<string[]> {
  const fixos = (Deno.env.get("AVISO_EMAILS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (fixos.length) return fixos;
  const { data } = await supabase.from("perfis").select("email").eq("ativo", true);
  return (data ?? []).map((p: any) => p.email).filter(Boolean);
}

// E-mail só em texto puro: nome e respostas vêm de estranhos, nada vira HTML.
async function avisarTime(r: any) {
  const chave = Deno.env.get("RESEND_API_KEY");
  if (!chave) return console.warn("RESEND_API_KEY não configurada: aviso por e-mail não enviado");
  const titulo = {
    criada: "📅 Reunião marcada",
    remarcada: "🔁 Reunião remarcada",
    cancelada: "🚫 Reunião cancelada",
  }[r.acao as string] ?? "Reunião";
  const assunto = umaLinha(`${titulo}: ${r.nome} · ${quando(r.inicio)}`);
  const linhas = [
    `${titulo} pela agenda.`,
    "",
    `Lead: ${r.nome}${r.card_novo ? " (card novo)" : ""}`,
    r.empresa ? `Empresa: ${r.empresa}` : null,
    r.email ? `E-mail: ${r.email}` : null,
    r.whatsapp ? `WhatsApp: +${r.whatsapp}` : null,
    `Quando: ${quando(r.inicio)}`,
    r.titulo ? `Reunião: ${r.titulo}` : null,
    r.dono ? `Dono da reunião: ${r.dono}` : null,
    r.link && r.acao !== "cancelada" ? `Link: ${r.link}` : null,
    `Etapa no CRM: ${r.etapa}`,
    Deno.env.get("CRM_URL") ? `\nAbrir o CRM: ${Deno.env.get("CRM_URL")}` : null,
  ].filter((l) => l != null).join("\n");

  // um e-mail por pessoa: se um endereço for recusado, os outros ainda recebem
  for (const para of await destinatarios()) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: Deno.env.get("AVISO_EMAIL_DE") || "CRM <onboarding@resend.dev>",
        to: [para], subject: assunto, text: linhas,
      }),
    });
    if (!resp.ok) console.error("e-mail de aviso falhou", para, resp.status, await resp.text());
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  if (Number(req.headers.get("content-length") ?? 0) > TAMANHO_MAXIMO) {
    return new Response("too large", { status: 413 });
  }
  const corpo = await req.text();
  if (corpo.length > TAMANHO_MAXIMO) return new Response("too large", { status: 413 });
  if (!(await assinaturaValida(corpo, req.headers.get("x-cal-signature-256")))) {
    return new Response("invalid signature", { status: 401 });
  }

  let dados: any;
  try {
    dados = JSON.parse(corpo);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const evento = EVENTOS[dados?.triggerEvent];
  if (!evento) return new Response("ignored", { status: 200 });   // ex.: o "Ping test" do Cal.com

  const p = dados.payload ?? {};
  const convidado = p.attendees?.[0] ?? {};
  const local = texto(p.location);
  const { data, error } = await supabase.rpc("processar_agendamento", {
    p_evento: evento,
    p_uid: String(p.uid ?? "").slice(0, 200),
    p_uid_anterior: p.rescheduleUid ?? p.fromReschedule ?? p.originalRescheduledBooking?.uid ?? null,
    p_inicio: p.startTime ?? null,
    p_organizador_email: p.organizer?.email ?? null,
    p_nome: texto(p.responses?.name) || texto(convidado.name) || null,
    p_email: texto(p.responses?.email) || texto(convidado.email) || null,
    p_telefone: telefoneDe(p) || null,
    p_titulo: p.title ?? p.eventTitle ?? null,
    p_link: p.metadata?.videoCallUrl ?? p.videoCallData?.url ?? (local.startsWith("https://") ? local : null),
    p_payload: dados,
  });
  if (error) {
    console.error("erro ao gravar agendamento", p.uid, error.message);
    return new Response("error", { status: 500 });
  }
  if (data) {
    try {
      await avisarTime(data);
    } catch (e) {
      console.error("aviso por e-mail falhou", e);       // a reunião já está gravada
    }
  }
  return new Response("ok", { status: 200 });
});
