// Disposable Docker fixture only; custom Host models the validated published port.
import assert from "node:assert/strict";
import { request } from "node:http";
const origin = process.env.APP_ORIGIN;
assert.ok(origin);
assert.equal(process.env.LOCAL_OWNER_MODE, "trusted-loopback");
assert.equal(process.env.OWNER_PASSWORD, "");
const host = new URL(origin).host;
assert.notEqual(new URL(origin).port, "8787");
const token = process.env.STICKER_AGENT_TOKEN;
assert.ok(token);
async function api(path, method = "GET", body, headers = {}) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = request(
      `${process.env.STICKER_SMOKE_API_URL ?? "http://127.0.0.1:8787"}/api${path}`,
      {
        method,
        headers: {
          host,
          origin,
          "content-type": "application/json",
          ...headers,
        },
        timeout: 10000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: text ? JSON.parse(text) : null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Fixture request timeout")));
    req.end(data);
  });
}
assert.equal((await api("/bootstrap")).status, 200);
assert.equal((await api("/access-mode")).body.mode, "trusted-loopback");
const login = await api("/session", "POST", {});
assert.equal(login.status, 200);
assert.equal(login.headers["set-cookie"], undefined);
for (const headers of [
  { host: "evil.invalid" },
  { origin: "https://evil.invalid" },
  { origin: "null" },
  { "sec-fetch-site": "cross-site" },
  { "x-forwarded-host": host },
]) {
  assert.equal(
    (await api("/bootstrap", "GET", undefined, headers)).status,
    403,
  );
}
assert.equal(
  (
    await api("/bootstrap", "GET", undefined, {
      authorization: "Bearer invalid-fixture",
    })
  ).status,
  401,
);
assert.equal(
  (
    await api("/bootstrap", "GET", undefined, {
      authorization: `Bearer ${token}`,
      host: "127.0.0.1:8787",
    })
  ).status,
  200,
);
assert.equal(
  (
    await api(
      "/projects",
      "POST",
      { name: "Must not exist", key: "DENIED" },
      { authorization: `Bearer ${token}` },
    )
  ).status,
  403,
);
const created = await api("/projects", "POST", {
  name: "Local owner fixture",
  key: "LOCALOWN",
});
assert.equal(created.status, 201, JSON.stringify(created.body));
assert.equal((await api(`/projects/${created.body.id}`, "DELETE")).status, 204);
console.log(
  "Trusted Docker owner fixture passed: password absent, owner mutations, exact origin/host and agent separation.",
);
