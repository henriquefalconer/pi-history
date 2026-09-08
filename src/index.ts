import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { HEADLESS_MARKER, INTERACTIVE_MARKER, isHeadlessSession, markerKind, promptsFromSessions, userPromptText } from "./history.js";
import { promptsFromSessionsDir } from "./scan.js";
import { appendFileSync } from "node:fs";

const debugPath = process.env.PI_HISTORY_DEBUG;
function debug(message: string): void {
  if (!debugPath) return;
  try {
    appendFileSync(debugPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Debug logging must never affect the extension.
  }
}

async function loadHistory(reason: SessionStartEvent["reason"], currentPath: string): Promise<string[]> {
  if (reason === "resume") {
    // renderCurrentSessionState() runs before session_start during a switch,
    // but seed explicitly here as well so switching never depends on which
    // editor instance was mounted before the switch.
    try {
      const manager = SessionManager.open(currentPath);
      return promptsFromSessions([{ path: currentPath, modified: new Date(), entries: manager.getEntries() }]);
    } catch {
      return [];
    }
  }

  // Never open whole sessions here: the global store can be gigabytes, and
  // SessionManager.open() parses an entire file into memory. Stream instead.
  const agentDir = getAgentDir();
  return promptsFromSessionsDir(join(agentDir, "sessions"), join(agentDir, "pi-history-cache.json"), currentPath);
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (event: SessionStartEvent, ctx) => {
    // Headless runs have no editor to populate. Mark their persisted session so
    // future /new launches do not treat automation prompts as interactive history.
    const entries = ctx.sessionManager.getEntries();
    debug(`session_start reason=${event.reason} mode=${ctx.mode} hasUI=${ctx.hasUI} file=${ctx.sessionManager.getSessionFile() ?? ""}`);
    if (ctx.mode !== "tui") {
      if (ctx.sessionManager.getSessionFile() && !isHeadlessSession(entries)) {
        pi.appendEntry(HEADLESS_MARKER);
      }
      return;
    }

    // Mark interactive sessions positively. Headless runs started with
    // --no-extensions never load this extension, so the global scan treats
    // unmarked sessions as headless and needs this marker to keep ours.
    if (ctx.sessionManager.getSessionFile() && !entries.some((entry) => markerKind(entry) === "interactive")) {
      pi.appendEntry(INTERACTIVE_MARKER);
    }

    // Keep Pi's native Editor and its history navigation. We only seed the
    // editor instance mounted after a session switch; normal startup remains
    // entirely on Pi's own renderSessionEntries() path.
    const hasCurrentPrompts = entries.some((entry) => Boolean(userPromptText(entry)?.trim()));
    const shouldSeed = event.reason === "new" || event.reason === "resume" ||
      (event.reason === "startup" && !hasCurrentPrompts);
    if (!shouldSeed || !ctx.hasUI || ctx.mode !== "tui") return;

    // An ephemeral or freshly-created session may not have a file yet. An
    // empty path is fine for /new and startup, and simply cannot match a
    // persisted session path during the global scan.
    const currentPath = ctx.sessionManager.getSessionFile() ?? "";

    // Mount the editor immediately and seed it once the scan resolves, so
    // startup never waits on disk. On a warm cache this is a few hundred ms;
    // a cold cache over a multi-gigabyte store streams in the background.
    let editor: SeededEditor | undefined;
    let pending: string[] | undefined;
    const seed = (target: SeededEditor, prompts: string[]): void => {
      // Anything already in this editor's history was typed in this session
      // and is newer than every seeded prompt, so it must stay in front.
      // addToHistory unshifts, so feed oldest to newest: seeded first, then
      // the existing entries. The native editor owns the history state.
      const state = target as unknown as { history?: unknown[]; historyIndex?: number };
      const existing = Array.isArray(state.history) ? (state.history.splice(0) as string[]) : [];
      for (const prompt of [...prompts].reverse()) target.addToHistory(prompt);
      for (const prompt of [...existing].reverse()) target.addToHistory(prompt);
      // If the user is already arrowing through history, keep them on the
      // same entry: seeded prompts are behind the existing ones, so only the
      // count of existing entries can shift their position, which is zero.
      if (typeof state.historyIndex === "number" && state.historyIndex >= existing.length) state.historyIndex = -1;
    };
    class SeededEditor extends CustomEditor {
      constructor(...args: ConstructorParameters<typeof CustomEditor>) {
        super(...args);
        editor = this;
        debug(`editor constructed pending=${pending?.length ?? "none"}`);
        if (pending) seed(this, pending);
      }
    }
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new SeededEditor(tui, theme, keybindings));

    const started = Date.now();
    void loadHistory(event.reason, currentPath).then((history) => {
      pending = history;
      debug(`history loaded count=${history.length} ms=${Date.now() - started} editor=${editor ? "mounted" : "not-mounted"}`);
      if (!editor) return;
      seed(editor, history);
      const state = editor as unknown as { history?: unknown[] };
      debug(`seeded editorHistory=${state.history?.length ?? "?"}`);
    }).catch((error: unknown) => {
      debug(`history failed ${String(error)}`);
      // History is a convenience; never surface scan failures as startup errors.
    });
  });
}

export { HEADLESS_MARKER, INTERACTIVE_MARKER, includeInGlobalHistory, isHeadlessSession, markerKind, promptsFromAllSessions, promptsFromSessions, userPromptText } from "./history.js";
