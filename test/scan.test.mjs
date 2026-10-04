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

test("only known interactive compacted sessions remain resumable, cold and warm", async () => {
  const { listInteractiveSessions, statSessionFiles, rememberSessionKind } = await import("../dist-test/scan.js");
  const { sessions, cache, root } = await fixture();
  const compact = line({ type: "compaction", id: "c", parentId: null, firstKeptEntryId: "c",
    timestamp: "2026-01-02T00:00:00Z", summary: "Research clone plan after compaction" });
  const cases = {
    compacted: header + compact,
    continued: header + compact + user("continue", "2026-01-03T00:00:00Z"),
    marked: header + marker(INTERACTIVE_MARKER) + compact,
    headlessBefore: header + marker(HEADLESS_MARKER) + compact,
    headlessAfter: header + compact + marker(HEADLESS_MARKER),
    noHeader: compact,
    malformed: header + '{"type":"compaction","summary":\n',
    notCompaction: header + assistant('a tool mentioned "type":"compaction"'),
  };
  cases.unknown = header + compact + user("unknown1", "2026-01-03T00:00:00Z") + user("unknown2", "2026-01-04T00:00:00Z");
  cases.headlessLostMarker = header + compact;
  cases.oversized = header + line({ type: "compaction", summary: "x".repeat(1024 * 1024) })
    + user("auto1", "2024-01-01T00:00:00Z") + user("auto2", "2024-01-02T00:00:00Z");
  for (const [name, body] of Object.entries(cases)) await writeFile(join(sessions, `${name}.jsonl`), body);
  await utimes(join(sessions, "unknown.jsonl"), OLD, OLD);
  await utimes(join(sessions, "oversized.jsonl"), OLD, OLD);
  await rememberSessionKind(cache, join(sessions, "compacted.jsonl"), "sid", "interactive");
  await rememberSessionKind(cache, join(sessions, "continued.jsonl"), "sid", "interactive");
  await rememberSessionKind(cache, join(sessions, "headlessLostMarker.jsonl"), "sid", "headless");
  for (let pass = 0; pass < 2; pass++) {
    const listed = await listInteractiveSessions(await statSessionFiles(sessions), cache, undefined, SINCE);
    for (const name of Object.keys(cases)) {
      assert.equal(listed.some((s) => s.path === join(sessions, `${name}.jsonl`)),
        ["compacted", "continued", "marked"].includes(name), `${name}, pass ${pass}`);
    }
    const compacted = listed.find((s) => s.path === join(sessions, "compacted.jsonl"));
    assert.equal(compacted.firstMessage, "Research clone plan after compaction");
    assert.equal(compacted.allMessagesText, compacted.firstMessage);
    assert.equal(compacted.modified.toISOString(), "2026-01-02T00:00:00.000Z");
    assert.equal(compacted.messageCount, 0);
    const continued = listed.find((s) => s.path === join(sessions, "continued.jsonl"));
    assert.equal(continued.firstMessage, "continue");
    assert.match(continued.allMessagesText, /Research clone plan/);
    const prompts = await promptsFromSessionsDir(root, cache, undefined, SINCE);
    assert.ok(prompts.includes("continue"));
    assert.ok(!prompts.some((p) => p.includes("Research clone plan")));
  }
});

test("upgrading the cache rescans compacted sessions without resetting markerSince", async () => {
  const { listInteractiveSessions, statSessionFiles } = await import("../dist-test/scan.js");
  const { sessions, cache } = await fixture();
  const path = join(sessions, "compacted.jsonl");
  await writeFile(path, header + line({ type: "compaction", summary: "Recovered plan" }));
  const files = await statSessionFiles(sessions);
  const file = files.find((f) => f.path === path);
  await writeFile(cache, JSON.stringify({ version: 4, markerSince: SINCE, sessions: {
    [path]: { size: file.size, mtime: file.mtime, kind: "interactive", promptCount: 0, prompts: [], summary: { id: "sid" } },
  } }));
  const listed = await listInteractiveSessions(files, cache, undefined, SINCE + 10000);
  assert.ok(listed.some((s) => s.path === path));
  const persisted = JSON.parse(await readFile(cache, "utf8"));
  assert.equal(persisted.version, 5);
  assert.equal(persisted.markerSince, SINCE);
});

test("classification survives marker removal and cache deletion, but not a replaced session ID", async () => {
  const { listInteractiveSessions, statSessionFiles, rememberSessionKind } = await import("../dist-test/scan.js");
  const { unlink } = await import("node:fs/promises");
  const { sessions, cache } = await fixture();
  const interactive = join(sessions, "durable.jsonl");
  const headless = join(sessions, "automation.jsonl");
  await writeFile(interactive, header + marker(INTERACTIVE_MARKER));
  await writeFile(headless, header + marker(HEADLESS_MARKER));
  await listInteractiveSessions(await statSessionFiles(sessions), cache, undefined, SINCE);
  const compact = line({ type: "compaction", summary: "Retained summary" });
  await writeFile(interactive, header + compact);
  await writeFile(headless, header + compact);
  await unlink(cache);
  // A later TUI visit cannot reclassify a known headless run.
  await Promise.all([
    rememberSessionKind(cache, headless, "sid", "interactive"),
    rememberSessionKind(cache, headless, "sid", "headless"),
  ]);
  const listed = await listInteractiveSessions(await statSessionFiles(sessions), cache, undefined, SINCE);
  assert.ok(listed.some((s) => s.path === interactive));
  assert.ok(!listed.some((s) => s.path === headless));
  await writeFile(interactive, header.replace('"sid"', '"replacement"') + compact);
  assert.ok(!(await listInteractiveSessions(await statSessionFiles(sessions), cache, undefined, SINCE)).some((s) => s.path === interactive));
});

test("recovery validates unmarked compacted sessions without mutating them", async () => {
  const { inspectRecoverySession, listInteractiveSessions, statSessionFiles } = await import("../dist-test/scan.js");
  const { sessions, cache } = await fixture();
  const path = join(sessions, "missing.jsonl");
  const body = header + user("study the commits", "2026-01-01T00:00:00Z") +
    line({ type: "compaction", summary: "Earlier work" }) +
    Array.from({ length: 12 }, (_, i) => user(`follow up ${i}`, "2026-01-02T00:00:00Z")).join("") +
    line({ type: "compaction", summary: "Later work" }) + user("push", "2026-01-03T00:00:00Z");
  await writeFile(path, body);
  assert.ok(!(await listInteractiveSessions(await statSessionFiles(sessions), cache)).some((s) => s.path === path));
  assert.equal((await inspectRecoverySession(path, cache)).firstMessage, "study the commits");
  assert.equal(await readFile(path, "utf8"), body);
  // Merely inspecting or cancelling the confirmation must not classify it.
  assert.ok(!(await listInteractiveSessions(await statSessionFiles(sessions), cache)).some((s) => s.path === path));
  await assert.rejects(inspectRecoverySession(join(sessions, "absent.jsonl"), cache));
  await assert.rejects(inspectRecoverySession(sessions, cache), /existing .jsonl/);
  await assert.rejects(inspectRecoverySession(join(sessions, "broken.jsonl"), cache), /valid Pi session header/);
});

test("recovery refuses headless markers, durable evidence and legacy cached evidence", async () => {
  const { inspectRecoverySession, rememberSessionKind } = await import("../dist-test/scan.js");
  const { sessions, cache } = await fixture();
  const path = join(sessions, "a.jsonl");
  await assert.rejects(inspectRecoverySession(join(sessions, "headless.jsonl"), cache), /Known headless/);
  await rememberSessionKind(cache, path, "sid", "headless");
  await assert.rejects(inspectRecoverySession(path, cache), /Known headless/);
  const legacy = join(sessions, "interactive.jsonl");
  await writeFile(cache, JSON.stringify({ version: 4, markerSince: SINCE, sessions: {
    [legacy]: { kind: "headless", summary: { id: "sid" } },
  } }));
  await assert.rejects(inspectRecoverySession(legacy, cache), /Known headless/);
  // Evidence for a previous file at the same path must not taint a new ID.
  await writeFile(path, header.replace('"sid"', '"replacement"'));
  assert.equal((await inspectRecoverySession(path, cache)).id, "replacement");
});

test("defaultSessionDir mirrors Pi's encoding", async () => {
  const { defaultSessionDir } = await import("../dist-test/scan.js");
  assert.equal(defaultSessionDir("/agent/sessions", "/home/x/code:y"), "/agent/sessions/--home-x-code-y--");
});
