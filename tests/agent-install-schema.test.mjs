import test from "node:test";
import assert from "node:assert/strict";
import "../packaging/agent-install/schema.js";
function schemas() {
  const nullable = (type) => ({ anyOf: [{ type }, { type: "null" }] });
  return {
    ConfigReadParams: {
      type: "object",
      properties: {
        includeLayers: { type: "boolean" },
        cwd: nullable("string"),
      },
    },
    ConfigBatchWriteParams: {
      type: "object",
      required: ["edits"],
      properties: {
        filePath: nullable("string"),
        expectedVersion: nullable("string"),
        reloadUserConfig: { type: "boolean" },
        edits: { type: "array", items: { $ref: "#/$defs/ConfigEdit" } },
      },
      $defs: {
        ConfigEdit: {
          type: "object",
          required: ["keyPath", "mergeStrategy", "value"],
          properties: {
            keyPath: { type: "string" },
            mergeStrategy: { enum: ["upsert", "replace"] },
            value: true,
          },
        },
      },
    },
    ListMcpServerStatusParams: {
      type: "object",
      properties: {
        serverName: nullable("string"),
        detail: { enum: ["toolsAndAuthOnly", "full"] },
        limit: { type: ["integer", "null"], format: "uint32", minimum: 0 },
      },
    },
    SkillsListParams: { type: "object", properties: {} },
  };
}
test("supported required/type/local-ref/nullable and used enum schemas accept exact installer requests", () =>
  assert.equal(globalThis.StickerInstallSchema.verify(schemas()), true));
test("changed types, required edits, enums, unknown refs and unsupported schema constraints fail closed", () => {
  for (const change of [
    (s) =>
      (s.ConfigBatchWriteParams.properties.expectedVersion = {
        type: "boolean",
      }),
    (s) =>
      (s.ConfigBatchWriteParams.$defs.ConfigEdit.required = ["differentKey"]),
    (s) =>
      (s.ConfigBatchWriteParams.$defs.ConfigEdit.properties.mergeStrategy.enum =
        ["replaceEverything"]),
    (s) => (s.ConfigReadParams.required = ["unimplementedExtraField"]),
    (s) =>
      (s.ConfigBatchWriteParams.properties.edits.items = {
        $ref: "#/$defs/Unknown",
      }),
    (s) => (s.SkillsListParams.not = {}),
  ]) {
    const value = schemas();
    change(value);
    assert.throws(
      () => globalThis.StickerInstallSchema.verify(value),
      /schema_unverified/,
    );
  }
});
test("external schema refs switch document root for their own local definitions", () => {
  const value = schemas();
  const edit = value.ConfigBatchWriteParams.$defs.ConfigEdit;
  edit.properties.value = { $ref: "#/$defs/AllowedValue" };
  edit.$defs = { AllowedValue: true };
  value.ConfigEdit = edit;
  delete value.ConfigBatchWriteParams.$defs;
  value.ConfigBatchWriteParams.properties.edits.items = {
    $ref: "ConfigEdit.json",
  };
  assert.equal(globalThis.StickerInstallSchema.verify(value), true);
});

test("actual CLI uint32 limit format is bounded and unknown formats remain unsupported", () => {
  const schema = { type: "integer", format: "uint32", minimum: 0 };
  const accepts = (value) =>
    globalThis.StickerInstallSchema.accepts(schema, value, {}, schema);
  for (const value of [0, 10, 4294967295]) assert.equal(accepts(value), true);
  for (const value of [-1, 4294967296, 0.5, "10", true])
    assert.equal(accepts(value), false);
  const unknown = { type: "integer", format: "unrecognized" };
  assert.equal(
    globalThis.StickerInstallSchema.accepts(unknown, 10, {}, unknown),
    false,
  );
});

test("external refs preserve exact sibling identity and reject path or URI aliases", () => {
  for (const file of [
    "ListMcpServerStatusParams.json",
    "./ListMcpServerStatusParams.json",
  ]) {
    const value = schemas();
    value.ConfigReadParams.properties.cwd = {
      $ref: file + "#/properties/serverName",
    };
    assert.equal(globalThis.StickerInstallSchema.verify(value), true);
  }
  for (const file of [
    "../v1/ListMcpServerStatusParams.json",
    "v1/ListMcpServerStatusParams.json",
    "/ListMcpServerStatusParams.json",
    "https://example.invalid/ListMcpServerStatusParams.json",
    "ListMcpServerStatusParams.json?x=1",
    "././ListMcpServerStatusParams.json",
  ]) {
    const value = schemas();
    value.ConfigReadParams.properties.cwd = {
      $ref: file + "#/properties/serverName",
    };
    assert.throws(
      () => globalThis.StickerInstallSchema.verify(value),
      /schema_unverified/,
    );
  }
  const value = schemas();
  value.ConfigReadParams.properties.cwd = {
    $ref: "ListMcpServerStatusParams.json#/properties/serverName#ignored",
  };
  assert.throws(
    () => globalThis.StickerInstallSchema.verify(value),
    /schema_unverified/,
  );
});
