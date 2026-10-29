// Prepared bytes only. Never executes the downloaded Mac installer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
const base = process.env.STICKER_SMOKE_API_URL ?? "http://127.0.0.1:8787",
  origin = process.env.APP_ORIGIN;
assert.ok(process.env.OWNER_PASSWORD);
assert.equal((await fetch(`${base}/api/agent-install`)).status, 401);
const login = await fetch(`${base}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ password: process.env.OWNER_PASSWORD }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
const headers = { cookie, origin, "content-type": "application/json" };
const before = await (await fetch(`${base}/api/bootstrap`, { headers })).json();
const catalogResponse = await fetch(`${base}/api/agent-install`, { headers });
assert.equal(catalogResponse.status, 200);
const catalog = await catalogResponse.json();
assert.equal(catalog.verification, "local_execution_required");
const response = await fetch(`${base}/api/agent-install/bundle`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    previewHash: catalog.previewHash,
    agentId: null,
    mcp: false,
    skill: true,
  }),
});
assert.equal(response.status, 200);
assert.equal(response.headers.get("content-type"), "application/zip");
const zip = Buffer.from(await response.arrayBuffer());
assert.equal(zip.length, Number(response.headers.get("content-length")));
assert.ok(zip.length < 2 * 1024 * 1024);
const files = new Map();
let offset = 0;
while (zip.readUInt32LE(offset) === 0x04034b50) {
  assert.equal(zip.readUInt16LE(offset + 6), 0x800);
  assert.equal(zip.readUInt16LE(offset + 8), 0);
  const size = zip.readUInt32LE(offset + 18),
    names = zip.readUInt16LE(offset + 26),
    extra = zip.readUInt16LE(offset + 28),
    name = zip.subarray(offset + 30, offset + 30 + names).toString("utf8");
  assert.ok(name.startsWith("Sticker-Agent-Install/"));
  assert.ok(!name.split("/").includes(".."));
  assert.ok(!files.has(name));
  const start = offset + 30 + names + extra,
    data = zip.subarray(start, start + size);
  assert.equal(data.length, size);
  assert.equal(crc32(data), zip.readUInt32LE(offset + 14));
  files.set(name, data);
  offset = start + size;
}
assert.equal(zip.readUInt32LE(offset), 0x02014b50);
assert.equal(files.size, 4);
assert.equal(zip.readUInt32LE(offset + 38) >>> 16, 0o100700);
const get = (name) => {
  const value = files.get("Sticker-Agent-Install/" + name);
  assert.ok(value);
  return value;
};
const program = get("installer.js"),
  command = get("Install Sticker.command").toString(),
  manifest = JSON.parse(get("manifest.json").toString());
assert.ok(command.includes(createHash("sha256").update(program).digest("hex")));
assert.equal(manifest.components.mcp, false);
assert.equal(manifest.agent, null);
assert.equal(
  createHash("sha256").update(get("sticker-workflow/SKILL.md")).digest("hex"),
  catalog.skill.sha256,
);
assert.ok(program.toString().includes("StickerInstallSchema"));
assert.ok(program.toString().includes("config/batchWrite"));
assert.ok(!zip.toString().includes(process.env.OWNER_PASSWORD));
const after = await (await fetch(`${base}/api/bootstrap`, { headers })).json();
assert.deepEqual(after, before);
console.log(
  "Packaged owner installer catalog and fixed ZIP verified; no local installer executed.",
);
