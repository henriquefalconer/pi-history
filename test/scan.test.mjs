import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADLESS_MARKER, INTERACTIVE_MARKER, includeInGlobalHistory } from "../dist-test/history.js";
import { promptsFromSessionsDir, scanSession } from "../dist-test/scan.js";

const line = (obj) => JSON.stringify(obj) + "\n";
const header = line({ type: "session", version: 3, id: "sid", cwd: "/proj", timestamp: "2024-01-01T00:00:00Z" });
const user = (text, ts) => line({ type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text) => line({ type: "message", timestamp: "2024-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text }] } });
const marker = (customType) => line({ type: "custom", customType });
const OLD = new Date("2024-06-01T00:00:00Z");
const SINCE = new Date("2025-01-01T00:00:00Z").getTime();

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-history-"));
  const sessions = join(dir, "sessions", "--proj--");
  await mkdir(join(sessions, "forks"), { recursive: true });
  const files = {
    a: header + user("a1", "2024-01-01T00:00:00Z") + assistant("noise \"role\":\"user\"") + user("a2", "2024-01-03T00:00:00Z"),
    "forks/b": header + user("b1", "2024-01-02T00:00:00Z"),                               // legacy single prompt: looks headless
    headless: header + marker(HEADLESS_MARKER) + user("automation", "2024-01-05T00:00:00Z"),
    interactive: header + marker(INTERACTIVE_MARKER) + user("solo", "2024-01-04T00:00:00Z"), // marked single prompt: kept
    broken: "{not json\n" + user("ok1", "2024-01-06T00:00:00Z") + user("ok2", "2024-01-07T00:00:00Z"),
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(sessions, `${name}.jsonl`);
    await writeFile(path, content);
    await utimes(path, OLD, OLD);
  }
  return { dir, sessions, cache: join(dir, "cache.json"), root: join(dir, "sessions") };
}

test("includeInGlobalHistory policy", () => {
  assert.equal(includeInGlobalHistory("interactive", 1, 0, 0), true);
  assert.equal(includeInGlobalHistory("headless", 5, 0, 0), false);
  assert.equal(includeInGlobalHistory("unknown", 5, SINCE, SINCE), false);   // modified after marker era: headless
  assert.equal(includeInGlobalHistory("unknown", 5, SINCE - 1, SINCE), true); // legacy multi-prompt: keep
  assert.equal(includeInGlobalHistory("unknown", 1, SINCE - 1, SINCE), false); // legacy single prompt: pi -p
});

test("streams user prompts and reports marker kind", async () => {
  const { sessions } = await fixture();
  const a = await scanSession(join(sessions, "a.jsonl"), 0);
  assert.deepEqual({ kind: a.kind, prompts: a.prompts.map((r) => r.prompt), count: a.promptCount }, { kind: "unknown", prompts: ["a1", "a2"], count: 2 });
  const headless = await scanSession(join(sessions, "headless.jsonl"), 0);
  assert.deepEqual({ kind: headless.kind, promptCount: headless.promptCount, prompts: headless.prompts, search: headless.search }, { kind: "headless", promptCount: 0, prompts: [], search: "" });
  assert.equal((await scanSession(join(sessions, "interactive.jsonl"), 0)).kind, "interactive");
});

test("walks nested sessions, applies policy, orders newest first, excludes current", async () => {
  const { sessions, cache, root } = await fixture();
  const all = await promptsFromSessionsDir(root, cache, undefined, SINCE);
  assert.deepEqual(all, ["ok2", "ok1", "solo", "a2", "a1"]);
  const withoutA = await promptsFromSessionsDir(root, cache, join(sessions, "a.jsonl"), SINCE);
  assert.deepEqual(withoutA, ["ok2", "ok1", "solo"]);
});

test("unmarked sessions modified after the marker era are treated as headless", async () => {
  const { sessions, cache, root } = await fixture();
  await promptsFromSessionsDir(root, cache, undefined, SINCE); // fixes markerSince
  const path = join(sessions, "late.jsonl");
  await writeFile(path, header + user("late1", "2026-01-01T00:00:00Z") + user("late2", "2026-01-02T00:00:00Z"));
  const persisted = JSON.parse(await readFile(cache, "utf8"));
  assert.equal(persisted.markerSince, SINCE);
  assert.deepEqual(await promptsFromSessionsDir(root, cache, undefined, SINCE + 10 ** 9), ["ok2", "ok1", "solo", "a2", "a1"]);
  // The same file with an interactive marker is kept.
  await writeFile(path, header + marker(INTERACTIVE_MARKER) + user("late1", "2026-01-01T00:00:00Z"));
  assert.deepEqual((await promptsFromSessionsDir(root, cache, undefined, SINCE + 10 ** 9))[0], "late1");
});

test("cache is reused and invalidated on change", async () => {
  const { sessions, cache, root } = await fixture();
  await promptsFromSessionsDir(root, cache, undefined, SINCE);
  const first = JSON.parse(await readFile(cache, "utf8"));
  assert.equal(Object.keys(first.sessions).length, 5);
  first.sessions[join(sessions, "a.jsonl")].prompts = [{ prompt: "cached", timestamp: 0 }];
  await writeFile(cache, JSON.stringify(first));
  assert.deepEqual(await promptsFromSessionsDir(root, cache, undefined, SINCE), ["ok2", "ok1", "solo", "cached"]);
  const path = join(sessions, "a.jsonl");
  await writeFile(path, header + marker(INTERACTIVE_MARKER) + user("fresh", "2024-01-09T00:00:00Z"));
  assert.deepEqual(await promptsFromSessionsDir(root, cache, undefined, SINCE), ["fresh", "ok2", "ok1", "solo"]);
});

test("keeps up to 1000 prompts, newest first", async () => {
  const { MAX_PROMPTS } = await import("../dist-test/scan.js");
  assert.equal(MAX_PROMPTS, 1000);
  const { dir, cache, root } = await fixture();
  let body = header + marker(INTERACTIVE_MARKER);
  for (let i = 0; i < 1200; i++) body += user(`p${i}`, new Date(Date.UTC(2024, 5, 1, 0, 0, i)).toISOString());
  await writeFile(join(root, "--proj--", "big.jsonl"), body);
  const all = await promptsFromSessionsDir(root, cache, undefined, SINCE);
  assert.equal(all.length, 1000);
  assert.equal(all[0], "p1199");
  assert.equal(all[999], "p200");
});

test("listInteractiveSessions builds Pi's selector entries from the cache", async () => {
  const { listInteractiveSessions, statSessionFiles } = await import("../dist-test/scan.js");
  const { sessions, cache } = await fixture();
  const path = join(sessions, "named.jsonl");
  await writeFile(path, header + marker(INTERACTIVE_MARKER) + user("hello", "2024-02-01T00:00:00Z") + assistant("world")
    + line({ type: "session_info", name: " My Session " })
    + line({ type: "message", timestamp: "2024-02-02T00:00:00Z", message: { role: "toolResult", content: [{ type: "text", text: "tool" }] } })
    + line({ type: "message", timestamp: "2024-02-03T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "later" }], timestamp: 1706918400000 } }));
  await utimes(path, OLD, OLD);
  const progress = [];
  const listed = await listInteractiveSessions(await statSessionFiles(sessions), cache, (l, t) => progress.push([l, t]), SINCE);
  assert.deepEqual(listed.map((s) => s.path.split("/").pop()), ["named.jsonl", "broken.jsonl", "interactive.jsonl", "a.jsonl"].filter((n) => n !== "broken.jsonl"));
  const named = listed[0];
  assert.equal(named.id, "sid");
  assert.equal(named.cwd, "/proj");
  assert.equal(named.name, "My Session");
  assert.equal(named.messageCount, 4);
  assert.equal(named.firstMessage, "hello");
  assert.equal(named.modified.getTime(), 1706918400000);
  assert.equal(named.created.toISOString(), "2024-01-01T00:00:00.000Z");
  assert.equal(named.allMessagesText, "hello world later");
  assert.deepEqual(progress, [[3, 3]]);
  // Excluded sessions carry no search text in the cache; the partial listing did not prune.
  const cached = JSON.parse(await readFile(cache, "utf8"));
  assert.equal(cached.sessions[join(sessions, "headless.jsonl")].search, undefined);
  assert.equal(typeof cached.sessions[path].search, "string");
  const full = await promptsFromSessionsDir(join(sessions, ".."), cache, undefined, SINCE);
  assert.equal(full[0], "hello");
});

test("defaultSessionDir mirrors Pi's encoding", async () => {
  const { defaultSessionDir } = await import("../dist-test/scan.js");
  assert.equal(defaultSessionDir("/agent/sessions", "/home/x/code:y"), "/agent/sessions/--home-x-code-y--");
});
