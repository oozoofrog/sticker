import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  parseNativeLifecycleRequest,
  parseNativeLifecycleResponse,
} from "../client/features/mcp-settings/lifecycle-contract.js";

const cases = z
  .array(
    z
      .object({
        name: z.string(),
        kind: z.enum(["request", "response"]),
        valid: z.boolean(),
        value: z.unknown(),
      })
      .strict(),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/native-client-lifecycle/wire-cases.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown,
  );

for (const fixture of cases) {
  void test("wire contract: " + fixture.name, () => {
    const decode =
      fixture.kind === "request"
        ? parseNativeLifecycleRequest
        : parseNativeLifecycleResponse;
    if (fixture.valid)
      assert.doesNotThrow(() => decode(JSON.stringify(fixture.value)));
    else assert.throws(() => decode(JSON.stringify(fixture.value)));
  });
}

void test("wire limit counts UTF8 bytes including whitespace before JSON decoding", () => {
  const input = JSON.stringify({
    version: 1,
    requestId: "r",
    method: "detectClients",
    refreshMetadata: false,
  });
  assert.doesNotThrow(() =>
    parseNativeLifecycleRequest(input.padEnd(65536, " ")),
  );
  assert.throws(() => parseNativeLifecycleRequest(input.padEnd(65537, " ")));
  assert.throws(() =>
    parseNativeLifecycleRequest(input + " ".repeat(65536) + "한"),
  );
});

void test("every action rejects host parameters, secrets and caller approval", () => {
  for (const fixture of cases.filter((c) => c.kind === "request" && c.valid)) {
    const body = z.record(z.string(), z.unknown()).parse(fixture.value);
    for (const [key, value] of Object.entries({
      command: "/bin/sh",
      args: ["-c", "echo"],
      env: { TOKEN: "fixture" },
      url: "https://foreign.invalid",
      filePath: "/tmp/foreign",
      token: "fixture",
      approved: true,
    }))
      assert.throws(() =>
        parseNativeLifecycleRequest(JSON.stringify({ ...body, [key]: value })),
      );
  }
});

void test("public text rejects malformed Unicode and control characters", () => {
  for (const displayName of ["Codex\ud800", "Codex\n"]) {
    const body = {
      version: 1,
      requestId: "r",
      method: "detectClients",
      result: [
        {
          clientId: "codex-local",
          displayName,
          availability: "writer_unavailable",
          registration: "unknown",
          ownershipRevision: 0,
          allowedActions: [],
          credentialState: "grant_required",
          protocolCheck: "not_checked",
          clientLoad: "unknown",
          checkedAt: "2026-10-31T12:00:00Z",
          reasonCodes: [],
        },
      ],
    };
    assert.throws(() => parseNativeLifecycleResponse(JSON.stringify(body)));
  }
});

void test("duplicate JSON keys including escaped aliases are rejected at the wire boundary", () => {
  const inputs = [
    '{"version":1,"requestId":"r","method":"cancelPlan","planId":"p","planId":"other"}',
    '{"version":1,"requestId":"r","method":"cancelPlan","planId":"p","plan\\u0049d":"other"}',
  ];
  for (const input of inputs)
    assert.throws(() => parseNativeLifecycleRequest(input));
  assert.throws(() =>
    parseNativeLifecycleResponse(
      '{"version":1,"requestId":"r","error":{"code":"owned_conflict","code":"invalid_input"}}',
    ),
  );
});
