import { createClient } from "https://esm.sh/@supabase/supabase-js@2.56.1";

// Browser origins are explicit and independent of canonical Discord links.
export function allowedPublishingOrigin(origin: string, site: string, configured: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password) return false;
    return [site, ...configured.split(",").map(value => value.trim())].includes(origin);
  } catch { return false; }
}

export function discordPayload(job: any, site: string) {
  const published = job.snapshot;
  return { allowed_mentions: { parse: [] }, embeds: [{
    title: published ? published.title : "Announcement withdrawn",
    description: published ? published.body : "This announcement has been withdrawn by the club.",
    ...(published ? { url: `${site}/announcements.html?id=${encodeURIComponent(job.entry_id)}` } : {}),
    color: 2847347,
    footer: { text: "Southern New Hampshire Pinball Club · Discuss here in Discord" },
  }] };
}

export async function deliver(job: any, webhook: string, site: string, request = fetch) {
  const edit = !!job.message_id;
  const endpoint = edit ? `${webhook}/messages/${job.message_id}` : `${webhook}?wait=true`;
  try {
    const result = await request(endpoint, { method: edit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(discordPayload(job, site)),
      signal: AbortSignal.timeout(20000) });
    if (!result.ok) return { status: !edit && result.status >= 500 ? "uncertain" : "failed",
      error: `Discord HTTP ${result.status}` };
    const message = await result.json();
    if (!/^[0-9]{15,25}$/.test(message.id) || !/^[0-9]{15,25}$/.test(message.channel_id)) {
      return { status: edit ? "failed" : "uncertain", error: "Discord response lacked a valid message identity" };
    }
    return { status: "shared", id: message.id, channel: message.channel_id };
  } catch {
    return { status: edit ? "failed" : "uncertain", error: "Discord delivery interrupted; check the channel before retrying a new post" };
  }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const site = (Deno.env.get("PUBLISHING_SITE_URL") || "").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store",
    ...(allowedPublishingOrigin(origin, site, Deno.env.get("PUBLISHING_ALLOWED_ORIGINS") || "") ? { "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" } : {}) };
  const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply({ error: "POST required" }, 405);
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !key) return reply({ error: "Server configuration missing" }, 503);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const schedulerSecret = Deno.env.get("PUBLISHING_DISPATCH_SECRET");
  const scheduled = schedulerSecret && req.headers.get("x-publishing-secret") === schedulerSecret;
  if (!scheduled) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer /i, "");
    const user = await db.auth.getUser(token);
    if (user.error || !user.data.user) return reply({ error: "Sign in required" }, 401);
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") || "", {
      global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    const access = await caller.rpc("snh_member_has_publishing_access");
    if (access.error || access.data !== true) return reply({ error: "Publishing access required" }, 403);
  }
  if (Deno.env.get("PUBLISHING_DISCORD_MODE") !== "live") return reply({ mode: "preview", sent: 0, configured: false });
  const webhook = Deno.env.get("PUBLISHING_DISCORD_WEBHOOK") || "";
  const guild = Deno.env.get("PUBLISHING_DISCORD_GUILD_ID") || "";
  const channel = Deno.env.get("PUBLISHING_DISCORD_CHANNEL_ID") || "";
  if (!/^https:\/\/discord\.com\/api\/webhooks\/[0-9]{15,25}\/[A-Za-z0-9_-]+$/.test(webhook)
    || !/^[0-9]{15,25}$/.test(channel) || !/^[0-9]{15,25}$/.test(guild) || !/^https:\/\/[^/?#]+$/.test(site)) return reply({ error: "Discord delivery is not configured" }, 409);
  // Validate destination before any claim/post, including staging isolation.
  try {
    const metadata = await fetch(webhook, { signal: AbortSignal.timeout(10000) });
    if (!metadata.ok) return reply({ error: "Could not verify Discord destination" }, 409);
    const target = await metadata.json();
    if (target.guild_id !== guild || target.channel_id !== channel) return reply({ error: "Discord webhook does not match the configured test destination" }, 409);
  } catch { return reply({ error: "Could not verify Discord destination" }, 503); }
  const config = await db.from("publishing_discord_config").upsert({ id: true, guild_id: guild, channel_id: channel });
  if (config.error) return reply({ error: "Could not record public Discord server identity" }, 503);
  let sent = 0, failed = 0;
  for (let i = 0; i < 3; i++) {
    const claim = await db.rpc("snh_claim_publishing_discord");
    if (claim.error) return reply({ error: "Could not claim delivery", sent, failed }, 503);
    const job = claim.data;
    if (!job) break;
    if (job.skip) continue;
    const result = await deliver(job, webhook, site);
    const finish = await db.rpc("snh_finish_publishing_discord", { p_id: job.entry_id, p_lease: job.lease_id,
      p_revision: job.revision, p_status: result.status, p_message_id: result.id || null,
      p_channel_id: result.channel || null, p_error: result.error || null });
    if (finish.error || !finish.data) return reply({ error: "Delivery result could not be recorded; check Discord before reconciling", sent, failed }, 503);
    if (result.status === "shared") sent++; else failed++;
  }
  return reply({ sent, failed, configured: true });
});
