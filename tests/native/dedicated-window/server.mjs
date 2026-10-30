// No credentials, production requests or browser dispatch. Fresh fixture only.
import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
const root = process.argv[2];
if (!/^\/private\/tmp\/sticker-product-[A-Za-z0-9_-]+$/.test(root))
  throw Error("fresh private fixture required");
if ((lstatSync(root).mode & 0o777) !== 0o700) throw Error("mode0700 required");
const record = (x) =>
  appendFileSync(join(root, "requests.jsonl"), JSON.stringify(x) + "\n", {
    mode: 0o600,
  });
let loads = 0;
const html = `<!doctype html><meta charset=utf-8><title>Sticker synthetic product test</title><style>body{margin:20px}textarea{width:90%;height:100px}.space{height:1800px}</style><h1>합성 전용 창 검증</h1><textarea id=draft aria-label="합성 입력"></textarea><a id=external href=https://example.invalid/fixture>외부 링크 검증</a><a id=blob download=fixture.txt>다운로드</a><input id=file type=file><button onclick="window.answer=confirm('합성 확인')">확인</button><div class=space></div><div id=bottom>끝</div><script>window.docID=crypto.randomUUID();window.answer='pending';document.querySelector('#blob').href=URL.createObjectURL(new Blob(['Sticker synthetic download 한글\\n']));</script>`;
const server = createServer((req, res) => {
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
    res.writeHead(403).end();
    return;
  }
  if (readFileSync(join(root, "online"), "utf8").trim() !== "yes") {
    record({ event: "offline" });
    req.socket.destroy();
    return;
  }
  record({ url: req.url });
  if (req.url === "/") {
    loads++;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }
  if (req.url === "/redirect-download") {
    res.writeHead(302, { Location: "/download-final" }).end();
    return;
  }
  if (req.url === "/download-final") {
    res
      .writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="redirect.txt"',
      })
      .end("redirect must not be followed");
    return;
  }
  if (req.url === "/metrics") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ loads }));
    return;
  }
  if (req.url === "/frame") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<a id=escape target=_top href=https://example.invalid/iframe>escape</a>",
    );
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () =>
  writeFileSync(
    join(root, "origin"),
    `http://127.0.0.1:${server.address().port}`,
    { flag: "wx", mode: 0o600 },
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close(() => process.exit(0)));
