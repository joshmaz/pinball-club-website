// Edge Function: photo-upload-intent
//
// Issues a short-lived signed PUT URL for a new photo upload to the
// photos-private bucket. The client never chooses the final object key or
// bucket. Authorization is enforced server-side:
//   1. The caller's JWT must be valid.
//   2. The caller must hold photos_editor / photos_admin / club_admin via
//      snh_member_has_photos_access().
//   3. Inputs (album_id, content type, byte size) are validated.
//
// Flow:
//   client -> POST /functions/v1/photo-upload-intent
//     body: { albumId, contentType, byteSize, originalFilename? }
//   <- 200 { assetId, bucket, objectKey, signedUrl, token, expiresAt }
//
// On success the function inserts a `pending` photo_assets row via
// private.snh_photo_assets_create_pending and creates a signed upload URL
// using service_role's storage admin permissions.
//
// JWT verification is enabled (default); see supabase/config.toml.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);
const MAX_BYTE_SIZE = 50 * 1024 * 1024; // 50 MB upper bound (DB constraint matches)
const SIGNED_URL_TTL_SECONDS = 60 * 5; // 5 minutes

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return preflight();
  }
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
    const userId = userResult.user.id;

    const { data: hasAccess, error: roleErr } = await userClient.rpc(
      "snh_member_has_photos_access",
    );
    if (roleErr) {
      return jsonResponse({ ok: false, error: "role check failed" }, 500);
    }
    if (!hasAccess) {
      return jsonResponse({ ok: false, error: "not authorized" }, 403);
    }

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch (_e) {
      return jsonResponse({ ok: false, error: "invalid json body" }, 400);
    }

    const albumId = String(body.albumId ?? "").trim();
    const contentType = String(body.contentType ?? "").trim().toLowerCase();
    const byteSize = Number(body.byteSize);
    const originalFilename = body.originalFilename != null
      ? String(body.originalFilename).trim().slice(0, 200)
      : null;

    if (!isUuid(albumId)) {
      return jsonResponse({ ok: false, error: "albumId required (uuid)" }, 400);
    }
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return jsonResponse({
        ok: false,
        error: `unsupported contentType (allowed: ${[...ALLOWED_CONTENT_TYPES].join(", ")})`,
      }, 400);
    }
    if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize > MAX_BYTE_SIZE) {
      return jsonResponse({
        ok: false,
        error: `byteSize out of range (1..${MAX_BYTE_SIZE})`,
      }, 400);
    }

    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const { data: pendingResult, error: pendingErr } = await adminClient.rpc(
      "snh_photo_assets_create_pending",
      {
        p_album_id: albumId,
        p_actor_user_id: userId,
        p_content_type: contentType,
        p_byte_size: byteSize,
        p_original_filename: originalFilename,
      },
    );
    if (pendingErr) {
      return jsonResponse({ ok: false, error: pendingErr.message }, 400);
    }

    const pending = pendingResult as Record<string, unknown> | null;
    const objectKey = pending?.objectKey as string | undefined;
    if (!objectKey) {
      return jsonResponse({ ok: false, error: "could not allocate object key" }, 500);
    }

    const signed = await adminClient.storage
      .from("photos-private")
      .createSignedUploadUrl(objectKey);
    if (signed.error || !signed.data) {
      return jsonResponse({
        ok: false,
        error: `signed url failed: ${signed.error?.message ?? "unknown"}`,
      }, 500);
    }

    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();

    return jsonResponse({
      ok: true,
      assetId: pending?.assetId ?? null,
      albumId,
      bucket: "photos-private",
      objectKey,
      signedUrl: signed.data.signedUrl,
      token: signed.data.token,
      contentType,
      byteSize,
      expiresAt,
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
