import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postcss from "postcss";
void test("resource and GitHub feature rules retain independent selector scopes", () => {
  const root = postcss.parse(readFileSync("client/styles.css", "utf8"));
  let resources = 0;
  let github = 0;
  root.walkRules((rule) => {
    if (!/\.(?:resource-|github-)/.test(rule.selector)) return;
    if (rule.selector.includes(".resource-")) resources++;
    if (rule.selector.includes(".github-")) github++;
    let parent = rule.parent;
    while (parent && parent.type !== "root") {
      assert.notEqual(
        parent.type,
        "rule",
        `Unexpected selector parent for ${rule.selector}`,
      );
      parent = parent.parent;
    }
  });
  assert.ok(resources >= 30);
  assert.ok(github >= 10);
});
