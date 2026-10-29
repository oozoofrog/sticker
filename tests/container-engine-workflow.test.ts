import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

void test("container CI pins its ephemeral Engine and verifies the server without expanding permissions", () => {
  const workflow = readFileSync(".github/workflows/container.yml", "utf8");
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /permissions:\n {2}contents: read\n/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /uses: docker\/setup-docker-action@7ec28a010822b4626af4874f9448a4b05ac6f3e5/,
  );
  assert.match(workflow, /version: "v29\.9\.2"/);
  assert.match(
    workflow,
    /test "\$\(docker version --format '\{\{\.Server\.Version\}\}'\)" = "29\.9\.2"/,
  );
  assert.ok(
    workflow.indexOf("uses: docker/setup-docker-action@") <
      workflow.indexOf("bash scripts/verify-container.sh"),
  );
  assert.doesNotMatch(
    workflow,
    /tcp-port:|set-host:|self-hosted|secrets\.|contents: write/,
  );
});
