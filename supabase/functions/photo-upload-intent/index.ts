import { json, preflight, context, uuid, check } from "../_shared/photo-v2.ts";
Deno.serve(async (req) => {
    if (req.method === "OPTIONS")
        return preflight();
    if (req.method !== "POST")
        return json({ ok: false, error: "Method not allowed" }, 405);
    try {
        const { admin, actor } = await context(req);
        const body = await req.json(), albumId = uuid(body.albumId);
        if (body.contentType !== "image/webp")
            return json({ ok: false, error: "Convert to WebP in your browser before uploading" }, 400);
        const reserved = await admin.rpc("snh_photo_browser_intent", { p_album_id: albumId, p_actor_user_id: actor, p_filename: String(body.originalFilename || "").slice(0, 200), p_asset_id: body.existingAssetId ? uuid(body.existingAssetId) : null });
        check(reserved);
        const pending = reserved.data, uploads = [];
        for (const variant of ["web", "thumb"]) {
            const objectKey = `${pending.prefix}/staged-${pending.uploadToken}-${variant}.webp`;
            const signed = await admin.storage.from("photos-private").createSignedUploadUrl(objectKey, { upsert: false });
            check(signed);
            uploads.push({ variant, bucket: "photos-private", objectKey, token: signed.data!.token, signedUrl: signed.data!.signedUrl });
        }
        return json({ ok: true, ...pending, uploads });
    }
    catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : "Photo operation failed" }, (e as {
            status?: number;
        }).status || 400);
    }
});
