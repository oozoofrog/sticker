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
    McpServerStatusListParams: {
      type: "object",
      properties: {
        serverName: nullable("string"),
        detail: { enum: ["toolsAndAuthOnly", "full"] },
        limit: nullable("integer"),
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
