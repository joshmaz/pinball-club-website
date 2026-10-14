import { json, preflight, context, uuid, check, drain } from "../_shared/photo-v2.ts";
Deno.serve(async (req) => {
    if (req.method === "OPTIONS")
        return preflight();
    if (req.method !== "POST")
        return json({ ok: false, error: "Method not allowed" }, 405);
    try {
        const body = await req.json(), action = body.action;
        if (!["unpublish", "delete", "album-delete", "cleanup"].includes(action))
            throw new Error("Invalid action");
        const { admin, user } = await context(req, ["delete", "album-delete", "cleanup"].includes(action));
        if (action !== "cleanup") {
            const name = action === "album-delete" ? "snh_photo_album_delete" : action === "delete" ? "snh_photo_asset_delete" : "snh_photo_asset_unpublish";
            const id = uuid(action === "album-delete" ? body.albumId : body.assetId);
            check(await user.rpc(name, action === "album-delete" ? { p_album_id: id } : { p_asset_id: id }));
        }
        const cleanup = await drain(admin);
        return json({ ok: true, action, cleanup, cleanupPending: cleanup.pending > 0 });
    }
    catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : "Photo operation failed" }, (e as {
            status?: number;
        }).status || 400);
    }
});
