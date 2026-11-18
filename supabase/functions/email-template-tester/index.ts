import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function serviceKey() {
  try {
    const key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default;
    if (typeof key === "string" && key) return key;
  } catch { /* legacy configuration */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}
type TemplateField = {
  key: string;
  label: string;
  description: string;
  sample: string;
  htmlKey?: string;
  listHtml?: boolean;
  exampleEmail?: boolean;
};
type TemplateDefinition = {
  alias: string;
  name: string;
  description: string;
  fields: TemplateField[];
};
const TEMPLATE_TESTS: Record<string, TemplateDefinition> = {
  "snhpc-member-signup-alert-v1": {
    alias: "snhpc-member-signup-alert-v1",
    name: "New website account notice",
    description: "Informational notice for membership managers when a website account is created.",
    fields: [
      { key: "NEW_USER_NAME", htmlKey: "NEW_USER_NAME_HTML", label: "Fake user name",
        description: "A fictional display name.", sample: "Mina Arcadewell" },
      { key: "NEW_USER_EMAIL", htmlKey: "NEW_USER_EMAIL_HTML", exampleEmail: true, label: "Fake user email",
        description: "A fictional email address ending in @example.com.", sample: "mina.arcadewell@example.com" },
    ],
  },
  "snhpc-account-confirmation-reminder-v1": {
    alias: "snhpc-account-confirmation-reminder-v1",
    name: "Email confirmation reminder",
    description: "One-time reminder for a newly created account that still needs email confirmation.",
    fields: [],
  },
  "snhpc-member-welcome-v1": {
    alias: "snhpc-member-welcome-v1",
    name: "New member welcome",
    description: "One-time welcome after a member first signs in with a confirmed email address.",
    fields: [],
  },
  "snhpc-pinballmap-game-changes-v1": {
    alias: "snhpc-pinballmap-game-changes-v1",
    name: "Pinball Map game changes",
    description: "Informational notice to Games Editors and higher about games added to or removed from the club's Pinball Map location. Additions ask editors to verify metadata, add third-party links, and generate a club description.",
    fields: [
      { key: "ADDED_GAMES", htmlKey: "ADDED_GAMES_HTML", listHtml: true, label: "Games added at the club",
        description: "A short semicolon-separated list of fictional pinball game titles.", sample: "Moonlight Rally; Orbit Wizard" },
      { key: "REMOVED_GAMES", htmlKey: "REMOVED_GAMES_HTML", listHtml: true, label: "Games removed from the club",
        description: "A short semicolon-separated list of fictional pinball game titles.", sample: "Galaxy Quest" },
    ],
  },
};
const AI_MODEL = "gpt-4o-mini";
function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (ch) => entities[ch] || ch);
}
function isExampleEmail(value: string): boolean {
  return /^[^\s@]+@example\.com$/i.test(value);
}
function buildTemplate(definition: TemplateDefinition, values: Record<string, string>, isStaging: boolean) {
  const siteRoot = isStaging ? "https://staging.snhpinballclub.com" : "https://snhpinballclub.com";
  const variables: Record<string, string> = {
    SUBJECT_PREFIX: isStaging ? "[STAGING TEMPLATE TEST] " : "[TEMPLATE TEST] ",
    PREVIEW_BANNER: (isStaging ? "STAGING TEMPLATE TEST" : "TEMPLATE TEST") +
      " — sent only to the configured test inbox with fictional sample data. No member was contacted.",
    SIGNIN_URL: siteRoot + "/signin.html",
    GAMES_URL: siteRoot + "/games.html?view=all",
    EVENTS_URL: siteRoot + "/events.html",
  };
  for (const field of definition.fields) {
    variables[field.key] = values[field.key];
    if (field.htmlKey) {
      if (field.listHtml) {
        const items = values[field.key].split(/[;\n]+/).map((item) => item.trim()).filter(Boolean);
        variables[field.htmlKey] = items.length ? items.map(escapeHtml).join("<br>") : "None.";
      } else variables[field.htmlKey] = escapeHtml(values[field.key]);
    }
  }
  return { id: definition.alias, variables };
}
type SampleResult = { values?: Record<string, string>; error?: string; status?: number };
async function generateSample(db: ReturnType<typeof createClient>, alias: string): Promise<SampleResult> {
  const definition = TEMPLATE_TESTS[alias];
  if (!definition) return { error: "Choose a supported email template.", status: 400 };
  const apiKey = Deno.env.get("OPENAI_PLATFORM_KEY") || "";
  if (!apiKey) return { error: "AI sample generation is not configured.", status: 409 };
  const requestedFields = definition.fields.map((field) => ({ key: field.key, description: field.description }));
  const prompt = "Make fictional sample values for this email-template test. Return one JSON object with exactly these keys and string values: " +
    JSON.stringify(requestedFields) + ". Never use real people or real contact details. Any email address must use the reserved example.com domain. " +
    "Keep examples plausible and friendly. Template context: " + definition.description;
  const inputTokens = Math.ceil((prompt.length + 220) / 3);
  const maxOutputTokens = 120;
  const reservedCost = (((inputTokens * 0.15) + (maxOutputTokens * 0.60)) / 1_000_000) * 1.5;
  const { data: reservationData, error: reserveError } = await db.rpc("snh_ai_usage_reserve", {
    p_feature: "email_template_test_data", p_model: AI_MODEL, p_reserved_usd: reservedCost,
  });
  if (reserveError) return { error: "AI budget check is unavailable. Sample generation was blocked.", status: 503 };
  const reservation = typeof reservationData === "string" ? JSON.parse(reservationData) : reservationData;
  if (!reservation?.allowed) {
    return { error: "The monthly AI budget limit blocks this sample. Use the example values or contact an administrator.", status: 429 };
  }
  const settle = async (usage: { prompt_tokens?: number; completion_tokens?: number } | null, succeeded: boolean, chargeReservation = false) => {
    const actualInput = Number.isInteger(usage?.prompt_tokens) ? Number(usage?.prompt_tokens) : inputTokens;
    const actualOutput = Number.isInteger(usage?.completion_tokens) ? Number(usage?.completion_tokens) : maxOutputTokens;
    const actualCost = usage
      ? (((actualInput * 0.15) + (actualOutput * 0.60)) / 1_000_000)
      : chargeReservation ? reservedCost : 0;
    const { error } = await db.rpc("snh_ai_usage_settle", {
      p_call_id: reservation.id, p_cost_usd: actualCost,
      p_input_tokens: usage ? actualInput : 0, p_output_tokens: usage ? actualOutput : 0,
      p_succeeded: succeeded,
    });
    if (error) throw new Error("AI usage could not be recorded. Sample generation was stopped.");
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let settled = false;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: "Generate clearly fictional test data only. Return valid JSON and follow the requested field descriptions exactly." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: maxOutputTokens,
        temperature: 0.8,
      }),
    });
    const result = await response.json().catch(() => ({}));
    const usage = result?.usage || null;
    if (!response.ok) {
      await settle(usage, false, !usage && response.status >= 500);
      settled = true;
      return {
        error: response.status === 429 ? "OpenAI rate or account limit reached. Use the example values or try again later."
          : response.status === 401 || response.status === 403 ? "OpenAI authentication failed. Check server configuration."
          : "Could not generate sample data. Use the example values or try again.",
        status: 502,
      };
    }
    const raw = result?.choices?.[0]?.message?.content;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : null;
    const values: Record<string, string> = {};
    for (const field of definition.fields) {
      const value = parsed?.[field.key];
      if (typeof value !== "string" || !value.trim() || value.length > 100) {
        await settle(usage, false, !usage); settled = true;
        return { error: "The sample generator returned unusable data. Use the example values or try again.", status: 502 };
      }
      values[field.key] = value.trim();
    }
    if (definition.fields.some((field) => field.exampleEmail && !isExampleEmail(values[field.key] || ""))) {
      await settle(usage, false, !usage); settled = true;
      return { error: "The sample generator returned an email outside the reserved example.com domain. Use the example values or try again.", status: 502 };
    }
    await settle(usage, true, !usage); settled = true;
    return { values };
  } catch {
    if (!settled) {
      try { await settle(null, false, true); } catch { /* Keep an unsettled reservation counted. */ }
    }
    return { error: controller.signal.aborted ? "Sample generation timed out. Use the example values or try again." : "Could not generate sample data. Use the example values or try again.", status: 502 };
  } finally { clearTimeout(timeout); }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  try {
    const bearer = req.headers.get("Authorization") || "";
    if (!bearer.startsWith("Bearer ")) return json({ error: "Sign in required" }, 401);
    const url = Deno.env.get("SUPABASE_URL") || "";
    const key = serviceKey();
    if (!url || !key) return json({ error: "Template tester is not configured." }, 503);
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: auth, error: authError } = await db.auth.getUser(bearer.slice(7));
    if (authError || !auth.user) return json({ error: "Invalid session" }, 401);
    const roles = await db.from("members").select("id,member_roles!inner(role_slug)")
      .eq("user_id", auth.user.id).eq("member_roles.role_slug", "club_admin").limit(1);
    if (roles.error || !roles.data?.length) return json({ error: "Club administrator access required" }, 403);
    const body = await req.json();
    const action = body && typeof body.action === "string" ? body.action : "";
    if (action === "configuration") {
      return json({
        configured: Boolean(Deno.env.get("NOTIFICATION_TEST_EMAIL") && Deno.env.get("RESEND_API_KEY") && Deno.env.get("NOTIFICATION_FROM")),
        ai_sample_configured: Boolean(Deno.env.get("OPENAI_PLATFORM_KEY")),
        templates: Object.values(TEMPLATE_TESTS).map((item) => ({
          alias: item.alias, name: item.name, description: item.description,
          fields: item.fields.map(({ key, label, description, sample }) => ({ key, label, description, sample })),
        })),
      });
    }
    if (action === "generate_sample") {
      const alias = typeof body.alias === "string" ? body.alias : "";
      const result = await generateSample(db, alias);
      if (result.error) return json({ error: result.error }, result.status || 502);
      return json({ values: result.values });
    }
    if (action === "send_test") {
      const alias = typeof body.alias === "string" ? body.alias : "";
      const definition = TEMPLATE_TESTS[alias];
      if (!definition) return json({ error: "Choose a supported email template." }, 400);
      const testEmail = (Deno.env.get("NOTIFICATION_TEST_EMAIL") || "").trim();
      const resendKey = Deno.env.get("RESEND_API_KEY") || "";
      const from = (Deno.env.get("NOTIFICATION_FROM") || "").trim();
      if (!testEmail || !resendKey || !from) return json({ error: "Template testing is unavailable until the test inbox, sender, and Resend key are configured." }, 409);
      const incoming = body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
        ? body.variables as Record<string, unknown> : {};
      const values: Record<string, string> = {};
      for (const field of definition.fields) {
        const raw = incoming[field.key];
        const value = typeof raw === "string" ? raw.trim() : "";
        if (!value || value.length > 100) return json({ error: "Enter a value of 1 to 100 characters for " + field.label + "." }, 400);
        if (field.exampleEmail && !isExampleEmail(value)) return json({ error: "Sample email values must use the reserved example.com domain." }, 400);
        values[field.key] = value;
      }
      const userDb = createClient(url, key, {
        global: { headers: { Authorization: bearer } }, auth: { persistSession: false, autoRefreshToken: false },
      });
      const audit = await userDb.rpc("snh_operations_template_test_request", {
        p_template_alias: alias, p_ai_sample_used: body.aiSampleUsed === true,
      });
      if (audit.error) return json({ error: "Could not record the email test request." }, 503);
      const isStaging = new URL(url).hostname === "eptbdrwmcwogxcjleudv.supabase.co";
      const template = buildTemplate(definition, values, isStaging);
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: "Bearer " + resendKey,
            "Content-Type": "application/json",
            "Idempotency-Key": "template-test-" + crypto.randomUUID(),
          },
          body: JSON.stringify({ from, to: [testEmail], template }),
        });
        if (!response.ok) return json({ error: "Resend could not accept this template test. Check the template and sender configuration." }, 502);
        return json({ ok: true, message: "Template test sent to the configured test inbox. No notification was queued." });
      } catch {
        return json({ error: "Template test timed out or could not be reached. Check Resend logs before retrying." }, 503);
      }
    }
    return json({ error: "Unknown template tester action." }, 400);
  } catch {
    return json({ error: "Template tester could not complete the request." }, 500);
  }
});
