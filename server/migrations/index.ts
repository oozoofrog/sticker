import { github } from "./008-github.js";
import type { DatabaseSync } from "node:sqlite";
import { history } from "./009-history.js";
import { initial } from "./001-initial.js";
import { sessions } from "./002-sessions.js";
import { releases } from "./004-releases.js";
import { relations } from "./003-relations.js";
import { resources } from "./007-resources.js";
import { templates } from "./006-templates.js";
import { views } from "./005-views.js";
export interface Migration {
  version: number;
  run: (db: DatabaseSync) => void;
}
export const migrations: readonly Migration[] = [
  { version: 1, run: initial },
  { version: 2, run: sessions },
  { version: 3, run: relations },
  { version: 4, run: releases },
  { version: 5, run: views },
  { version: 6, run: templates },
  { version: 7, run: resources },
  { version: 8, run: github },
  { version: 9, run: history },
];
/** One transaction for every pending migration; never mutate a future-version database. */
export function migrate(
  db: DatabaseSync,
  steps: readonly Migration[] = migrations,
): void {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  const latest = steps.at(-1)?.version ?? 0;
  if (version > latest)
    throw new Error("This database was created by a newer Sticker version.");
  if (version === latest) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of steps) {
      if (step.version <= version) continue;
      if (!Number.isSafeInteger(step.version) || step.version < 1)
        throw new Error("Invalid migration version");
      step.run(db);
      db.exec(`PRAGMA user_version=${String(step.version)}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
