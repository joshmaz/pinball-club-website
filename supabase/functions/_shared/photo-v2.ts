import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
export function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }); }
export function preflight() { return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } }); }
export async function context(req: Request, adminOnly = false) {
    const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!, key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!url || !anon || !key)
        throw new Error("Photo service is not configured");
    const header = req.headers.get("Authorization") || "";
    if (!/^bearer /i.test(header))
        throw Object.assign(new Error("Sign in required"), { status: 401 });
    const user = createClient(url, anon, { global: { headers: { Authorization: header } }, auth: { persistSession: false } });
    const identity = await user.auth.getUser();
    if (identity.error || !identity.data.user)
        throw Object.assign(new Error("Invalid session"), { status: 401 });
    const role = await user.rpc(adminOnly ? "snh_member_has_photos_admin_access" : "snh_member_has_photos_access");
    if (role.error || role.data !== true)
        throw Object.assign(new Error("Not authorized"), { status: 403 });
    return { user, actor: identity.data.user.id, admin: createClient(url, key, { auth: { persistSession: false } }) };
}
export function uuid(value: unknown) {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        throw Object.assign(new Error("Valid photo or album ID required"), { status: 400 });
    return value;
}
export function check(result: {
    error: unknown;
}) {
    if (result.error) {
        const message = result.error instanceof Error ? result.error.message : (result.error as { message?: string }).message;
        throw new Error(message || "Photo operation failed");
    }
}
export async function hash(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join(""); }
// Parse a single still WebP frame; reject EXIF, XMP, animation, trailing data and malformed containers.
export function webpDimensions(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (start: number, n: number) => String.fromCharCode(...bytes.slice(start, start + n));
    if (bytes.length < 20 || text(0, 4) !== "RIFF" || text(8, 4) !== "WEBP" || view.getUint32(4, true) + 8 !== bytes.length)
        throw new Error("Invalid WebP container");
    let width = 0, height = 0, frames = 0;
    for (let offset = 12; offset < bytes.length;) {
        if (offset + 8 > bytes.length)
            throw new Error("Truncated WebP chunk");
        const name = text(offset, 4), size = view.getUint32(offset + 4, true), p = offset + 8;
        if (p + size + (size % 2) > bytes.length)
            throw new Error("Truncated WebP");
        if (["EXIF", "XMP ", "ANIM", "ANMF"].includes(name))
            throw new Error("Metadata and animated WebP are not accepted");
        if (name === "VP8 ") {
            if (size < 10 || (bytes[p] & 1) !== 0 || text(p + 3, 3) !== "\x9d\x01\x2a")
                throw new Error("Invalid WebP frame");
            width = view.getUint16(p + 6, true) & 0x3fff;
            height = view.getUint16(p + 8, true) & 0x3fff;
            frames++;
        }
        else if (name === "VP8L") {
            if (size < 5 || bytes[p] !== 0x2f)
                throw new Error("Invalid lossless WebP");
            const bits = view.getUint32(p + 1, true);
            if (bits >>> 29)
                throw new Error("Invalid WebP version");
            width = (bits & 0x3fff) + 1;
            height = ((bits >>> 14) & 0x3fff) + 1;
            frames++;
        }
        else if (name === "VP8X") {
            if (size !== 10 || bytes[p] & 0x0e)
                throw new Error("Invalid extended WebP");
        }
        else if (!["ALPH", "ICCP"].includes(name))
            throw new Error("Unknown WebP chunk");
        offset = p + size + (size % 2);
    }
    if (frames !== 1 || !width || !height)
        throw new Error("Single still WebP required");
    return { width, height };
}
export async function drain(admin: any) {
    const list = await admin.rpc("snh_photo_cleanup_list");
    check(list);
    let failed = 0, removed = 0;
    for (const item of list.data || []) {
        let error: string | null = null;
        try {
            const result = await admin.storage.from(item.bucket).remove([item.object_key]);
            check(result);
            removed++;
        }
        catch (e) {
            error = e instanceof Error ? e.message : String(e);
            failed++;
        }
        const ack = await admin.rpc("snh_photo_cleanup_ack", { p_id: item.id, p_error: error });
        check(ack);
    }
    const pending = await admin.rpc("snh_photo_cleanup_pending");
    check(pending);
    return { removed, failed, pending: Math.max(Number(pending.data) || 0, failed) };
}
