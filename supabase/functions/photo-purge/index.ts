// Edge Function: photo-purge
//
// Wraps unpublish / delete operations: invokes the corresponding RPC under
// the caller's JWT (so role checks and audit happen with the right actor),
// then uses service_role to remove the storage objects the RPC reported as
// safe to purge.
//
// Workflow:
//   client -> POST /functions/v1/photo-purge
//     body: { assetId, action: "unpublish" | "delete" }
//   <- 200 { ok, action, removedPublic: number, removedPrivate: number }
//
// Authorization is enforced inside the RPCs (snh_member_has_photos_access for
// unpublish, snh_member_has_photos_admin_access for delete).
//
// JWT verification is enabled via supabase/config.toml.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return jsonResponse({ ok: false, error: "missing supabase env" }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return jsonResponse({ ok: false, error: "missing bearer token" }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userResult, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userResult?.user) {
      return jsonResponse({ ok: false, error: "invalid session" }, 401);
    }

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch (_e) {
      return jsonResponse({ ok: false, error: "invalid json body" }, 400);
    }

    const assetId = String(body.assetId ?? "").trim();
    const action = String(body.action ?? "").trim().toLowerCase();
    if (!isUuid(assetId)) {
      return jsonResponse({ ok: false, error: "assetId required (uuid)" }, 400);
    }
    if (action !== "unpublish" && action !== "delete") {
      return jsonResponse({
        ok: false,
        error: "action must be 'unpublish' or 'delete'",
      }, 400);
    }

    // Use the user JWT so the RPC's role check and audit log capture the
    // correct actor; the RPC itself enforces authorization.
    const rpcName = action === "delete"
      ? "snh_photo_asset_delete"
      : "snh_photo_asset_unpublish";
    const { data: rpcResult, error: rpcErr } = await userClient.rpc(rpcName, {
      p_asset_id: assetId,
    });
    if (rpcErr) {
      return jsonResponse({ ok: false, error: rpcErr.message }, 400);
    }

    const result = (rpcResult ?? {}) as Record<string, unknown>;
    const publicKeys = Array.isArray(result.publicObjectKeysToPurge)
      ? (result.publicObjectKeysToPurge as string[])
      : [];
    const privateKeys = action === "delete" && Array.isArray(result.privateObjectKeysToPurge)
      ? (result.privateObjectKeysToPurge as string[])
      : [];

    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    let removedPublic = 0;
    if (publicKeys.length > 0) {
      const purge = await adminClient.storage.from("photos-public").remove(publicKeys);
      if (!purge.error) {
        removedPublic = (purge.data ?? []).length;
      }
    }

    let removedPrivate = 0;
    if (privateKeys.length > 0) {
      const purge = await adminClient.storage.from("photos-private").remove(privateKeys);
      if (!purge.error) {
        removedPrivate = (purge.data ?? []).length;
      }
    }

    return jsonResponse({
      ok: true,
      action,
      assetId,
      removedPublic,
      removedPrivate,
      requestedPublic: publicKeys.length,
      requestedPrivate: privateKeys.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});

function preflight() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
