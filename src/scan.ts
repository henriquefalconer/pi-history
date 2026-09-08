import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { HEADLESS_MARKER, userPromptText } from "./history.js";

/**
 * Upper bound on prompts seeded into the editor. Pi's Editor keeps at most 100
 * history entries, so anything beyond that would be discarded immediately.
 * A session's prompts are monotonic in time, so keeping only its newest
 * MAX_PROMPTS entries in the cache can never change the global result.
 */
export const MAX_PROMPTS = 100;
/** Lines longer than this can't be prompts worth seeding; skip parsing them. */
const MAX_LINE_BYTES = 256 * 1024;
/** How many session files to stream concurrently on a cold cache. */
const CONCURRENCY = 16;
const CACHE_VERSION = 1;

export type PromptRecord = { prompt: string; timestamp: number };
type CachedSession = { size: number; mtime: number; prompts: PromptRecord[] };
type Cache = { version: number; sessions: Record<string, CachedSession> };
type FileInfo = { path: string; size: number; mtime: number };

/** Recursively list every .jsonl under dir (sessions may be nested in forks/). */
export async function listSessionFiles(dir: string): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const full = join(current, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
      try {
        const info = await stat(full);
        out.push({ path: full, size: info.size, mtime: info.mtimeMs });
      } catch {
        // Session disappeared while listing.
      }
    }));
  };
  await walk(dir);
  return out;
}

/**
 * Stream one session file and return its user prompts without ever holding
 * the whole session in memory. Returns [] for headless sessions.
 */
export async function scanSessionPrompts(path: string, modified: number): Promise<PromptRecord[]> {
  const prompts: PromptRecord[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length > MAX_LINE_BYTES) continue;
      // Cheap pre-filter: avoid JSON.parse on tool results, assistant output, etc.
      const isUser = line.includes('"role":"user"');
      if (!isUser && !line.includes(HEADLESS_MARKER)) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const candidate = entry as { type?: unknown; customType?: unknown; timestamp?: unknown };
      if (candidate.type === "custom" && candidate.customType === HEADLESS_MARKER) return [];
      const prompt = userPromptText(entry)?.trim();
      if (!prompt) continue;
      const parsed = typeof candidate.timestamp === "string" ? Date.parse(candidate.timestamp) : Number.NaN;
      prompts.push({ prompt, timestamp: Number.isFinite(parsed) ? parsed : modified });
    }
  } finally {
    rl.close();
  }
  return prompts.length > MAX_PROMPTS ? prompts.slice(-MAX_PROMPTS) : prompts;
}

async function readCache(cachePath: string): Promise<Cache> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Cache;
    if (parsed?.version === CACHE_VERSION && parsed.sessions && typeof parsed.sessions === "object") return parsed;
  } catch {
    // Missing or corrupt cache: rebuild from scratch.
  }
  return { version: CACHE_VERSION, sessions: {} };
}

async function writeCache(cachePath: string, cache: Cache): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cache));
    await rename(tmp, cachePath);
  } catch {
    // The cache is only an accelerator; a failed write costs one more scan.
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Return prompts from every session under sessionsDir, newest first, bounded
 * by MAX_PROMPTS. Sessions are streamed line by line and results are cached by
 * (size, mtime) so subsequent starts only re-read sessions that changed.
 */
export async function promptsFromSessionsDir(sessionsDir: string, cachePath: string, currentPath?: string): Promise<string[]> {
  const [files, cache] = await Promise.all([listSessionFiles(sessionsDir), readCache(cachePath)]);
  const relevant = files.filter((file) => file.path !== currentPath);
  const stale = relevant.filter((file) => {
    const cached = cache.sessions[file.path];
    return !cached || cached.size !== file.size || cached.mtime !== file.mtime;
  });

  const scanned = await mapLimit(stale, CONCURRENCY, async (file) => {
    try {
      return { file, prompts: await scanSessionPrompts(file.path, file.mtime) };
    } catch {
      return null;
    }
  });

  const next: Cache = { version: CACHE_VERSION, sessions: {} };
  for (const file of relevant) {
    const cached = cache.sessions[file.path];
    if (cached && cached.size === file.size && cached.mtime === file.mtime) next.sessions[file.path] = cached;
  }
  for (const result of scanned) {
    if (result) next.sessions[result.file.path] = { size: result.file.size, mtime: result.file.mtime, prompts: result.prompts };
  }
  // Keep the current session's cached entry, if any, so it isn't rescanned later.
  if (currentPath && cache.sessions[currentPath]) next.sessions[currentPath] = cache.sessions[currentPath] as CachedSession;
  if (stale.length > 0 || Object.keys(next.sessions).length !== Object.keys(cache.sessions).length) {
    await writeCache(cachePath, next);
  }

  const records: Array<PromptRecord & { order: number }> = [];
  let order = 0;
  for (const file of relevant) {
    for (const record of next.sessions[file.path]?.prompts ?? []) records.push({ ...record, order: order++ });
  }
  return records
    .sort((a, b) => b.timestamp - a.timestamp || b.order - a.order)
    .slice(0, MAX_PROMPTS)
    .map((record) => record.prompt);
}
