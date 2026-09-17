import { extractOpdbImages, extractOpdbImagesFromExport } from "./opdb-images.ts";

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Expected ${e}, received ${a}`);
}

Deno.test("extractOpdbImages uses structured OPDB fields and deterministic priority", () => {
  const result = extractOpdbImages({ images: [
    { group: "backglass", type: "backglass", primary: true, urls: { large: "https://img.opdb.org/backglass-large.jpg" }, sizes: { large: { width: 800, height: 600 } } },
    { group: "playfield", title: "Playfield", type: "playfield", primary: false, urls: { small: "https://img.opdb.org/playfield-small.jpg", large: "https://img.opdb.org/playfield-large.jpg" }, sizes: { large: { width: 1200, height: 1800 } } },
  ] }, "G-test");
  assertEquals(result.length, 2);
  assertEquals(result[0], {
    sourceRecordId: "playfield",
    url: "https://img.opdb.org/playfield-large.jpg",
    sourcePageUrl: "https://opdb.org/api/machines/G-test",
    imageType: "playfield",
    title: "Playfield",
    width: 1200,
    height: 1800,
    providerPrimary: false,
  });
});

Deno.test("extractOpdbImages rejects non-OPDB image hosts", () => {
  assertEquals(extractOpdbImages({ images: [
    { group: "x", urls: { large: "https://example.com/not-opdb.jpg" } },
  ] }, "G-test"), []);
});

Deno.test("export lookup falls back from alias to physical machine", () => {
  const exportPayload = {
    aliases: [{ opdbId: "Gone-Mtwo-Athree", images: [] }],
    machines: [{ opdbId: "Gone-Mtwo", images: [
      { group: "machine-image", type: "playfield", urls: { medium: "https://img.opdb.org/machine-image-medium.jpg" } },
    ] }],
    machineGroups: [],
  };
  const result = extractOpdbImagesFromExport(exportPayload, "Gone-Mtwo-Athree");
  assertEquals(result[0].sourceRecordId, "machine-image");
});
