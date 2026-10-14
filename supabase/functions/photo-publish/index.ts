import { json, preflight, context, uuid, check, hash, webpDimensions } from "../_shared/photo-v2.ts";
Deno.serve(async (req) => {
    if (req.method === "OPTIONS")
        return preflight();
    if (req.method !== "POST")
        return json({ ok: false, error: "Method not allowed" }, 405);
    try {
        const { admin, user, actor } = await context(req);
        const body = await req.json(), assetId = uuid(body.assetId);
        const result = await admin.from("photo_assets").select("*").eq("id", assetId).maybeSingle();
        check(result);
        const a = result.data;
        if (!a)
            throw new Error("Photo not found");
        if (body.action === "source") {
            if (!a.original_object_key || !["pending", "uploaded", "unpublished"].includes(a.status))
                throw new Error("Legacy source unavailable");
            const signed = await admin.storage.from("photos-private").createSignedUrl(a.original_object_key, 600);
            check(signed);
            return json({ ok: true, url: signed.data!.signedUrl, contentType: a.original_content_type, filename: a.original_filename });
        }
        if (a.upload_mode !== "browser") {
            // Retained legacy originals are never decoded in the Edge runtime. Existing derivatives remain usable.
            const existing = await admin.from("photo_asset_variants").select("variant").eq("asset_id", assetId).eq("bucket", "photos-public");
            check(existing);
            if (!existing.data?.some(v => v.variant === "web"))
                throw new Error("This legacy photo needs browser conversion. Upload a converted copy; its existing original is retained.");
            if (body.publish !== false)
                check(await user.rpc("snh_photo_asset_publish", { p_asset_id: assetId }));
            return json({ ok: true, assetId, status: body.publish === false ? a.status : "published" });
        }
        if (!["uploaded", "unpublished", "published"].includes(a.status))
            throw new Error("Finish uploading first");
        if (body.publish === false)
            return json({ ok: true, assetId, status: a.status });
        if (a.status === "published")
            return json({ ok: true, assetId, status: a.status });
        const variants = [], publication = crypto.randomUUID();
        // Never reuse public paths. A queued takedown cannot remove a subsequent publication.
        for (const variant of ["web", "thumb"]) {
            const prefix = `${a.scope_type}/${a.scope_id}/${a.album_id}/${a.id}`;
            const source = `${prefix}/staged-${a.upload_token}-${variant}.webp`;
            const file = await admin.storage.from("photos-private").download(source);
            check(file);
            if (!file.data || file.data.size > 8388608)
                throw new Error("Invalid derivative size");
            const bytes = new Uint8Array(await file.data.arrayBuffer()), dims = webpDimensions(bytes);
            if (Math.max(dims.width, dims.height) > (variant === "web" ? 1920 : 640))
                throw new Error("Invalid derivative dimensions");
            const contentHash = await hash(bytes), objectKey = `${prefix}/${variant}-${publication}-${contentHash.slice(0, 12)}.webp`;
            // Register cleanup before upload; failure/crash cannot lose the key. A 10 minute grace covers in-flight commit.
            check(await admin.rpc("snh_photo_queue_storage", { p_bucket: "photos-public", p_key: objectKey }));
            check(await admin.storage.from("photos-public").upload(objectKey, bytes, { contentType: "image/webp", cacheControl: "3600", upsert: false }));
            variants.push({ variant, bucket: "photos-public", objectKey, contentType: "image/webp", byteSize: bytes.length, ...dims, contentHash });
        }
        check(await admin.rpc("snh_photo_browser_commit", { p_asset_id: assetId, p_token: a.upload_token, p_variants: variants, p_actor_user_id: actor, p_publish: true, p_revision: a.upload_revision }));
        return json({ ok: true, assetId, status: "published", variants });
    }
    catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : "Photo operation failed" }, (e as {
            status?: number;
        }).status || 400);
    }
});
