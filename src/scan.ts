import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { includeInGlobalHistory, markerKind, type SessionKind, userPromptText } from "./history.js";

/**
 * Upper bound on prompts seeded into the editor. Pi's native Editor keeps 100
 * entries; the seeded editor raises its own limit to match this value.
 * A session's prompts are monotonic in time, so keeping only its newest
 * MAX_PROMPTS entries in the cache can never change the global result.
 */
export const MAX_PROMPTS = 1000;
/** Lines longer than this can't be prompts worth seeding; skip parsing them. */
const MAX_LINE_BYTES = 256 * 1024;
/** How many session files to stream concurrently on a cold cache. */
const CONCURRENCY = 16;
const CACHE_VERSION = 3;
const MARKER_PREFIX = "hfalconer/pi-history:";

export type PromptRecord = { prompt: string; timestamp: number };
export type SessionScan = { kind: SessionKind; promptCount: number; prompts: PromptRecord[] };
type CachedSession = SessionScan & { size: number; mtime: number };
type Cache = { version: number; markerSince: number; sessions: Record<string, CachedSession> };
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
 * Stream one session file and return its user prompts and marker kind without
 * ever holding the whole session in memory. A headless marker stops the scan.
 */
export async function scanSession(path: string, modified: number): Promise<SessionScan> {
  const prompts: PromptRecord[] = [];
  let kind: SessionKind = "unknown";
  let promptCount = 0;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length > MAX_LINE_BYTES) continue;
      // Cheap pre-filter: avoid JSON.parse on tool results, assistant output, etc.
      const isUser = line.includes('"role":"user"');
      if (!isUser && !line.includes(MARKER_PREFIX)) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const marker = markerKind(entry);
      if (marker === "headless") return { kind: "headless", promptCount, prompts: [] };
      if (marker === "interactive") kind = "interactive";
      const prompt = userPromptText(entry)?.trim();
      if (!prompt) continue;
      promptCount++;
      const timestampValue = (entry as { timestamp?: unknown }).timestamp;
      const parsed = typeof timestampValue === "string" ? Date.parse(timestampValue) : Number.NaN;
      prompts.push({ prompt, timestamp: Number.isFinite(parsed) ? parsed : modified });
      if (prompts.length > MAX_PROMPTS) prompts.shift();
    }
  } finally {
    rl.close();
  }
  return { kind, promptCount, prompts };
}

async function readCache(cachePath: string): Promise<Cache> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Cache;
    if (parsed?.version === CACHE_VERSION && parsed.sessions && typeof parsed.sessions === "object" &&
      typeof parsed.markerSince === "number") return parsed;
  } catch {
    // Missing or corrupt cache: rebuild from scratch.
  }
  return { version: CACHE_VERSION, markerSince: Number.NaN, sessions: {} };
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

type SyncedCache = { cache: Cache; markerSince: number };

/**
 * Bring the cache up to date for `files`: stream sessions whose size or mtime
 * changed, keep the rest. With `prune`, entries for files not listed are
 * dropped (used by the full scan so deleted sessions leave the cache).
 */
async function syncCache(files: FileInfo[], cachePath: string, options: { prune: boolean; keep?: string; now: number }): Promise<SyncedCache> {
  const cache = await readCache(cachePath);
  // The first run of a marker-aware version fixes the point after which
  // unmarked sessions are treated as headless. It is persisted so it survives.
  const markerSince = Number.isFinite(cache.markerSince) ? cache.markerSince : options.now;
  const fresh = (file: FileInfo): CachedSession | undefined => {
    const cached = cache.sessions[file.path];
    return cached && cached.size === file.size && cached.mtime === file.mtime ? cached : undefined;
  };
  const stale = files.filter((file) => !fresh(file));
  const scanned = await mapLimit(stale, CONCURRENCY, async (file) => {
    try {
      return { file, scan: await scanSession(file.path, file.mtime) };
    } catch {
      return null;
    }
  });

  const sessions: Record<string, CachedSession> = options.prune ? {} : { ...cache.sessions };
  if (options.prune) {
    for (const file of files) {
      const cached = fresh(file);
      if (cached) sessions[file.path] = cached;
    }
    if (options.keep && cache.sessions[options.keep]) sessions[options.keep] = cache.sessions[options.keep] as CachedSession;
  }
  for (const result of scanned) {
    if (result) sessions[result.file.path] = { size: result.file.size, mtime: result.file.mtime, ...result.scan };
  }
  const next: Cache = { version: CACHE_VERSION, markerSince, sessions };
  const changed = markerSince !== cache.markerSince || stale.length > 0 ||
    Object.keys(sessions).length !== Object.keys(cache.sessions).length;
  if (changed) await writeCache(cachePath, next);
  return { cache: next, markerSince };
}

/**
 * Return prompts from every session under sessionsDir, newest first, bounded
 * by MAX_PROMPTS. Sessions are streamed line by line and results are cached by
 * (size, mtime) so subsequent starts only re-read sessions that changed.
 */
export async function promptsFromSessionsDir(sessionsDir: string, cachePath: string, currentPath?: string, now = Date.now()): Promise<string[]> {
  const files = (await listSessionFiles(sessionsDir)).filter((file) => file.path !== currentPath);
  const { cache, markerSince } = await syncCache(files, cachePath, { prune: true, keep: currentPath, now });

  const records: Array<PromptRecord & { order: number }> = [];
  let order = 0;
  for (const file of files) {
    const session = cache.sessions[file.path];
    if (!session || !includeInGlobalHistory(session.kind, session.promptCount, file.mtime, markerSince)) continue;
    for (const record of session.prompts) records.push({ ...record, order: order++ });
  }
  return records
    .sort((a, b) => b.timestamp - a.timestamp || b.order - a.order)
    .slice(0, MAX_PROMPTS)
    .map((record) => record.prompt);
}

/**
 * Keep only interactive sessions from a list produced by Pi's own session
 * listing (used for /resume). The current session is always kept. Sessions
 * already classified in the cache cost one stat each; new ones are streamed.
 */
export async function filterInteractiveSessions<T extends { path: string }>(sessions: readonly T[], cachePath: string, currentPath?: string, now = Date.now()): Promise<T[]> {
  const files: FileInfo[] = [];
  await mapLimit([...sessions], 64, async (session) => {
    try {
      const info = await stat(session.path);
      files.push({ path: session.path, size: info.size, mtime: info.mtimeMs });
    } catch {
      // Vanished since Pi listed it; Pi's own selector handles that case.
    }
  });
  const { cache, markerSince } = await syncCache(files, cachePath, { prune: false, now });
  const byPath = new Map(files.map((file) => [file.path, file]));
  return sessions.filter((session) => {
    if (session.path === currentPath) return true;
    const file = byPath.get(session.path);
    const cached = file && cache.sessions[file.path];
    if (!file || !cached) return true;
    return includeInGlobalHistory(cached.kind, cached.promptCount, file.mtime, markerSince);
  });
}
