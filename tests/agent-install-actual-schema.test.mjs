import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import "../packaging/agent-install/schema.js";
const files = {
  ConfigReadParams: [
    495,
    "257c54a423b47c1d209ff1076765a1564d82322fd5161670fd489a2874de1bac",
  ],
  ConfigBatchWriteParams: [
    1369,
    "d092c4412237735cdc9516b396ab1445f079e956cc10271be7c53f0d0e1e650e",
  ],
  ListMcpServerStatusParams: [
    1223,
    "30b978c6502b37c9f0002aeba241f41c91d4c6adf0f92d89242b62ffde415a2d",
  ],
  SkillsListParams: [
    453,
    "1d245374e64c5acc9739dfc68a4fe5114c6c9147af04c480886f1846d2ca6239",
  ],
};
const read = (name) =>
  readFileSync(
    new URL(
      `./fixtures/codex-0.165.0-alpha.1.2/v2/${name}.json`,
      import.meta.url,
    ),
  );
test("actual user-provided public CLI schemas retain original bytes and satisfy installer requests", () => {
  const schemas = {};
  for (const [name, [size, hash]] of Object.entries(files)) {
    const bytes = read(name);
    assert.equal(bytes.length, size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
    schemas[name] = JSON.parse(bytes.toString("utf8"));
  }
  assert.equal(globalThis.StickerInstallSchema.verify(schemas), true);
  assert.ok(!Object.hasOwn(schemas, "McpServerStatusListParams"));
  const limit = schemas.ListMcpServerStatusParams.properties.limit;
  assert.equal(limit.format, "uint32");
  assert.equal(limit.minimum, 0);
  assert.ok(!Object.hasOwn(limit, "maximum"));
  for (const value of [0, 10, 4294967295, null])
    assert.equal(
      globalThis.StickerInstallSchema.accepts(
        limit,
        value,
        schemas,
        schemas.ListMcpServerStatusParams,
      ),
      true,
    );
  for (const value of [-1, 4294967296, 0.1, "10", true])
    assert.equal(
      globalThis.StickerInstallSchema.accepts(
        limit,
        value,
        schemas,
        schemas.ListMcpServerStatusParams,
      ),
      false,
    );
});
test("actual installer preflight loads the original v2 files and resolves their own definitions", () => {
  const source = readFileSync(
    new URL("../packaging/agent-install/installer.jxa.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("      const entries ="),
    end = source.indexOf("      for (const args of [", start);
  assert.ok(start >= 0 && end > start);
  const sandbox = {
    temporary: "/fixture-schema",
    ObjC: { deepUnwrap: (value) => value },
    fm: { subpathsAtPath: () => Object.keys(files).map((n) => `v2/${n}.json`) },
    canonical: (p) => p,
    text: (p) =>
      read(
        p
          .split("/")
          .pop()
          .replace(/\.json$/, ""),
      ).toString("utf8"),
    fail: (code) => {
      throw new Error(code);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(
      new URL("../packaging/agent-install/schema.js", import.meta.url),
      "utf8",
    ),
    sandbox,
  );
  assert.doesNotThrow(() => vm.runInContext(source.slice(start, end), sandbox));
});
