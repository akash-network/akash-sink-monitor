import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, glob } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(root, "vendor/artifacts.json"), "utf8"),
);
for (const [path, expected] of Object.entries(manifest.files)) {
  assert(!path.includes("..") && !path.startsWith("/"));
  const actual = createHash("sha256")
    .update(await readFile(resolve(root, path)))
    .digest("hex");
  assert.equal(actual, expected, "Vendored artifact changed: " + path);
}
const akt = JSON.parse(await readFile(resolve(root, "idl/akt.json"), "utf8"));
assert.equal(akt.address, "98inUHb5mMaHWQZ9ut9PGrnmkMpncLZWWAyFwxCWagME");
const guardian = akt.instructions.find(
  (entry) => entry.name === "guardian_pause",
);
assert(guardian && guardian.args.length === 0);
assert.deepEqual(guardian.discriminator, [
  ...createHash("sha256")
    .update("global:guardian_pause")
    .digest()
    .subarray(0, 8),
]);
for await (const native of glob("node_modules/**/bigint-buffer/**/*.node", {
  cwd: root,
})) {
  assert.fail("Unexpected vulnerable native bigint-buffer binding: " + native);
}
process.stdout.write(
  "Vendored SDK and IDL checksums verified; no native bigint-buffer binding.\n",
);
