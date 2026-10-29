// Logical data + exact uploaded bytes, rather than unstable WAL/file timestamps.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.env.DATA_DIR ?? "/app/data";
const db = new DatabaseSync(join(directory, "sticker.sqlite"), {
  readOnly: true,
});
const tables = {};
try {
  db.exec("BEGIN");
  for (const { name } of db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()) {
    const quoted = name.replaceAll('"', '""');
    tables[name] = db
      .prepare(`SELECT * FROM "${quoted}"`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort();
  }
  db.exec("COMMIT");
} finally {
  db.close();
}
const files = {};
function walk(relative) {
  for (const item of readdirSync(join(directory, relative), {
    withFileTypes: true,
  }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${relative}/${item.name}`;
    if (item.isDirectory()) walk(path);
    else if (item.isFile())
      files[path] = createHash("sha256")
        .update(readFileSync(join(directory, path)))
        .digest("hex");
    else throw new Error("Unexpected non-regular fixture upload");
  }
}
walk("uploads");
console.log(JSON.stringify({ tables, files }));
