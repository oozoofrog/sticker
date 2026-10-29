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
function runGeneratedTree(entries, documents) {
  const source = readFileSync(
    new URL("../packaging/agent-install/installer.jxa.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("      const entries ="),
    end = source.indexOf("      for (const args of [", start);
  const sandbox = {
    temporary: "/fixture-schema",
    ObjC: { deepUnwrap: (value) => value },
    fm: { subpathsAtPath: () => entries },
    canonical: (p) => p,
    text: (p) => {
      const relative = p.slice("/fixture-schema/".length);
      assert.ok(Object.hasOwn(documents, relative));
      return documents[relative];
    },
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
  vm.runInContext(source.slice(start, end), sandbox);
}
function standaloneTree() {
  return Object.fromEntries(
    Object.keys(files).map((name) => [
      `v2/${name}.json`,
      read(name).toString("utf8"),
    ]),
  );
}
function syntheticAggregate() {
  // Synthetic aggregate shape: actual standalone definitions are moved to one
  // shared root, so lifting a nested request definition loses its local ref root.
  const definitions = {};
  for (const name of Object.keys(files)) {
    const doc = JSON.parse(read(name).toString("utf8"));
    Object.assign(definitions, doc.definitions ?? {});
    delete doc.definitions;
    definitions[name] = doc;
  }
  return JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions,
  });
}
test("standalone document roots survive synthetic aggregate and v1 name collisions in every discovery order", () => {
  const docs = {
    ...standaloneTree(),
    "synthetic-aggregate.json": syntheticAggregate(),
    "v1/ConfigBatchWriteParams.json": JSON.stringify({ type: "boolean" }),
  };
  const paths = Object.keys(docs);
  for (const entries of [
    paths,
    [...paths].reverse(),
    [paths[4], ...paths.slice(0, 4), paths[5]],
  ])
    assert.doesNotThrow(() => runGeneratedTree(entries, docs));
});
test("missing or duplicate exact v2 standalone candidates fail closed instead of trusting an aggregate alias", () => {
  const docs = {
    ...standaloneTree(),
    "synthetic-aggregate.json": syntheticAggregate(),
  };
  const paths = Object.keys(docs);
  assert.throws(
    () =>
      runGeneratedTree(
        paths.filter((p) => p !== "v2/ConfigBatchWriteParams.json"),
        docs,
      ),
    /schema_unverified/,
  );
  assert.throws(
    () => runGeneratedTree([...paths, "v2/ConfigBatchWriteParams.json"], docs),
    /schema_unverified/,
  );
  const invalid = {
    ...docs,
    "v2/ConfigBatchWriteParams.json": JSON.stringify({ type: "boolean" }),
  };
  assert.throws(() => runGeneratedTree(paths, invalid), /schema_unverified/);
});
test("mismatched v2 titles and external refs beyond the supported document set are not guessed", () => {
  const docs = standaloneTree(),
    paths = Object.keys(docs);
  const readDoc = JSON.parse(docs["v2/ConfigReadParams.json"]);
  assert.throws(
    () =>
      runGeneratedTree(paths, {
        ...docs,
        "v2/ConfigReadParams.json": JSON.stringify({
          ...readDoc,
          title: "OtherProtocol",
        }),
      }),
    /schema_unverified/,
  );
  readDoc.properties.cwd = { $ref: "Outside.json" };
  const external = {
    ...docs,
    "v2/ConfigReadParams.json": JSON.stringify(readDoc),
    "v2/Outside.json": JSON.stringify({ type: "string" }),
  };
  assert.throws(
    () => runGeneratedTree(Object.keys(external), external),
    /schema_unverified/,
  );
});
