// Bounded request-shape validation of the selected CLI's generated schemas.
globalThis.StickerInstallSchema = (() => {
  const keys = new Set([
    "$schema",
    "$id",
    "$ref",
    "$defs",
    "definitions",
    "title",
    "description",
    "default",
    "examples",
    "deprecated",
    "type",
    "format",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "anyOf",
    "oneOf",
    "allOf",
    "minLength",
    "maxLength",
    "pattern",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minItems",
    "maxItems",
    "uniqueItems",
  ]);
  function accepts(schema, value, schemas, root, depth = 0) {
    if (depth > 30) return false;
    if (schema === true) return true;
    if (schema === false) return false;
    if (
      !schema ||
      typeof schema !== "object" ||
      Array.isArray(schema) ||
      Object.keys(schema).some((k) => !keys.has(k))
    )
      return false;
    const check = (s, v = value) => accepts(s, v, schemas, root, depth + 1);
    if (schema.$ref) {
      if (typeof schema.$ref !== "string") return false;
      const parts = schema.$ref.split("#");
      if (parts.length > 2) return false;
      const [file, pointer = ""] = parts;
      // Only exact sibling documents are supported; never alias another
      // namespace, URI or path to a selected document by its basename.
      if (file && !/^(?:\.\/)?[A-Za-z][A-Za-z0-9_]*\.json$/.test(file))
        return false;
      const name = file.replace(/^\.\//, "").replace(/\.json$/, "");
      if (file && !Object.hasOwn(schemas, name)) return false;
      let target = file ? schemas[name] : root;
      const referenceRoot = target;
      if (pointer) {
        if (!pointer.startsWith("/")) return false;
        for (const key of pointer
          .slice(1)
          .split("/")
          .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))) {
          if (!target || !Object.hasOwn(target, key)) return false;
          target = target[key];
        }
      }
      if (!accepts(target, value, schemas, referenceRoot, depth + 1))
        return false;
    }
    if (
      schema.anyOf &&
      (!Array.isArray(schema.anyOf) || !schema.anyOf.some((s) => check(s)))
    )
      return false;
    if (
      schema.oneOf &&
      (!Array.isArray(schema.oneOf) ||
        schema.oneOf.filter((s) => check(s)).length !== 1)
    )
      return false;
    if (
      schema.allOf &&
      (!Array.isArray(schema.allOf) || !schema.allOf.every((s) => check(s)))
    )
      return false;
    if (
      schema.enum &&
      (!Array.isArray(schema.enum) ||
        !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value)))
    )
      return false;
    if (
      Object.hasOwn(schema, "const") &&
      JSON.stringify(schema.const) !== JSON.stringify(value)
    )
      return false;
    const type =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (
        !types.includes(type) &&
        !(
          type === "number" &&
          Number.isInteger(value) &&
          types.includes("integer")
        )
      )
        return false;
    }
    if (Object.hasOwn(schema, "format")) {
      if (schema.format !== "uint32") return false;
      if (
        value !== null &&
        (!Number.isInteger(value) || value < 0 || value > 4294967295)
      )
        return false;
    }
    if (type === "object") {
      if (
        schema.required &&
        (!Array.isArray(schema.required) ||
          schema.required.some((k) => !Object.hasOwn(value, k)))
      )
        return false;
      for (const [key, item] of Object.entries(value)) {
        if (schema.properties && Object.hasOwn(schema.properties, key)) {
          if (!check(schema.properties[key], item)) return false;
        } else if (schema.additionalProperties === false) return false;
        else if (
          schema.additionalProperties &&
          typeof schema.additionalProperties === "object" &&
          !check(schema.additionalProperties, item)
        )
          return false;
      }
    }
    if (type === "array") {
      if (schema.minItems !== undefined && value.length < schema.minItems)
        return false;
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        return false;
      if (
        schema.uniqueItems &&
        new Set(value.map((v) => JSON.stringify(v))).size !== value.length
      )
        return false;
      if (schema.items && !value.every((v) => check(schema.items, v)))
        return false;
    }
    if (type === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength)
        return false;
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        return false;
      if (schema.pattern) {
        if (typeof schema.pattern !== "string" || schema.pattern.length > 1000)
          return false;
        try {
          if (!new RegExp(schema.pattern).test(value)) return false;
        } catch {
          return false;
        }
      }
    }
    if (type === "number") {
      for (const [key, invalid] of [
        ["minimum", value < schema.minimum],
        ["maximum", value > schema.maximum],
        ["exclusiveMinimum", value <= schema.exclusiveMinimum],
        ["exclusiveMaximum", value >= schema.exclusiveMaximum],
      ])
        if (schema[key] !== undefined && invalid) return false;
    }
    return true;
  }
  function verify(schemas) {
    const read = { includeLayers: true, cwd: "/fixture" };
    const edit = {
      keyPath: "mcp_servers.sticker",
      mergeStrategy: "upsert",
      value: {
        command: "/fixture/wrapper",
        args: [],
        enabled_tools: ["sticker_get_issue"],
      },
    };
    const batch = {
      filePath: "/fixture/config.toml",
      expectedVersion: "sha256:fixture",
      reloadUserConfig: false,
      edits: [edit],
    };
    const status = {
      serverName: "sticker",
      detail: "toolsAndAuthOnly",
      limit: 10,
    };
    const cases = [
      [
        "ConfigReadParams",
        read,
        [
          { ...read, includeLayers: "true" },
          { ...read, cwd: 1 },
        ],
      ],
      [
        "ConfigBatchWriteParams",
        batch,
        [
          { ...batch, expectedVersion: true },
          { ...batch, filePath: 1 },
          { ...batch, reloadUserConfig: "false" },
          {
            ...batch,
            edits: [
              {
                differentKey: "mcp_servers.sticker",
                mode: "replaceEverything",
              },
            ],
          },
          {
            ...batch,
            edits: [{ ...edit, mergeStrategy: "replaceEverything" }],
          },
        ],
      ],
      [
        "ListMcpServerStatusParams",
        status,
        [
          { ...status, serverName: 1 },
          { ...status, detail: "unrelated" },
          { ...status, limit: true },
        ],
      ],
      ["SkillsListParams", {}, []],
    ];
    for (const [name, sample, invalid] of cases) {
      const schema = schemas[name];
      if (
        !schema ||
        !accepts(schema, sample, schemas, schema) ||
        invalid.some((v) => accepts(schema, v, schemas, schema))
      )
        throw new Error("schema_unverified");
    }
    return true;
  }
  return { verify, accepts };
})();
