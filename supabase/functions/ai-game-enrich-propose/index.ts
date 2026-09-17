import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type GameRow = {
  id: string;
  slug: string;
  title: string;
  details: string | null;
  release_date: string | null;
  manufacture_date: string | null;
  manufacturer: string | null;
  manufacturer_full_name: string | null;
  machine_type: string | null;
  display_type: string | null;
  player_count: number | null;
  pinside_url: string | null;
  ipdb_url: string | null;
  kineticist_url: string | null;
  opdb_id: string | null;
  updated_at: string;
};

type ProposalFieldKey =
  | "details"
  | "pinsideUrl"
  | "ipdbUrl"
  | "kineticistUrl";

type ProposalConfidence = "low" | "medium" | "high";
type ProposalStatus = "ok" | "needs_review" | "unavailable" | "budget_limit_reached";

type ProposalField = {
  field: ProposalFieldKey;
  currentValue: string | null;
  suggestedValue: string | null;
  confidence: ProposalConfidence;
  confidenceScore: number;
  reason: string;
  sourceType: string;
  sourceUrl: string | null;
  warnings: string[];
  reviewRequired: boolean;
  applyByDefault: boolean;
};

type EnrichmentRequest = {
  gameId: string;
  regenerateDescription?: boolean;
  runContext?: {
    requestId?: string;
    proposalVariant?: number;
  };
};

type EnrichmentResponse = {
  proposalVersion: "1.1";
  runId: string;
  status: ProposalStatus;
  model: { provider: string; model: string; fallbackUsed: boolean };
  recordVersion: string;
  thresholds: {
    details: number;
    links: number;
  };
  game: {
    id: string;
    slug: string;
    title: string;
  };
  fields: ProposalField[];
  regenerationLimits: {
    descriptionRemaining: number;
  };
  warnings: string[];
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FALLBACK_IPDB_SEARCH = "https://www.ipdb.org/search.pl?searchtype=quick&searchstr=";
const FALLBACK_PINSIDE_SEARCH = "https://pinside.com/pinball/machine?query=";
const FALLBACK_KINETICIST_SEARCH = "https://www.kineticist.com/search?q=";
const PINSIDE_MACHINE_BASE = "https://pinside.com/pinball/machine/";
const KINETICIST_GAME_BASE = "https://www.kineticist.com/games/pinball/";

const THRESHOLDS = {
  details: 0.68,
  links: 0.82,
};

const DESCRIPTION_REGEN_LIMIT = 2;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = mustEnv("SUPABASE_URL");
    const serviceRoleKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    if (!jwt) {
      return json({ ok: false, error: "Missing bearer token" }, 401);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const authResult = await admin.auth.getUser(jwt);
    if (authResult.error || !authResult.data.user) {
      return json({ ok: false, error: "Invalid auth token" }, 401);
    }
    const actorUserId = authResult.data.user.id;

    const body = (await req.json()) as EnrichmentRequest;
    if (!body || !body.gameId) {
      return json({ ok: false, error: "gameId is required" }, 400);
    }

    const canAccess = await userHasAnyRole(admin, actorUserId, ["games_editor", "games_admin", "club_admin"]);
    if (!canAccess) {
      return json({ ok: false, error: "Not authorized for game enrichment" }, 403);
    }

    const game = await loadGame(admin, body.gameId);
    if (!game) {
      return json({ ok: false, error: "Game not found" }, 404);
    }

    const runId = crypto.randomUUID();
    const fallbackUsed = { value: false };
    const warnings: string[] = [];
    const modelResult = await buildDescriptionSuggestion(game, fallbackUsed, warnings);
    const linkFields = buildLinkSuggestions(game);

    const fields: ProposalField[] = [
      modelResult,
      ...linkFields,
    ];

    const response: EnrichmentResponse = {
      proposalVersion: "1.1",
      runId,
      status: warnings.some((w) => w.includes("unavailable")) ? "needs_review" : "ok",
      model: {
        provider: "openai",
        model: modelResult.sourceType,
        fallbackUsed: fallbackUsed.value,
      },
      recordVersion: game.updated_at,
      thresholds: THRESHOLDS,
      game: { id: game.id, slug: game.slug, title: game.title },
      fields,
      regenerationLimits: {
        descriptionRemaining: DESCRIPTION_REGEN_LIMIT,
      },
      warnings,
    };

    await writeAudit(admin, {
      runId,
      actorUserId,
      game,
      request: body,
      response,
    });

    return json(response, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 500);
  }
});

function mustEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function json(body: Json | Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function userHasAnyRole(
  admin: ReturnType<typeof createClient>,
  userId: string,
  roleSlugs: string[],
): Promise<boolean> {
  const memberRes = await admin.from("members").select("id").eq("user_id", userId).maybeSingle();
  if (memberRes.error || !memberRes.data?.id) return false;
  const rolesRes = await admin
    .from("member_roles")
    .select("role_slug")
    .eq("member_id", memberRes.data.id)
    .in("role_slug", roleSlugs)
    .limit(1);
  if (rolesRes.error) return false;
  return (rolesRes.data || []).length > 0;
}

async function loadGame(admin: ReturnType<typeof createClient>, gameId: string): Promise<GameRow | null> {
  const res = await admin
    .from("games")
    .select(
      "id,slug,title,details,release_date,manufacture_date,manufacturer,manufacturer_full_name,machine_type,display_type,player_count,pinside_url,ipdb_url,kineticist_url,opdb_id,updated_at",
    )
    .eq("id", gameId)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  return (res.data as GameRow | null) || null;
}

function sanitizeDescription(text: string): string {
  const cleaned = text
    // Collapse excessive whitespace.
    .replace(/\s+/g, " ")
    // Strip common hype words that slip through.
    .replace(/\b(awesome|ultimate|best ever|must-play)\b/gi, "")
    // Drop trim / edition tags like "(Pro)", "(Premium)", "(LE)" from prose.
    .replace(/\s*\((pro|premium|le|limited edition|collectors edition)\)\b/gi, "")
    .trim();
  return cleaned;
}

function metadataConsistencyWarnings(game: GameRow, description: string): string[] {
  const warnings: string[] = [];
  const lower = description.toLowerCase();
  if (game.manufacturer && !lower.includes(game.manufacturer.toLowerCase())) {
    warnings.push("Description should include manufacturer to match metadata conventions.");
  }
  const year = game.release_date ? game.release_date.slice(0, 4) : "";
  if (year && !lower.includes(year)) {
    warnings.push("Description should include release year to match metadata conventions.");
  }
  return warnings;
}

async function buildDescriptionSuggestion(
  game: GameRow,
  fallbackUsed: { value: boolean },
  warnings: string[],
): Promise<ProposalField> {
  const primaryModel = Deno.env.get("LLM_PRIMARY_MODEL") || "gpt-4o-mini";
  const secondaryModel = Deno.env.get("LLM_SECONDARY_MODEL") || "gpt-4.1-mini";
  const apiKey = Deno.env.get("OPENAI_PLATFORM_KEY") || Deno.env.get("LLM_API_KEY") || "";
  let draft = game.details || "";
  let sourceType = `openai:${primaryModel}`;
  let confidenceScore = 0.72;

  if (!apiKey) {
    warnings.push("LLM unavailable: missing API key, using deterministic fallback.");
    draft = buildFallbackDescription(game);
    confidenceScore = 0.55;
    sourceType = "fallback:deterministic";
  } else {
    const researchedContext = await buildDescriptionResearchContext(game);
    const prompt = buildDescriptionPrompt(game, researchedContext);
    const primary = await callOpenAI(primaryModel, prompt, apiKey);
    if (!primary.ok && shouldFallback(primary.status)) {
      const secondary = await callOpenAI(secondaryModel, prompt, apiKey);
      fallbackUsed.value = secondary.ok;
      if (secondary.ok && secondary.text) {
        draft = secondary.text;
        sourceType = `openai:${secondaryModel}`;
        warnings.push(`Primary model failed: ${primary.reason} Secondary model was used.`);
      } else {
        warnings.push(
          `OpenAI unavailable after fallback. Primary: ${primary.reason} Secondary: ${secondary.reason} Using deterministic fallback.`,
        );
        draft = buildFallbackDescription(game);
        confidenceScore = 0.55;
        sourceType = "fallback:deterministic";
      }
    } else if (primary.ok && primary.text) {
      draft = primary.text;
    } else {
      warnings.push(`${primary.reason} Using deterministic fallback.`);
      draft = buildFallbackDescription(game);
      confidenceScore = 0.55;
      sourceType = "fallback:deterministic";
    }
  }

  const suggested = sanitizeDescription(draft);
  const brevity = enforceDescriptionBrevity(suggested);
  const metadataWarnings = metadataConsistencyWarnings(game, brevity.text);
  const genericWarnings = genericCopyWarnings(brevity.text);
  const warningList = [...metadataWarnings, ...genericWarnings, ...brevity.warnings];
  if (brevity.text.length < 60) {
    warningList.push("Description is short. Consider regenerating for richer gameplay context.");
    confidenceScore = Math.min(confidenceScore, 0.64);
  }
  if (genericWarnings.length) {
    confidenceScore = Math.min(confidenceScore, 0.6);
  }
  const reviewRequired = confidenceScore < THRESHOLDS.details || warningList.length > 0;

  return {
    field: "details",
    currentValue: game.details,
    suggestedValue: brevity.text,
    confidence: mapConfidence(confidenceScore),
    confidenceScore,
    reason:
      "Grounded in structured fields and any existing catalog description; specificity is prioritized over filler.",
    sourceType,
    sourceUrl: null,
    warnings: warningList,
    reviewRequired,
    applyByDefault: !reviewRequired,
  };
}

function buildDescriptionPrompt(game: GameRow, researchedContext: string): string {
  const existing = (game.details || "").trim();
  const targetLen = 270;

  const structured = [
    `Title (often includes trim or edition): ${game.title}`,
    `Manufacturer (canonical field): ${game.manufacturer || "unknown"}`,
    `Release year (canonical field): ${game.release_date ? game.release_date.slice(0, 4) : "unknown"}`,
    `Layout family label: ${game.machine_type || "unknown"}`,
    `Display hardware: ${game.display_type || "unknown"}`,
    `Max players (canonical field): ${game.player_count ?? "unknown"}`,
  ].join("\n");

  return [
    "You write concise pinball cabinet descriptions for a community club catalog. Output plain text only: one paragraph, 2 to 4 sentences.",
    "",
    "Substance rules (critical):",
    "- Lead with gameplay identity tied to THIS title: notable shots or flow, rules hooks, ramps or subway tunnels, magnets, scoop or VUK, toy or bash target, coder or designer attributions ONLY when supplied below, Insider Connected vs DMD distinctions, soundtrack or theme hooks that are spelled out.",
    '- If \"EXISTING CATALOG DESCRIPTION\" below has concrete facts lists (flippers ramps designers LCD names), KEEP that substance: you may edit for brevity, clarity, grammar, reading order; do NOT replace it with generic marketing language.',
    '- Ban empty stock phrases unless each one names a referenced feature from the facts: phrases like vibrant display, dynamic gameplay, engaging blend of, fast paced action plus community fun, thrilling paths, varied mechanical elements, skill based challenges designed to enhance.',
    "- Avoid hype (best ever, ultimate, iconic, perfect for friends tournaments) unless a supplied fact plainly supports it.",
    "- Include manufacturer and release year in the description when available, ideally in the opening clause, so card copy matches metadata conventions.",
    "- If something is uncertain and not evidenced below, omit it or hedge (\"often described as\"; \"needs verification\") instead of guessing.",
    "- Include title-specific identity such as theme framing (for example sports, music, horror, sci-fi) when supported by supplied evidence.",
    `- Keep it concise but substantive. Target about ${targetLen} characters (roughly 220 to 320 max).`,
    "",
    "STRUCTURED CATALOG FIELDS",
    structured,
    "",
    "TRUSTED REFERENCE SNIPPETS",
    researchedContext || "(no additional trusted snippets were retrieved)",
    "",
    existing
      ? `EXISTING CATALOG DESCRIPTION (preserve its factual specificity)\n${existing}`
      : "EXISTING CATALOG DESCRIPTION\n(none supplied; rely on structured fields above and stay conservative.)",
    "",
    "Rewrite into the strongest final paragraph.",
  ].join("\n");
}

function enforceDescriptionBrevity(suggested: string): { text: string; warnings: string[] } {
  const maxLen = 320;
  if (suggested.length <= maxLen) return { text: suggested, warnings: [] };

  const sentences = suggested.match(/[^.!?]+[.!?]?/g) || [suggested];
  let acc = "";
  for (const sentence of sentences) {
    const next = (acc ? `${acc} ` : "") + sentence.trim();
    if (next.length > maxLen) break;
    acc = next;
  }

  const trimmed = acc.trim() || suggested.slice(0, maxLen).trim().replace(/[,\s]+$/, "");
  return {
    text: trimmed,
    warnings: ["Suggestion trimmed to target card-friendly length."],
  };
}

async function buildDescriptionResearchContext(game: GameRow): Promise<string> {
  const refs: Array<{ label: string; url: string | null }> = [
    { label: "IPDB", url: game.ipdb_url },
    { label: "Pinside", url: game.pinside_url },
    { label: "Kineticist", url: game.kineticist_url },
  ];
  const snippets = await Promise.all(
    refs.map(async (r) => {
      if (!r.url || !isLikelyHttpUrl(r.url)) return "";
      const summary = await fetchReferenceSummary(r.url);
      if (!summary) return "";
      return `- ${r.label}: ${summary}`;
    }),
  );
  return snippets.filter(Boolean).join("\n");
}

function isLikelyHttpUrl(value: string): boolean {
  const v = value.trim();
  return /^https?:\/\//i.test(v);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function firstMatch(input: string, regex: RegExp): string {
  const m = input.match(regex);
  return m && m[1] ? stripHtmlToText(m[1]).slice(0, 240) : "";
}

async function fetchReferenceSummary(url: string): Promise<string> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return "";
    const html = await res.text();
    if (!html) return "";
    const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const metaDesc =
      firstMatch(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
      firstMatch(html, /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    const h1 = firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const composed = [title, h1, metaDesc].filter(Boolean).join(" | ");
    return composed.slice(0, 320);
  } catch {
    return "";
  } finally {
    clearTimeout(tid);
  }
}

function genericCopyWarnings(description: string): string[] {
  const lower = description.toLowerCase();
  const bannedPhrases = [
    "engaging blend",
    "dynamic gameplay",
    "vibrant color display",
    "making each game session dynamic and enjoyable",
    "skill-based challenges",
    "community fun",
    "thrilling paths",
    "enhance interaction",
  ];
  const hits = bannedPhrases.filter((p) => lower.includes(p));
  if (!hits.length) return [];
  return [`Description uses generic filler phrases: ${hits.join(", ")}.`];
}

function buildFallbackDescription(game: GameRow): string {
  const bits: string[] = [];
  bits.push(`${game.title} is part of the club lineup.`);
  if (game.machine_type) bits.push(`It is a ${game.machine_type.toUpperCase()} era machine.`);
  if (game.player_count) bits.push(`It supports up to ${game.player_count} players.`);
  bits.push("Gameplay notes can be refined by an editor after reviewing trusted references.");
  return bits.join(" ");
}

type OpenAIResult = { ok: boolean; text: string; status: number; reason: string };

function openAIErrorReason(status: number, code = "", type = ""): string {
  const marker = `${code} ${type}`.toLowerCase();
  if (status === 401 || status === 403) return "OpenAI authentication failed; check OPENAI_PLATFORM_KEY.";
  if (status === 429 && /insufficient_quota|quota|billing/.test(marker)) {
    return "OpenAI quota or billing limit reached.";
  }
  if (status === 429) return "OpenAI rate limit reached; try again shortly.";
  if (status === 404 || marker.includes("model_not_found")) {
    return "OpenAI model unavailable or not enabled for this account.";
  }
  if (status === 408) return "OpenAI request timed out.";
  if (status >= 500) return "OpenAI service is temporarily unavailable.";
  if (status === 0) return "Could not reach OpenAI.";
  return `OpenAI request rejected (HTTP ${status}).`;
}

async function callOpenAI(
  model: string,
  prompt: string,
  apiKey: string,
): Promise<OpenAIResult> {
  const controller = new AbortController();
  const timeoutMs = 45_000;
  const tid = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.45,
      }),
    });

    if (!response.ok) {
      let code = "";
      let type = "";
      try {
        const errorBody = (await response.json()) as { error?: { code?: string; type?: string } };
        code = String(errorBody.error?.code || "");
        type = String(errorBody.error?.type || "");
      } catch {
        // Keep provider response bodies private; status alone is enough for a safe diagnostic.
      }
      return {
        ok: false,
        text: "",
        status: response.status,
        reason: openAIErrorReason(response.status, code, type),
      };
    }

    const jsonBody = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };

    const text = String(jsonBody?.choices?.[0]?.message?.content ?? "").trim();
    return {
      ok: !!text,
      text,
      status: response.status,
      reason: text ? "" : "OpenAI returned an empty response.",
    };
  } catch (_e) {
    const status = controller.signal.aborted ? 408 : 0;
    return { ok: false, text: "", status, reason: openAIErrorReason(status) };
  } finally {
    clearTimeout(tid);
  }
}

function shouldFallback(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function buildLinkSuggestions(game: GameRow): ProposalField[] {
  return [
    buildLinkField("ipdbUrl", game.ipdb_url, guessIpdbUrl(game)),
    buildLinkField("pinsideUrl", game.pinside_url, guessPinsideUrl(game)),
    buildLinkField("kineticistUrl", game.kineticist_url, guessKineticistUrl(game)),
  ];
}

function buildLinkField(
  field: "ipdbUrl" | "pinsideUrl" | "kineticistUrl",
  currentValue: string | null,
  guess: { value: string | null; reason: string; sourceUrl: string | null; score: number; warnings: string[] },
): ProposalField {
  const score = currentValue ? 0.99 : guess.score;
  const warnings = currentValue ? [] : guess.warnings;
  const reviewRequired = score < THRESHOLDS.links || warnings.length > 0;
  return {
    field,
    currentValue,
    suggestedValue: currentValue || guess.value,
    confidence: mapConfidence(score),
    confidenceScore: score,
    reason: currentValue ? "Existing link retained." : `Unverified candidate: ${guess.reason}`,
    sourceType: currentValue ? "existing" : "resolver",
    sourceUrl: currentValue || guess.sourceUrl,
    warnings,
    reviewRequired,
    applyByDefault: !currentValue && !reviewRequired,
  };
}

function guessIpdbUrl(game: GameRow) {
  const query = encodeURIComponent(game.title);
  return {
    value: `${FALLBACK_IPDB_SEARCH}${query}`,
    reason: "Fallback search link generated from title; exact machine match needs review.",
    sourceUrl: `${FALLBACK_IPDB_SEARCH}${query}`,
    score: 0.4,
    warnings: ["Generated as a search URL, not a canonical game record link."],
  };
}

function stripTitleEditionForSlug(title: string): string {
  return title
    .replace(/\s*\((pro|premium|le|limited edition|collectors edition|se|ce)\)\s*$/i, "")
    .trim();
}

/** Pinside and Kineticist use hyphenated slugs; prefer catalog slug when it is already safe. */
function machineSlugForExternalLinks(game: GameRow): string {
  const raw = (game.slug || "").trim().toLowerCase();
  if (raw && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw)) {
    return raw;
  }
  let t = stripTitleEditionForSlug((game.title || "").trim());
  const colon = t.indexOf(":");
  if (colon > 0 && colon < 48) {
    t = t.slice(0, colon).trim();
  }
  return t
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function releaseYear(game: GameRow): string {
  const d = game.release_date;
  if (!d) return "";
  const y = String(d).trim().slice(0, 4);
  return /^\d{4}$/.test(y) ? y : "";
}

function guessPinsideUrl(game: GameRow) {
  const slug = machineSlugForExternalLinks(game);
  if (slug) {
    const canonical = `${PINSIDE_MACHINE_BASE}${encodeURIComponent(slug)}`;
    return {
      value: canonical,
      reason: "Canonical Pinside path from catalog slug or title; open to confirm it matches this machine.",
      sourceUrl: canonical,
      score: 0.68,
      warnings: ["If this 404s, use Pinside search and paste the real /pinball/machine/… URL."],
    };
  }
  const query = encodeURIComponent(game.title);
  return {
    value: `${FALLBACK_PINSIDE_SEARCH}${query}`,
    reason: "Fallback search link; could not derive a safe machine slug from the title.",
    sourceUrl: `${FALLBACK_PINSIDE_SEARCH}${query}`,
    score: 0.4,
    warnings: ["Generated as a search URL, not a canonical machine page."],
  };
}

function guessKineticistUrl(game: GameRow) {
  const slug = machineSlugForExternalLinks(game);
  const year = releaseYear(game);
  if (slug) {
    const path = year ? `${slug}-${year}` : slug;
    const canonical = `${KINETICIST_GAME_BASE}${path}`;
    return {
      value: canonical,
      reason:
        "Canonical Kineticist games path from slug and release year when available; open to confirm (some listings omit year suffix).",
      sourceUrl: canonical,
      score: year ? 0.62 : 0.55,
      warnings: [
        year
          ? "If this 404s, try the site search or adjust year suffix; shared franchise pages need manual URL."
          : "Year unknown for slug suffix; add release date or paste Kineticist URL manually.",
      ],
    };
  }
  const query = encodeURIComponent(game.title);
  return {
    value: `${FALLBACK_KINETICIST_SEARCH}${query}`,
    reason: "Fallback search link; could not derive a slug from title.",
    sourceUrl: `${FALLBACK_KINETICIST_SEARCH}${query}`,
    score: 0.35,
    warnings: ["Generated as a search URL. Enter slug manually after locating the game."],
  };
}

function mapConfidence(score: number): ProposalConfidence {
  if (score >= 0.82) return "high";
  if (score >= 0.62) return "medium";
  return "low";
}

async function writeAudit(
  admin: ReturnType<typeof createClient>,
  params: {
    runId: string;
    actorUserId: string;
    game: GameRow;
    request: EnrichmentRequest;
    response: EnrichmentResponse;
  },
) {
  const payload = {
    module: "games",
    action: "ai_proposal",
    actor_user_id: params.actorUserId,
    entity_type: "game",
    entity_id: params.game.id,
    old_data: {
      details: params.game.details,
      pinside_url: params.game.pinside_url,
      ipdb_url: params.game.ipdb_url,
      kineticist_url: params.game.kineticist_url,
      updated_at: params.game.updated_at,
    },
    new_data: {
      proposalVersion: params.response.proposalVersion,
      fields: params.response.fields,
    },
    metadata: {
      runId: params.runId,
      request: params.request,
      status: params.response.status,
      thresholds: params.response.thresholds,
      model: params.response.model,
    },
    request_id: params.runId,
  };

  await admin.from("audit_log").insert(payload);
}
