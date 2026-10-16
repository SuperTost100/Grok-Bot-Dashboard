// Reads the files under one folder of a .tar.gz, like the archive GitHub serves for a commit.
// Just enough of the format for that: regular files, folders, and the pax headers GitHub adds.

import zlib from "node:zlib";
import path from "node:path";

const MAX_FILES = 2000;
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * The files under `folder` (relative to the archive's single top folder), keyed by their path inside it.
 * Paths that would climb out of the folder are refused.
 */
export function filesUnder(tgz: Buffer, folder: string): Map<string, Buffer> {
  const tar = zlib.gunzipSync(tgz, { maxOutputLength: MAX_BYTES });
  const want = folder.replace(/^\/+|\/+$/g, "");
  const out = new Map<string, Buffer>();
  let paxPath = "";
  let total = 0;
  for (let at = 0; at + 512 <= tar.length; ) {
    const head = tar.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    const field = (o: number, n: number) => head.subarray(o, o + n).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    const name = paxPath || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // A pax header for the next entry: only its long path matters here.
      paxPath = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? "";
      continue;
    }
    paxPath = "";
    if (type !== "0") continue;
    // GitHub puts everything under one "owner-repo-sha/" folder.
    const inRepo = name.split("/").slice(1).join("/");
    if (want && !inRepo.startsWith(want + "/")) continue;
    const rel = want ? inRepo.slice(want.length + 1) : inRepo;
    const clean = path.posix.normalize(rel);
    if (!clean || clean.startsWith("..") || path.posix.isAbsolute(clean)) throw new Error(`Refused a file outside the folder: ${rel}`);
    total += size;
    if (out.size >= MAX_FILES || total > MAX_BYTES) throw new Error("The folder is too big to install.");
    out.set(clean, Buffer.from(body));
  }
  return out;
}
