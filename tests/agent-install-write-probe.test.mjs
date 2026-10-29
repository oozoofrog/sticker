import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import "./fixtures/agent-install-write-probe/candidate.js";
function fixture(failure) {
  const calls = [];
  const files = new Map();
  let temp;
  const io = {
    openParent() {
      calls.push("open");
      if (failure === "symlink") throw new Error("parent_unverified");
      return 10;
    },
    createTemp(fd) {
      assert.equal(fd, 10);
      temp = { fd: 11, name: ".sticker-write.ABC123abc123" };
      files.set(temp.name, "");
      return temp;
    },
    write(fd, value) {
      assert.equal(fd, 11);
      calls.push("write");
      files.set(temp.name, value);
      if (failure === "write") throw new Error("write_unverified");
    },
    sync(fd) {
      calls.push("sync" + fd);
      if (failure === "sync" && fd === 11) throw new Error("sync_unverified");
    },
    close(fd) {
      calls.push("close" + fd);
      if (failure === "close" && fd === 11) throw new Error("close_unverified");
    },
    publish(fd, name, target) {
      assert.equal(fd, 10);
      calls.push("publish");
      if (failure === "competitor") files.set(target, "foreign");
      if (files.has(target)) throw new Error("destination_exists");
      if (failure === "unsupported") throw new Error("publish_unverified");
      files.set(target, files.get(name));
      files.delete(name);
    },
    remove(fd, name) {
      assert.equal(fd, 10);
      assert.equal(name, temp.name);
      calls.push("remove");
      if (failure === "cleanup") throw new Error("cleanup_unverified");
      files.delete(name);
    },
  };
  if (failure === "cleanup")
    io.write = () => {
      throw new Error("write_unverified");
    };
  return { io, calls, files };
}
test("candidate publishes complete bytes after sync/close without replacing a competitor", () => {
  for (const failure of [
    undefined,
    "competitor",
    "unsupported",
    "write",
    "sync",
    "close",
    "symlink",
    "cleanup",
  ]) {
    const f = fixture(failure);
    const r = globalThis.StickerWriteCandidate.writeNew(
      f.io,
      "/fixture",
      "plugin.json",
      "full bytes",
    );
    if (!failure) {
      assert.equal(r.state, "published");
      assert.equal(f.files.get("plugin.json"), "full bytes");
      assert.ok(f.calls.indexOf("sync11") < f.calls.indexOf("publish"));
      assert.ok(f.calls.indexOf("close11") < f.calls.indexOf("publish"));
    } else {
      assert.equal(r.state, "unverified");
      assert.equal(
        f.files.get("plugin.json"),
        failure === "competitor" ? "foreign" : undefined,
      );
    }
    assert.ok(f.calls.filter((c) => c === "close11").length <= 1);
    assert.ok(f.calls.filter((c) => c === "close10").length <= 1);
    if (failure === "cleanup") assert.equal(r.cleanup, "unverified");
  }
});
test("candidate rejects ambiguous paths and names before native calls", () => {
  for (const [parent, name] of [
    ["relative", "x"],
    ["/fixture/../other", "x"],
    ["/fixture", "../x"],
    ["/fixture", "x/y"],
    ["/fixture", "."],
  ]) {
    const f = fixture();
    assert.equal(
      globalThis.StickerWriteCandidate.writeNew(f.io, parent, name, "x").state,
      "unverified",
    );
    assert.equal(f.calls.length, 0);
  }
});
test("current actual source check then atomic write permits a competing newly-created file to be replaced", () => {
  const source = readFileSync(
    new URL("../packaging/agent-install/installer.jxa.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  const write ="),
    end = source.indexOf("  try {", start);
  const files = new Map();
  const path = "/fixture/fixed-plugin.json";
  const fm = { fileExistsAtPath: () => false };
  const sandbox = {
    fm,
    $: () => ({
      writeToFileAtomicallyEncodingError(file) {
        files.set(file, "fixed contents");
        return true;
      },
    }),
    fail: (code) => {
      throw new Error(code);
    },
  };
  sandbox.$.NSUTF8StringEncoding = 4;
  vm.createContext(sandbox);
  vm.runInContext(
    source.slice(start, end) + "globalThis.actualWrite=write;",
    sandbox,
  );
  assert.equal(fm.fileExistsAtPath(path), false);
  files.set(path, "concurrent user contents");
  sandbox.actualWrite(path, "fixed contents");
  assert.equal(files.get(path), "fixed contents"); // API-contract reproduction, not an actual Mac race.
});

test("bad native name cannot delete an unknown path; post-publish sync failure retains published truth", () => {
  const f = fixture();
  const create = f.io.createTemp;
  f.io.createTemp = (fd) => ({ ...create(fd), name: "../unknown" });
  const r = globalThis.StickerWriteCandidate.writeNew(
    f.io,
    "/fixture",
    "plugin.json",
    "x",
  );
  assert.equal(r.error, "temp_name_unverified");
  assert.equal(r.cleanup, "unverified");
  assert.ok(!f.calls.includes("remove"));
  assert.equal(f.calls.filter((c) => c === "close11").length, 1);
  const g = fixture();
  const sync = g.io.sync;
  g.io.sync = (fd) => {
    sync(fd);
    if (fd === 10) throw new Error("sync_unverified");
  };
  const s = globalThis.StickerWriteCandidate.writeNew(
    g.io,
    "/fixture",
    "plugin.json",
    "x",
  );
  assert.equal(s.published, true);
  assert.equal(s.state, "published_unverified");
  assert.equal(g.files.get("plugin.json"), "x");
  assert.ok(!g.calls.includes("remove"));
});

test("candidate bounds UTF8 bytes before acquiring native descriptors", () => {
  const f = fixture();
  assert.equal(
    globalThis.StickerWriteCandidate.writeNew(
      f.io,
      "/fixture",
      "x",
      "가".repeat(699051),
    ).error,
    "input_unverified",
  );
  assert.equal(f.calls.length, 0);
  const g = fixture();
  assert.equal(
    globalThis.StickerWriteCandidate.writeNew(
      g.io,
      "/fixture",
      "x",
      "😀".repeat(524288),
    ).state,
    "published",
  );
});
test("prototype native source parses but is not bundled or loaded by the product", () => {
  for (const file of ["native.jxa", "probe.jxa"]) {
    const source = readFileSync(
      new URL(`./fixtures/agent-install-write-probe/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotThrow(() => new vm.Script(source));
  }
  const source = readFileSync(
    new URL("../server/agent-install.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!source.includes("agent-install-write-probe"));
});

test("native probe puts a real directory after the symlink component", () => {
  const source = readFileSync(
    new URL("./fixtures/agent-install-write-probe/probe.jxa", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.includes(
      "root+'/probe-parent-link/probe-real-dir','must-not-exist.txt'",
    ),
  );
  assert.ok(
    source.includes(
      "createDirectoryAtPathWithIntermediateDirectoriesAttributesError(root+'/probe-real-dir'",
    ),
  );
  assert.ok(
    source.includes(
      "!fm.fileExistsAtPath(root+'/probe-real-dir/must-not-exist.txt')",
    ),
  );
});

test("native probe pass predicate rejects ambiguous conflict, cleanup, and directory results", () => {
  const source = readFileSync(
    new URL("./fixtures/agent-install-write-probe/probe.jxa", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("    const refused ="),
    end = source.indexOf("\n  } catch(error)", start);
  const good = {
    exactBytes: true,
    mode0600: true,
    newFile: { published: true, state: "published" },
    existingPreserved: true,
    symlinkTargetPreserved: true,
    directoryPreserved: true,
    intermediateRefused: true,
    noTempLeft: true,
  };
  for (const name of ["existing", "symlink", "existingDirectory"])
    good[name] = {
      published: false,
      state: "unverified",
      error: "destination_exists",
    };
  good.intermediateSymlink = {
    published: false,
    state: "unverified",
    error: "parent_unverified",
  };
  for (const change of [
    undefined,
    (r) => {
      r.existing.published = true;
    },
    (r) => {
      r.symlink.cleanup = "unverified";
    },
    (r) => {
      r.existingDirectory.state = "published";
    },
    (r) => {
      r.directoryPreserved = false;
    },
    (r) => {
      r.intermediateSymlink.published = true;
    },
  ]) {
    const result = structuredClone(good);
    change?.(result);
    vm.runInNewContext(source.slice(start, end), { result });
    assert.equal(result.passed, !change);
  }
});
