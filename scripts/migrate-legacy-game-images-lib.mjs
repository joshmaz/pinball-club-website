import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const LEGACY_DIR = "assets/images/machines";
export const STORAGE_BUCKET = "game-images";

const MIME_SIGNATURES = [
  { mime: "image/jpeg", extension: "jpg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", extension: "png", matches: (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mime: "image/gif", extension: "gif", matches: (b) => b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a" },
  { mime: "image/webp", extension: "webp", matches: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
];

export function detectImageType(bytes) {
  const found = MIME_SIGNATURES.find((entry) => entry.matches(bytes));
  if (!found) throw new Error("unsupported or unrecognized image content");
  return found;
}

export function deterministicObjectId(checksum) {
  const chars = checksum.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ["8", "9", "a", "b"][parseInt(chars[16], 16) % 4];
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildStoragePath(gameId, checksum, extension) {
  return `${gameId}/${deterministicObjectId(checksum)}.${extension}`;
}

export function publicStorageUrl(supabaseUrl, storagePath) {
  const encoded = storagePath.split("/").map(encodeURIComponent).join("/");
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${STORAGE_BUCKET}/${encoded}`;
}

export async function inventoryLegacyImages(rootDir) {
  const catalogPath = path.join(rootDir, "data", "games.json");
  const imageDir = path.join(rootDir, LEGACY_DIR);
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!catalog || !Array.isArray(catalog.games)) throw new Error("data/games.json must contain a games array");

  const mappings = new Map();
  for (const game of catalog.games) {
    const filename = typeof game?.imageFilename === "string" ? game.imageFilename.trim() : "";
    if (!filename) continue;
    const entries = mappings.get(filename) || [];
    entries.push({ slug: String(game.slug || "").trim(), title: String(game.title || "").trim(), filename });
    mappings.set(filename, entries);
  }

  const filenames = (await readdir(imageDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const files = [];
  for (const filename of filenames) {
    const mappedGames = mappings.get(filename) || [];
    const absolutePath = path.join(imageDir, filename);
    const bytes = await readFile(absolutePath);
    let imageType = null;
    let typeError = null;
    try { imageType = detectImageType(bytes); } catch (error) { typeError = error.message; }
    files.push({
      filename,
      absolutePath,
      repoPath: `${LEGACY_DIR}/${filename}`,
      bytes,
      sizeBytes: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      imageType,
      typeError,
      mappedGames,
    });
  }

  const missingFiles = [...mappings.entries()]
    .filter(([filename]) => !filenames.includes(filename))
    .flatMap(([filename, games]) => games.map((game) => ({ ...game, filename })));
  return { files, missingFiles };
}

export function planMigration(inventory, dbGames, dbImages, supabaseUrl) {
  const gamesBySlug = new Map(dbGames.map((game) => [game.slug, game]));
  const imagesByGame = new Map();
  for (const image of dbImages) {
    const entries = imagesByGame.get(image.game_id) || [];
    entries.push(image);
    imagesByGame.set(image.game_id, entries);
  }

  return inventory.files.map((file) => {
    if (file.typeError) return { ...file, action: "manual_review", reason: file.typeError };
    if (file.mappedGames.length !== 1) {
      return { ...file, action: "manual_review", reason: file.mappedGames.length ? "ambiguous catalog mapping" : "unmapped file" };
    }
    const catalogGame = file.mappedGames[0];
    const game = gamesBySlug.get(catalogGame.slug);
    if (!game) return { ...file, catalogGame, action: "manual_review", reason: "catalog game not found in database" };
    if (String(game.image_filename || "").trim() !== file.filename) {
      return { ...file, catalogGame, game, action: "manual_review", reason: "database image_filename differs from catalog mapping" };
    }
    const storagePath = buildStoragePath(game.id, file.checksum, file.imageType.extension);
    const publicUrl = publicStorageUrl(supabaseUrl, storagePath);
    const images = imagesByGame.get(game.id) || [];
    const legacyKey = `legacy:${file.filename}`;
    const storageKey = `storage:${storagePath}`;
    const legacy = images.find((image) => image.source_type === "club" && image.source_key === legacyKey);
    const migrated = images.find((image) => image.source_type === "club" && image.source_key === storageKey);
    if (migrated && legacy) {
      return { ...file, catalogGame, game, storagePath, publicUrl, image: migrated, action: "manual_review", reason: "both legacy and storage associations exist" };
    }
    if (migrated && migrated.location_value === publicUrl && migrated.metadata?.storagePath === storagePath) {
      return { ...file, catalogGame, game, storagePath, publicUrl, image: migrated, action: "skip", reason: "already migrated" };
    }
    if (migrated) {
      return { ...file, catalogGame, game, storagePath, publicUrl, image: migrated, action: "manual_review", reason: "existing storage association differs" };
    }
    if (!legacy) {
      return { ...file, catalogGame, game, storagePath, publicUrl, action: "manual_review", reason: "legacy game_images association not found" };
    }
    return { ...file, catalogGame, game, storagePath, publicUrl, image: legacy, action: "migrate" };
  });
}
