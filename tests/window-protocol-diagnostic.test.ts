import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

function diagnose(absent = "", rejected = "", unknown = "") {
  const registrations: string[] = [];
  const context = {
    ObjC: {
      import: () => undefined,
      registerSubclass: (input: { protocols: string[] }) => {
        const name = input.protocols[0];
        registrations.push(name);
        if (name === rejected) throw new Error("protocol does not exist");
      },
    },
    $: {
      NSProtocolFromString: (name: string) =>
        name === unknown
          ? {}
          : {
              isNil: () => name === absent,
            },
    },
    run: undefined as undefined | (() => string),
  };
  runInNewContext(
    readFileSync(
      new URL("./native/dedicated-window/Protocols.jxa", import.meta.url),
      "utf8",
    ),
    context,
  );
  assert.ok(context.run);
  return {
    report: JSON.parse(context.run()) as {
      stage: string;
      protocol?: string;
      lookups: unknown[];
    },
    registrations,
  };
}
void test("protocol diagnostic checks every runtime name before registering and fails closed on absent protocol", () => {
  const { report, registrations } = diagnose("WKDownloadDelegate");
  assert.equal(report.stage, "runtime_protocol_absent");
  assert.equal(report.protocol, "WKDownloadDelegate");
  assert.equal(report.lookups.length, 4);
  assert.deepEqual(registrations, []);
});
void test("protocol diagnostic identifies the first JXA registration failure and stops", () => {
  const { report, registrations } = diagnose("", "WKNavigationDelegate");
  assert.equal(report.stage, "jxa_registration_failed");
  assert.equal(report.protocol, "WKNavigationDelegate");
  assert.deepEqual(registrations, ["NSWindowDelegate", "WKNavigationDelegate"]);
});
void test("protocol diagnostic successful registration is not a WebKit callback claim", () => {
  const { report, registrations } = diagnose();
  assert.equal(report.stage, "registration_only_pass");
  assert.equal(registrations.length, 4);
});

void test("protocol diagnostic does not interpret unknown truthy bridge values as support", () => {
  const { report, registrations } = diagnose("", "", "WKUIDelegate");
  assert.equal(report.stage, "lookup_unverified");
  assert.equal(report.protocol, "WKUIDelegate");
  assert.deepEqual(registrations, []);
});
