import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SEEN_FILE = new URL("../data/seen.json", import.meta.url);
const MAX_SEEN = 1000;

export async function loadSeen(): Promise<Set<string>> {
  try {
    const raw = await readFile(SEEN_FILE, "utf-8");
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

export async function saveSeen(seen: Set<string>): Promise<void> {
  const ids = [...seen].slice(-MAX_SEEN);
  await mkdir(dirname(SEEN_FILE.pathname), { recursive: true });
  await writeFile(SEEN_FILE, JSON.stringify(ids, null, 2));
}
