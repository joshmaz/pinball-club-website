import { json, preflight, context, uuid, check, hash, webpDimensions } from "../_shared/photo-v2.ts";
Deno.serve(async (req) => {
    if (req.method === "OPTIONS")
        return preflight();
    if (req.method !== "POST")
        return json({ ok: false, error: "Method not allowed" }, 405);
    try {
        const { admin, actor } = await context(req);
        const body = await req.json(), assetId = uuid(body.assetId);
        const result = await admin.from("photo_assets").select("*").eq("id", assetId).maybeSingle();
        check(result);
        const a = result.data;
        if (body.action === "preview") {
            if (!a || a.upload_mode !== "browser" || a.status === "pending")
                throw new Error("Preview not ready");
            const key = `${a.scope_type}/${a.scope_id}/${a.album_id}/${a.id}/staged-${a.upload_token}-thumb.webp`;
            const signed = await admin.storage.from("photos-private").createSignedUrl(key, 600);
            check(signed);
            return json({ ok: true, url: signed.data!.signedUrl });
        }
        const token = uuid(body.uploadToken);
        if (!a || a.upload_mode !== "browser" || a.upload_token !== token)
            throw new Error("Upload not found");
        // Lost responses can be retried without creating another asset.
        if (["uploaded", "published"].includes(a.status))
            return json({ ok: true, assetId, status: a.status });
        if (a.status !== "pending" || new Date(a.upload_expires_at).getTime() < Date.now())
            throw new Error("Upload expired; choose the file again");
        const variants = [];
        for (const variant of ["web", "thumb"]) {
            const objectKey = `${a.scope_type}/${a.scope_id}/${a.album_id}/${a.id}/staged-${token}-${variant}.webp`;
            const file = await admin.storage.from("photos-private").download(objectKey);
            check(file);
            if (!file.data || file.data.size > 8388608)
                throw new Error("Derivative exceeds 8 MB");
            const bytes = new Uint8Array(await file.data.arrayBuffer());
            const dims = webpDimensions(bytes), max = variant === "web" ? 1920 : 640;
            if (Math.max(dims.width, dims.height) > max)
                throw new Error(`Photo exceeds ${max}px`);
            variants.push({ variant, bucket: "photos-private", objectKey, contentType: "image/webp", byteSize: bytes.length, ...dims, contentHash: await hash(bytes) });
        }
        check(await admin.rpc("snh_photo_browser_commit", { p_asset_id: assetId, p_token: token, p_variants: variants, p_actor_user_id: actor, p_publish: false, p_revision: a.upload_revision }));
        return json({ ok: true, assetId, status: "uploaded" });
    }
    catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : "Photo operation failed" }, (e as {
            status?: number;
        }).status || 400);
    }
});
