import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADLESS_MARKER } from "../dist-test/history.js";
import { promptsFromSessionsDir, scanSessionPrompts } from "../dist-test/scan.js";

const line = (obj) => JSON.stringify(obj) + "\n";
const user = (text, ts) => line({ type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text) => line({ type: "message", timestamp: "2024-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text }] } });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-history-"));
  const sessions = join(dir, "sessions", "--proj--");
  await mkdir(join(sessions, "forks"), { recursive: true });
  await writeFile(join(sessions, "a.jsonl"), line({ type: "session", version: 3 }) + user("a1", "2024-01-01T00:00:00Z") + assistant("noise \"role\":\"user\"") + user("a2", "2024-01-03T00:00:00Z"));
  await writeFile(join(sessions, "forks", "b.jsonl"), line({ type: "session", version: 3 }) + user("b1", "2024-01-02T00:00:00Z"));
  await writeFile(join(sessions, "headless.jsonl"), line({ type: "session", version: 3 }) + line({ type: "custom", customType: HEADLESS_MARKER }) + user("automation", "2024-01-05T00:00:00Z"));
  await writeFile(join(sessions, "broken.jsonl"), "{not json\n" + user("ok", "2024-01-04T00:00:00Z"));
  return { dir, sessions, cache: join(dir, "cache.json") };
}

test("streams user prompts and skips headless sessions", async () => {
  const { sessions } = await fixture();
  assert.deepEqual((await scanSessionPrompts(join(sessions, "a.jsonl"), 0)).map((r) => r.prompt), ["a1", "a2"]);
  assert.deepEqual(await scanSessionPrompts(join(sessions, "headless.jsonl"), 0), []);
});

test("walks nested sessions, orders newest first, excludes current", async () => {
  const { dir, sessions, cache } = await fixture();
  const all = await promptsFromSessionsDir(join(dir, "sessions"), cache);
  assert.deepEqual(all, ["ok", "a2", "b1", "a1"]);
  const withoutA = await promptsFromSessionsDir(join(dir, "sessions"), cache, join(sessions, "a.jsonl"));
  assert.deepEqual(withoutA, ["ok", "b1"]);
});

test("cache is reused and invalidated on change", async () => {
  const { dir, sessions, cache } = await fixture();
  await promptsFromSessionsDir(join(dir, "sessions"), cache);
  const first = JSON.parse(await readFile(cache, "utf8"));
  assert.equal(Object.keys(first.sessions).length, 4);
  // Poison the cache for a.jsonl; unchanged file must be served from cache.
  first.sessions[join(sessions, "a.jsonl")].prompts = [{ prompt: "cached", timestamp: 0 }];
  await writeFile(cache, JSON.stringify(first));
  assert.deepEqual(await promptsFromSessionsDir(join(dir, "sessions"), cache), ["ok", "b1", "cached"]);
  // Changing the file invalidates its entry.
  await writeFile(join(sessions, "a.jsonl"), line({ type: "session", version: 3 }) + user("fresh", "2024-01-09T00:00:00Z"));
  assert.deepEqual(await promptsFromSessionsDir(join(dir, "sessions"), cache), ["fresh", "ok", "b1"]);
});
