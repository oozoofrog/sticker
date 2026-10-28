import { readFileSync } from "node:fs";
import {
  validateLocalCompose,
  validateLocalInspection,
} from "./local-deployment.js";
try {
  const data = readFileSync(0);
  if (data.byteLength > 1024 * 1024)
    throw new Error("Deployment metadata exceeds bound.");
  const input: unknown = JSON.parse(data.toString("utf8"));
  if (process.argv[2] === "compose")
    process.stdout.write(`${String(validateLocalCompose(input))}\n`);
  else if (process.argv[2] === "inspect") {
    const port = Number(process.argv[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Missing expected port.");
    validateLocalInspection(input, port);
  } else throw new Error("Unsupported validation mode.");
} catch {
  process.stderr.write(
    "Trusted local deployment validation failed; inspect configuration before starting.\n",
  );
  process.exitCode = 1;
}
