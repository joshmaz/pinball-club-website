// Edge Function: photo-publish
//
// Generates server-side derivatives for a photo asset, copies them into the
// photos-public bucket, records variant rows, and (optionally) flips the
// asset to 'published'. Strips EXIF and re-encodes through imagescript so
// nothing from the original metadata leaks to public consumers.
//
// Workflow:
//   client -> POST /functions/v1/photo-publish
//     body: { assetId, publish?: boolean }
//   <- 200 { ok, assetId, variants: [...], status }
//
// Authorization:
//   - Caller must hold a JWT.
//   - Caller must hold photos_editor / photos_admin / club_admin via
//     snh_member_has_photos_access().
//
// JWT verification is enabled via supabase/config.toml.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
// imagescript: pure-Deno image decode/encode/resize. Strips EXIF on re-encode.
import {
  decode as decodeImage,
  Image,
} from "https://deno.land/x/imagescript@1.2.17/mod.ts";

const WEB_MAX_DIMENSION = 1600;
const THUMB_MAX_DIMENSION = 480;
const JPEG_QUALITY = 85;

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

    const { data: hasAccess, error: roleErr } = await userClient.rpc(
      "snh_member_has_photos_access",
    );
    if (roleErr) return jsonResponse({ ok: false, error: "role check failed" }, 500);
    if (!hasAccess) return jsonResponse({ ok: false, error: "not authorized" }, 403);

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch (_e) {
      return jsonResponse({ ok: false, error: "invalid json body" }, 400);
    }

    const assetId = String(body.assetId ?? "").trim();
    const shouldPublish = body.publish !== false;
    if (!isUuid(assetId)) {
      return jsonResponse({ ok: false, error: "assetId required (uuid)" }, 400);
    }

    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const { data: assetRow, error: assetErr } = await adminClient
      .from("photo_assets")
      .select(
        "id, album_id, scope_type, scope_id, status, original_object_key, original_content_type",
      )
      .eq("id", assetId)
      .maybeSingle();
    if (assetErr) return jsonResponse({ ok: false, error: assetErr.message }, 500);
    if (!assetRow) return jsonResponse({ ok: false, error: "asset not found" }, 404);
    if (!assetRow.original_object_key) {
      return jsonResponse({
        ok: false,
        error: "asset has no original object key (upload not finalized)",
      }, 400);
    }

    const downloadResult = await adminClient.storage
      .from("photos-private")
      .download(assetRow.original_object_key);
    if (downloadResult.error || !downloadResult.data) {
      return jsonResponse({
        ok: false,
        error: `download failed: ${downloadResult.error?.message ?? "unknown"}`,
      }, 500);
    }

    const buffer = new Uint8Array(await downloadResult.data.arrayBuffer());

    let decoded: Image;
    try {
      const result = await decodeImage(buffer);
      if (!(result instanceof Image)) {
        // GIF / multi-frame returns a non-Image; we don't support that here.
        return jsonResponse({
          ok: false,
          error: "unsupported image format (multi-frame)",
        }, 400);
      }
      decoded = result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ ok: false, error: `decode failed: ${msg}` }, 400);
    }

    const variants = await Promise.all([
      buildVariant(decoded, "web", WEB_MAX_DIMENSION),
      buildVariant(decoded, "thumb", THUMB_MAX_DIMENSION),
    ]);

    const recordedVariants: Record<string, unknown>[] = [];
    for (const v of variants) {
      const objectKey = format(
        "{0}/{1}/{2}/{3}/{4}-{5}.jpg",
        assetRow.scope_type,
        assetRow.scope_id,
        assetRow.album_id,
        assetRow.id,
        v.variant,
        v.contentHash.slice(0, 12),
      );

      const upload = await adminClient.storage
        .from("photos-public")
        .upload(objectKey, v.bytes, {
          cacheControl: "public, max-age=86400, immutable",
          contentType: "image/jpeg",
          upsert: true,
        });
      if (upload.error) {
        return jsonResponse({
          ok: false,
          error: `upload variant ${v.variant} failed: ${upload.error.message}`,
        }, 500);
      }

      recordedVariants.push({
        variant: v.variant,
        bucket: "photos-public",
        objectKey,
        contentType: "image/jpeg",
        byteSize: v.bytes.byteLength,
        width: v.width,
        height: v.height,
        contentHash: v.contentHash,
      });
    }

    const { error: recordErr } = await adminClient.rpc(
      "snh_photo_asset_record_variants",
      { p_asset_id: assetId, p_variants: recordedVariants },
    );
    if (recordErr) {
      return jsonResponse({ ok: false, error: recordErr.message }, 500);
    }

    let finalStatus = assetRow.status;
    if (shouldPublish) {
      // Use the user's auth so the RPC's role check + audit picks up the
      // correct actor.
      const { error: pubErr } = await userClient.rpc("snh_photo_asset_publish", {
        p_asset_id: assetId,
      });
      if (pubErr) {
        return jsonResponse({ ok: false, error: pubErr.message }, 500);
      }
      finalStatus = "published";
    }

    return jsonResponse({
      ok: true,
      assetId,
      variants: recordedVariants,
      status: finalStatus,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
});

interface BuiltVariant {
  variant: "web" | "thumb";
  bytes: Uint8Array;
  width: number;
  height: number;
  contentHash: string;
}

async function buildVariant(
  source: Image,
  variant: "web" | "thumb",
  maxDim: number,
): Promise<BuiltVariant> {
  const ratio = Math.min(1, maxDim / Math.max(source.width, source.height));
  const targetW = Math.max(1, Math.round(source.width * ratio));
  const targetH = Math.max(1, Math.round(source.height * ratio));

  const clone = source.clone();
  if (ratio < 1) {
    clone.resize(targetW, targetH);
  }
  const bytes = await clone.encodeJPEG(JPEG_QUALITY);
  const contentHash = await sha256Hex(bytes);

  return {
    variant,
    bytes,
    width: targetW,
    height: targetH,
    contentHash,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

function format(template: string, ...values: unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ""));
}
