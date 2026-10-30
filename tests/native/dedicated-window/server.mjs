// Synthetic fixture only; binds loopback, has no credentials or production routes.
import { createServer } from "node:http";
import {
  writeFileSync,
  appendFileSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const directory = process.argv[2];
if (
  !directory ||
  !/^\/(private\/)?tmp\/sticker-window-[A-Za-z0-9_-]+$/.test(directory)
)
  throw new Error(
    "Use a fresh /private/tmp/sticker-window-XXXXXXXX directory.",
  );
const stat = lstatSync(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
  throw new Error("Fixture directory must be nonsymlink mode0700.");
const source = resolve(fileURLToPath(new URL(".", import.meta.url)));
const html = readFileSync(join(source, "page.html"));
let loads = 0;
const log = (event) =>
  appendFileSync(
    join(directory, "server.jsonl"),
    JSON.stringify(event) + "\n",
    { mode: 0o600 },
  );
for (const name of ["trace.jsonl", "server.jsonl"])
  writeFileSync(join(directory, name), "", { flag: "wx", mode: 0o600 });
writeFileSync(
  join(directory, "upload.txt"),
  "Sticker synthetic upload 한글\n",
  { flag: "wx", mode: 0o600 },
);
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' blob:; form-action 'none'; base-uri 'none'",
  );
  if (
    req.headers.host !== `127.0.0.1:${server.address().port}` ||
    req.method !== "GET"
  ) {
    res.writeHead(403).end();
    return;
  }
  if (req.url === "/metrics") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ loads }));
    return;
  }
  if (req.url === "/") {
    loads++;
    log({ event: "document", loads });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }
  if (req.url === "/download-redirect") {
    log({ event: "download_redirect_response" });
    res.writeHead(302, { Location: "/download-target" }).end();
    return;
  }
  if (req.url === "/download-target") {
    log({ event: "download_redirect_target_UNEXPECTED" });
    res
      .writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Disposition": "attachment; filename=redirect.txt",
      })
      .end("redirect must not be downloaded");
    return;
  }
  if (req.url === "/redirect") {
    log({ event: "redirect" });
    res.writeHead(302, { Location: "https://example.com/" }).end();
    return;
  }
  if (req.url === "/frame") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<a href="https://example.com/" target="_blank">Untrusted frame external</a>',
    );
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(directory, "fixture.json"),
    JSON.stringify({
      directory,
      trace: join(directory, "trace.jsonl"),
      origin,
      url: `${origin}/`,
    }),
    { flag: "wx", mode: 0o600 },
  );
  console.log(JSON.stringify({ origin, directory, pid: process.pid }));
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close(() => process.exit(0)));
