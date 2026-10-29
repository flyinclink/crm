// Código comum às duas funções do formulário (aviso do Tally e busca de envios perdidos).
// deno-lint-ignore-file no-explicit-any

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const TAMANHO_MAXIMO = 1_000_000; // 1 MB

// Formulários aceitos (ids separados por vírgula). Vazio = todos da sua conta.
export const FORMULARIOS = (Deno.env.get("TALLY_FORM_IDS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

export function clienteSupabase(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

const encoder = new TextEncoder();

export function iguais(a: string, b: string): boolean {
  // comparação em tempo constante
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function hmacBase64(segredo: string, texto: string): Promise<string> {
  const chave = await crypto.subtle.importKey(
    "raw", encoder.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", chave, encoder.encode(texto)));
  return btoa(String.fromCharCode(...mac));
}

// O Tally assina cada aviso com o "Signing secret" (cabeçalho Tally-Signature, HMAC-SHA256 em base64).
export async function assinaturaTallyValida(corpo: string, cabecalho: string | null): Promise<boolean> {
  const segredo = Deno.env.get("TALLY_SIGNING_SECRET") ?? "";
  if (!segredo || !cabecalho) return false;
  if (iguais(await hmacBase64(segredo, corpo), cabecalho)) return true;
  try {
    // o Tally calcula sobre JSON.stringify(payload); confere também nessa forma
    return iguais(await hmacBase64(segredo, JSON.stringify(JSON.parse(corpo))), cabecalho);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- leitura dos campos

export type Campo = { rotulo: string; tipo: string; valor: string };
export type Envio = {
  submissionId: string;
  formId: string;
  formNome: string;
  enviadoEm: string | null;
  campos: Campo[];
  bruto: unknown;
};

// Respostas de escolha chegam como ids de opção: troca pelo texto da opção.
function valorTexto(valor: any, opcoes: any[] | undefined): string {
  if (valor == null) return "";
  if (Array.isArray(valor)) {
    return valor.map((v) => {
      const op = (opcoes ?? []).find((o) => o?.id === v);
      return op?.text ?? (typeof v === "object" ? "" : String(v));
    }).filter(Boolean).join(", ");
  }
  if (typeof valor === "object") return "";
  return String(valor).trim();
}

// Aviso (webhook): data.fields = [{ label, type, value, options }]
export function deWebhook(data: any): Envio {
  return {
    submissionId: String(data?.submissionId ?? data?.responseId ?? ""),
    formId: String(data?.formId ?? ""),
    formNome: String(data?.formName ?? ""),
    enviadoEm: data?.createdAt ?? null,
    campos: (data?.fields ?? []).map((f: any) => ({
      rotulo: String(f?.label ?? ""),
      tipo: String(f?.type ?? ""),
      valor: valorTexto(f?.value, f?.options),
    })),
    bruto: data,
  };
}

// API (busca): questions = [{ id, type, title, fields:[{ options }] }], submission.responses = [{ questionId, value }]
export function deApi(sub: any, questoes: any[], formId: string, formNome: string): Envio {
  return {
    submissionId: String(sub?.id ?? ""),
    formId,
    formNome,
    enviadoEm: sub?.submittedAt ?? sub?.createdAt ?? null,
    campos: (sub?.responses ?? []).map((r: any) => {
      const q = questoes.find((x) => x?.id === r?.questionId) ?? {};
      const opcoes = q?.options ?? (q?.fields ?? []).flatMap((f: any) => f?.options ?? []);
      return { rotulo: String(q?.title ?? ""), tipo: String(q?.type ?? ""), valor: valorTexto(r?.value ?? r?.answer, opcoes) };
    }),
    bruto: sub,
  };
}

// Descobre nome, e-mail, telefone, cargo, empresa e faturamento pelo tipo ou pelo título da pergunta.
export function dadosDoEnvio(campos: Campo[]) {
  const acha = (teste: (c: Campo) => boolean) => campos.find((c) => c.valor && teste(c))?.valor ?? null;
  const texto = (c: Campo) => c.rotulo.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const rot = (re: RegExp, nao?: RegExp) => (c: Campo) => re.test(texto(c)) && !(nao && nao.test(texto(c)));
  const EMPRESA = /empresa|company|negocio|loja|razao social/;

  const email = acha((c) => /EMAIL/.test(c.tipo)) ?? acha(rot(/e-?mail/));
  const telefone = acha((c) => /PHONE/.test(c.tipo)) ?? acha(rot(/telefone|whats|celular|fone|phone/));
  const cargo = acha(rot(/cargo|funcao|role|position|job|posicao/));
  const empresa = acha(rot(EMPRESA, /faturamento|receita/));
  const faturamento = acha(rot(/faturamento|receita|revenue/));
  const nome = acha(rot(/^(seu )?(nome|name|primeiro nome|first name)|nome completo|full name/, EMPRESA));
  const sobrenome = acha(rot(/sobrenome|last name/, EMPRESA));
  return {
    email,
    telefone,
    cargo,
    empresa,
    faturamento,
    nome: [nome, sobrenome].filter(Boolean).join(" ") || null,
  };
}

// Grava no banco. Devolve true se era um envio novo, false se já tinha chegado antes.
export async function gravarEnvio(supabase: SupabaseClient, envio: Envio, via: "aviso" | "busca") {
  if (!envio.submissionId || !envio.formId) return { novo: false, erro: "envio sem id" };
  const d = dadosDoEnvio(envio.campos);
  const { data, error } = await supabase.rpc("processar_envio_formulario", {
    p_submission_id: envio.submissionId.slice(0, 200),
    p_form_id: envio.formId.slice(0, 100),
    p_form_nome: envio.formNome || "Formulário",
    p_nome: d.nome,
    p_email: d.email,
    p_telefone: d.telefone,
    p_cargo: d.cargo,
    p_empresa: d.empresa,
    p_faturamento: d.faturamento,
    p_enviado_em: envio.enviadoEm,
    p_payload: envio.bruto,
    p_via: via,
  });
  return { novo: data != null, erro: error?.message ?? null };
}
