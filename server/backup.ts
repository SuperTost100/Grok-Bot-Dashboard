// Write a consistent copy of the database while the server runs, then check it opens.
// Usage: node server/backup.ts [destination]   (default: DATA_DIR/backups/manual-<time>.db)
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";

const dataDir = path.resolve(process.env.DATA_DIR ?? "data");
const dest = path.resolve(process.argv[2] ?? path.join(dataDir, "backups", `manual-${new Date().toISOString().replace(/[:.]/g, "-")}.db`));
fs.mkdirSync(path.dirname(dest), { recursive: true });
const src = new DatabaseSync(path.join(dataDir, "dashboard.db"), { readOnly: true });
await backup(src, dest);
src.close();
const check = new DatabaseSync(dest, { readOnly: true });
const ok = (check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
const items = (check.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
check.close();
if (ok !== "ok") {
  console.error(`Backup at ${dest} failed its integrity check: ${ok}`);
  process.exit(1);
}
console.log(`Backup written to ${dest} (${items} cards, integrity ok)`);
