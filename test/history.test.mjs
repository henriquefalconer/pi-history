import test from "node:test";
import assert from "node:assert/strict";
import { promptsFromSessions, userPromptText } from "../dist-test/history.js";

const session = (path, modified, prompts) => ({
  path,
  modified: new Date(modified),
  entries: prompts.map((text) => ({ type: "message", message: { role: "user", content: text } })),
});

test("extracts the same text Pi renders for user messages", () => {
  assert.equal(userPromptText({ type: "message", message: { role: "assistant", content: "no" } }), undefined);
  assert.equal(userPromptText({ type: "message", message: { role: "user", content: [
    { type: "text", text: "first" }, { type: "image", url: "ignored" }, { type: "text", text: " second" },
  ] } }), "first second");
});

test("new sessions put newest session prompts before older sessions", () => {
  const sessions = [
    session("old", "2024-01-01", ["old 1", "old 2"]),
    session("new", "2024-01-03", ["new 1", "new 2"]),
    session("middle", "2024-01-02", ["middle 1"]),
  ];
  assert.deepEqual(promptsFromSessions(sessions), ["new 2", "new 1", "middle 1", "old 2", "old 1"]);
});

test("does not import the session being created", () => {
  assert.deepEqual(promptsFromSessions([
    session("current", "2024-01-04", ["current"]),
    session("prior", "2024-01-03", ["prior"]),
  ], "current"), ["prior"]);
});
