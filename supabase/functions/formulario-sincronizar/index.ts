// Busca no Tally os envios que o aviso não entregou (roda de hora em hora pelo pg_cron).
// Publicar com:  supabase functions deploy formulario-sincronizar --no-verify-jwt
// Só aceita chamadas com o segredo guardado no Vault do Supabase (nome: crm_sincronizacao).
//
// Secrets necessários (supabase secrets set ...):
//   TALLY_API_KEY   — chave da API do Tally (Settings → API keys). SECRETA.
//   TALLY_FORM_IDS  — (opcional) ids dos formulários, separados por vírgula. Vazio = todos.

import { clienteSupabase, deApi, FORMULARIOS, gravarEnvio } from "../_shared/tally.ts";

const API = "https://api.tally.so";
const CHAVE = Deno.env.get("TALLY_API_KEY") ?? "";
const MAX_PAGINAS = 20;
const supabase = clienteSupabase();

// deno-lint-ignore no-explicit-any
async function tally(caminho: string): Promise<any> {
  const r = await fetch(API + caminho, { headers: { Authorization: `Bearer ${CHAVE}` } });
  if (!r.ok) throw new Error(`Tally respondeu ${r.status} em ${caminho}`);
  return r.json();
}

async function listarFormularios(): Promise<{ id: string; nome: string }[]> {
  if (FORMULARIOS.length) {
    return Promise.all(FORMULARIOS.map(async (id) => {
      const f = await tally(`/forms/${encodeURIComponent(id)}`);
      return { id, nome: String(f?.name ?? "Formulário") };
    }));
  }
  const todos: { id: string; nome: string }[] = [];
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const r = await tally(`/forms?page=${p}`);
    const itens = Array.isArray(r) ? r : (r?.items ?? r?.forms ?? []);
    // deno-lint-ignore no-explicit-any
    for (const f of itens) if (f?.id) todos.push({ id: String(f.id), nome: String(f.name ?? "Formulário") });
    if (Array.isArray(r) || !r?.hasMore) break;
  }
  return todos;
}

// Data de onde começar: último envio que já temos desse formulário, com 2 dias de folga.
async function desde(formId: string): Promise<string> {
  const { data } = await supabase.from("envios_formulario").select("enviado_em")
    .eq("form_id", formId).order("enviado_em", { ascending: false }).limit(1);
  const base = data?.[0]?.enviado_em ? new Date(data[0].enviado_em) : new Date(Date.now() - 30 * 864e5);
  return new Date(base.getTime() - 2 * 864e5).toISOString();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const { data: ok } = await supabase.rpc("conferir_segredo_sincronizacao", {
    p_segredo: req.headers.get("x-sync-secret") ?? "",
  });
  if (ok !== true) return new Response("forbidden", { status: 403 });
  if (!CHAVE) return new Response("TALLY_API_KEY não configurada", { status: 500 });

  const resumo = { formularios: 0, verificados: 0, novos: 0, erros: [] as string[] };
  try {
    for (const form of await listarFormularios()) {
      resumo.formularios++;
      const inicio = await desde(form.id);
      for (let p = 1; p <= MAX_PAGINAS; p++) {
        const r = await tally(
          `/forms/${encodeURIComponent(form.id)}/submissions?filter=completed&page=${p}&startDate=${encodeURIComponent(inicio)}`,
        );
        for (const sub of r?.submissions ?? []) {
          resumo.verificados++;
          const { novo, erro } = await gravarEnvio(supabase, deApi(sub, r?.questions ?? [], form.id, form.nome), "busca");
          if (novo) resumo.novos++;
          if (erro) resumo.erros.push(`${sub?.id}: ${erro}`);
        }
        if (!r?.hasMore) break;
      }
    }
  } catch (e) {
    resumo.erros.push(String(e instanceof Error ? e.message : e));
  }

  if (resumo.erros.length) console.error("sincronização com erros", resumo.erros);
  return new Response(JSON.stringify(resumo), {
    status: resumo.erros.length ? 500 : 200,
    headers: { "content-type": "application/json" },
  });
});
