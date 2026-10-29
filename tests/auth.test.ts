import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AuthManager } from "../server/auth.js";
const password = "temporary-fixture-password-42";
const token = "ephemeral-agent-token-not-a-real-grant";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
void test("no default/weak owner password and invalid agent config are accepted", () => {
  assert.throws(() => new AuthManager({ ownerPassword: "" }));
  assert.throws(() => new AuthManager({ ownerPassword: "short" }));
  assert.throws(
    () =>
      new AuthManager({
        ownerPassword: password,
        agents: [
          {
            id: "a",
            name: "Agent",
            tokenHash: "raw-token",
            projectIds: null,
            canWrite: true,
          },
        ],
      }),
  );
});
void test("owner sessions are random, revocable and do not accept the password as a bearer", () => {
  const auth = new AuthManager({ ownerPassword: password });
  assert.equal(auth.login("wrong", "fixture"), null);
  const session = auth.login(password, "fixture");
  assert.ok(session);
  assert.equal(
    auth.authenticate(undefined, `sticker_session=${session}`)?.role,
    "owner",
  );
  assert.equal(auth.authenticate(`Bearer ${password}`), null);
  auth.logout(`sticker_session=${session}`);
  assert.equal(
    auth.authenticate(undefined, `sticker_session=${session}`),
    null,
  );
});
void test("session expiry cannot authenticate", async () => {
  const auth = new AuthManager({ ownerPassword: password, sessionTtlMs: 1 });
  const session = auth.login(password, "fixture");
  assert.ok(session);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    auth.authenticate(undefined, `sticker_session=${session}`),
    null,
  );
});
void test("bearer principal is configured rather than client-supplied and read-only scope survives", () => {
  const auth = new AuthManager({
    ownerPassword: password,
    agents: [
      {
        id: "agent-1",
        name: "Fixture agent",
        tokenHash: hash(token),
        projectIds: ["p1"],
        canWrite: false,
      },
    ],
  });
  assert.deepEqual(auth.authenticate(`Bearer ${token}`), {
    id: "agent-1",
    name: "Fixture agent",
    role: "agent",
    projectIds: ["p1"],
    canWrite: false,
  });
  assert.equal(auth.authenticate(`Bearer ${token}x`), null);
});
void test("login throttles repeated failures, including correct password during cooldown", () => {
  const auth = new AuthManager({ ownerPassword: password });
  for (let i = 0; i < 10; i++)
    assert.equal(auth.login("wrong", "fixture"), null);
  assert.equal(auth.login(password, "fixture"), null);
  assert.ok(auth.login(password, "different-fixture"));
});

void test("explicit empty or malformed authorization never falls back to an owner cookie", () => {
  const auth = new AuthManager({ ownerPassword: "fixture-owner-password" });
  const token = auth.login("fixture-owner-password", "fixture");
  assert.ok(token);
  for (const header of ["", "Basic invalid", "Bearer invalid"]) {
    assert.equal(auth.authenticate(header, `sticker_session=${token}`), null);
  }
});
