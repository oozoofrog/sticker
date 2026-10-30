import assert from "node:assert/strict";
import test from "node:test";
import config from "../vite.config.ts";

void test("Vite upgrades retain the existing supported browser build targets", () => {
  assert.deepEqual(config.build?.target, [
    "chrome107",
    "edge107",
    "firefox104",
    "safari16",
  ]);
});
