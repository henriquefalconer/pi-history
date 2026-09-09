import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { includeInGlobalHistory, markerKind, type SessionKind, userPromptText } from "./history.js";

/**
 * Upper bound on prompts seeded into the editor. Pi's native Editor keeps 100
 * entries; the seeded editor raises its own limit to match this value.
 * A session's prompts are monotonic in time, so keeping only its newest
 * MAX_PROMPTS entries in the cache can never change the global result.
 */
export const MAX_PROMPTS = 1000;
/** Lines longer than this are counted but not parsed; they are tool output, not prompts. */
const MAX_LINE_BYTES = 1024 * 1024;
/** Per-session cap on cached search text for the /resume selector. */
const MAX_SEARCH_BYTES = 64 * 1024;
/** The selector shows one line of the first message; cache no more than this. */
const MAX_FIRST_MESSAGE_CHARS = 500;
/** How many session files to stream concurrently on a cold cache. */
const CONCURRENCY = 16;
const CACHE_VERSION = 4;
const MARKER_PREFIX = "hfalconer/pi-history:";

export type PromptRecord = { prompt: string; timestamp: number };
/** Everything Pi's session selector shows or searches, minus the text of every message. */
export type SessionSummary = {
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: number;
  lastActivity?: number;
  messageCount: number;
  firstMessage: string;
};
export type SessionScan = { kind: SessionKind; promptCount: number; prompts: PromptRecord[]; summary?: SessionSummary; search: string };
type CachedSession = Omit<SessionScan, "search"> & { size: number; mtime: number; search?: string };
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

type MessageLike = { role?: unknown; content?: unknown; timestamp?: unknown };

/** Same text extraction as Pi's session listing. */
function messageText(message: MessageLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join(" ");
}

/**
 * Stream one session file and return its user prompts, marker kind and the
 * summary Pi's session selector needs, without ever holding the whole session
 * in memory. A headless marker stops the scan early.
 */
export async function scanSession(path: string, modified: number): Promise<SessionScan> {
  const prompts: PromptRecord[] = [];
  let kind: SessionKind = "unknown";
  let promptCount = 0;
  let summary: SessionSummary | undefined;
  let lastActivity: number | undefined;
  let messageCount = 0;
  let firstMessage = "";
  let search = "";
  let first = true;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (first) {
        first = false;
        try {
          const header = JSON.parse(line) as { type?: unknown; id?: unknown; cwd?: unknown; timestamp?: unknown; parentSession?: unknown };
          if (header.type === "session" && typeof header.id === "string") {
            const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
            summary = {
              id: header.id,
              cwd: typeof header.cwd === "string" ? header.cwd : "",
              parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
              created: Number.isFinite(created) ? created : modified,
              messageCount: 0,
              firstMessage: "",
            };
          }
        } catch {
          // Not a session header; Pi would not list this file either.
        }
        continue;
      }
      const isMessage = line.startsWith('{"type":"message"');
      if (isMessage) messageCount++;
      if (line.length > MAX_LINE_BYTES) continue;
      const isUser = isMessage && line.includes('"role":"user"');
      const isAssistant = isMessage && !isUser && line.includes('"role":"assistant"');
      const isInfo = line.startsWith('{"type":"session_info"');
      if (!isUser && !isAssistant && !isInfo && !line.includes(MARKER_PREFIX)) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const candidate = entry as { type?: unknown; name?: unknown; timestamp?: unknown; message?: MessageLike };
      if (isInfo) {
        if (summary) summary.name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : undefined;
        continue;
      }
      const marker = markerKind(entry);
      if (marker === "headless") return { kind: "headless", promptCount, prompts: [], summary, search: "" };
      if (marker === "interactive") kind = "interactive";
      const message = candidate.type === "message" ? candidate.message : undefined;
      if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
      const activity = typeof message.timestamp === "number"
        ? message.timestamp
        : typeof candidate.timestamp === "string" ? Date.parse(candidate.timestamp) : Number.NaN;
      if (Number.isFinite(activity)) lastActivity = Math.max(lastActivity ?? 0, activity);
      const text = messageText(message);
      if (text && search.length < MAX_SEARCH_BYTES) search += (search ? " " : "") + text.slice(0, MAX_SEARCH_BYTES - search.length);
      if (message.role !== "user") continue;
      if (!firstMessage && text) firstMessage = text.slice(0, MAX_FIRST_MESSAGE_CHARS);
      const prompt = userPromptText(entry)?.trim();
      if (!prompt) continue;
      promptCount++;
      prompts.push({ prompt, timestamp: Number.isFinite(activity) ? activity : modified });
      if (prompts.length > MAX_PROMPTS) prompts.shift();
    }
  } finally {
    rl.close();
  }
  if (summary) Object.assign(summary, { lastActivity, messageCount, firstMessage });
  return { kind, promptCount, prompts, summary, search };
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
    if (!result) continue;
    const { size, mtime } = result.file;
    const { kind, promptCount, prompts, summary, search } = result.scan;
    // Sessions that never surface keep only what classification needs, so the
    // cache stays proportional to the sessions the user actually sees.
    sessions[result.file.path] = includeInGlobalHistory(kind, promptCount, mtime, markerSince)
      ? { size, mtime, kind, promptCount, prompts, summary, search }
      : { size, mtime, kind, promptCount, prompts: [] };
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

export type ListedSession = Omit<SessionSummary, "created" | "lastActivity"> & { path: string; created: Date; modified: Date; allMessagesText: string };

/**
 * Build Pi's session-selector entries for the interactive sessions among
 * `files`, straight from the cache. Only sessions whose size or mtime changed
 * are streamed, so a warm listing costs one stat per file.
 */
export async function listInteractiveSessions(files: FileInfo[], cachePath: string, onProgress?: (loaded: number, total: number) => void, now = Date.now()): Promise<ListedSession[]> {
  const { cache, markerSince } = await syncCache(files, cachePath, { prune: false, now });
  const listed: ListedSession[] = [];
  for (const file of files) {
    const cached = cache.sessions[file.path];
    if (!cached?.summary || !includeInGlobalHistory(cached.kind, cached.promptCount, file.mtime, markerSince)) continue;
    const { created, lastActivity, ...summary } = cached.summary;
    const modified = lastActivity && lastActivity > 0 ? lastActivity : created;
    listed.push({
      ...summary,
      path: file.path,
      created: new Date(created),
      modified: new Date(modified),
      firstMessage: summary.firstMessage || "(no messages)",
      allMessagesText: cached.search ?? "",
    });
  }
  listed.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  onProgress?.(listed.length, listed.length);
  return listed;
}

/** Stat the top-level .jsonl files of one project directory, as Pi's own listing does. */
export async function statSessionFiles(dir: string): Promise<FileInfo[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const files: FileInfo[] = [];
  await mapLimit(names, 64, async (name) => {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      files.push({ path, size: info.size, mtime: info.mtimeMs });
    } catch {
      // Vanished while listing.
    }
  });
  return files;
}

/** Stat every project's top-level session files under the sessions root. */
export async function statAllSessionFiles(sessionsDir: string): Promise<FileInfo[]> {
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => join(sessionsDir, entry.name));
  const perDir = await mapLimit(dirs, 16, (dir) => statSessionFiles(dir));
  return perDir.flat();
}

/** Pi's default per-project session directory, mirrored so listings stay in sync with it. */
export function defaultSessionDir(sessionsDir: string, cwd: string): string {
  const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsDir, safe);
}
