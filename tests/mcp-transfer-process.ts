/** Test-only launcher executes the real CLI entry without changing SDK buffers. */
import { fileURLToPath } from "node:url";
import { processTransferArena } from "../server/mcp/transfer-arena.js";
const peak = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
const sample = () => {
  const usage = process.memoryUsage();
  for (const key of ["rss", "heapUsed", "external", "arrayBuffers"] as const)
    peak[key] = Math.max(peak[key], usage[key]);
};
sample();
const timer = setInterval(sample, 5);
timer.unref();
let printed = false;
process.on("beforeExit", () => {
  if (printed) return;
  printed = true;
  sample();
  clearInterval(timer);
  process.stderr.write(
    `STICKER_TRANSFER_MEMORY ${JSON.stringify({ node: process.version, platform: process.platform, peak, arena: processTransferArena.stats() })}\n`,
  );
});
const entry = new URL(
  `../server/mcp.${import.meta.url.endsWith(".js") ? "js" : "ts"}`,
  import.meta.url,
);
process.argv[1] = fileURLToPath(entry);
await import(entry.href);
