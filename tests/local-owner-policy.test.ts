import test from "node:test";
import assert from "node:assert/strict";
import { LocalOwnerPolicy, localOwnerMode } from "../server/local-owner.js";
void test("local owner mode is explicit and canonical loopback-only, not a claimed binding proof", () => {
  assert.equal(localOwnerMode(undefined), undefined);
  assert.equal(localOwnerMode("off"), undefined);
  assert.equal(localOwnerMode("trusted-loopback"), "trusted-loopback");
  assert.throws(() => localOwnerMode("true"));
  for (const origin of [
    "https://tailnet.example.ts.net",
    "http://0.0.0.0:8787",
    "http://127.0.0.1.evil.test",
    "http://user@localhost:8787",
    "http://localhost:8787/path",
    "null",
  ])
    assert.throws(() => new LocalOwnerPolicy(origin));
});
void test("exact Host and Origin, duplicate/null/proxy/cross-site headers fail closed", () => {
  const policy = new LocalOwnerPolicy("http://localhost:8787");
  const good = [
    "Host",
    "localhost:8787",
    "Origin",
    "http://localhost:8787",
    "Sec-Fetch-Site",
    "same-origin",
  ];
  assert.doesNotThrow(() => {
    policy.validate("POST", good, false);
  });
  assert.doesNotThrow(() => {
    policy.validate("GET", ["Host", "localhost:8787"], false);
  });
  assert.doesNotThrow(() => {
    policy.validate("POST", ["Host", "localhost:8787"], true);
  });
  for (const headers of [
    ["Host", "evil.test:8787"],
    ["Host", "localhost:8787", "Host", "localhost:8787"],
    ["Host", "localhost:8787", "Origin", "null"],
    ["Host", "localhost:8787", "Origin", "http://evil.test"],
    [...good, "Origin", "http://localhost:8787"],
    [...good, "X-Forwarded-For", "127.0.0.1"],
    [...good, "Forwarded", "for=127.0.0.1"],
    ["Host", "localhost:8787", "Sec-Fetch-Site", "cross-site"],
    ["Host", "localhost:8787", "Origin", "http://localhost:8787/"],
    ["Host", "localhost:8787,evil.test"],
  ])
    assert.throws(() => {
      policy.validate("GET", headers, false);
    });
  assert.throws(() => {
    policy.validate("POST", ["Host", "localhost:8787"], false);
  });
});
