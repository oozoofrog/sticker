import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { buildAgentInstallZip } from "../server/agent-install-zip.js";
void test("fixed-root UTF8 ZIP preserves exact bytes and executable command permission without duplicate or escaping names", () => {
  const data = Buffer.from("검토된 내용\n");
  const zip = buildAgentInstallZip([
    { name: "Install Sticker.command", content: data, executable: true },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(6), 0x800);
  assert.equal(zip.readUInt32LE(14), crc32(data));
  assert.equal(zip.readUInt32LE(18), data.length);
  assert.equal(zip.readUInt32LE(22), data.length);
  const length = zip.readUInt16LE(26);
  assert.equal(
    zip.subarray(30, 30 + length).toString(),
    "Sticker-Agent-Install/Install Sticker.command",
  );
  assert.deepEqual(zip.subarray(30 + length, 30 + length + data.length), data);
  const central = 30 + length + data.length;
  assert.equal(zip.readUInt32LE(central), 0x02014b50);
  assert.equal(zip.readUInt32LE(central + 16), crc32(data));
  assert.equal(zip.readUInt16LE(central + 8), 0x800);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt32LE(end + 16), central);
  assert.equal(zip.readUInt16LE(end + 10), 1);
  assert.equal(zip.readUInt32LE(central + 38) >>> 16, 0o100700);
  for (const name of [
    "../escape",
    "/absolute",
    "a//b",
    "a/./b",
    "a/../../b",
    "a\\b",
  ])
    assert.throws(() => buildAgentInstallZip([{ name, content: data }]));
  assert.throws(() =>
    buildAgentInstallZip([
      { name: "a", content: data },
      { name: "a", content: data },
    ]),
  );
  assert.throws(() =>
    buildAgentInstallZip([
      { name: "a", content: Buffer.alloc(2 * 1024 * 1024 + 1) },
    ]),
  );
});
