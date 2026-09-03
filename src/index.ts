import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HEADLESS_MARKER, isHeadlessSession, promptsFromAllSessions, promptsFromSessions, type SessionLike, userPromptText } from "./history.js";

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

  const infos = await SessionManager.listAll();
  const sessions: SessionLike[] = [];
  for (const info of infos) {
    if (info.path === currentPath) continue;
    try {
      const manager = SessionManager.open(info.path);
      sessions.push({ path: info.path, modified: info.modified, entries: manager.getEntries() });
    } catch {
      // A session can disappear while the global list is being read. Ignore it.
    }
  }
  return promptsFromAllSessions(sessions);
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (event: SessionStartEvent, ctx) => {
    // Headless runs have no editor to populate. Mark their persisted session so
    // future /new launches do not treat automation prompts as interactive history.
    const entries = ctx.sessionManager.getEntries();
    if (ctx.mode !== "tui") {
      if (ctx.sessionManager.getSessionFile() && !isHeadlessSession(entries)) {
        pi.appendEntry(HEADLESS_MARKER);
      }
      return;
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
    const history = await loadHistory(event.reason, currentPath);

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      let seeded = false;
      return new (class extends CustomEditor {
        override setText(text: string): void {
          super.setText(text);
          if (seeded) return;
          seeded = true;
          // addToHistory unshifts, so feed oldest to newest. The native
          // editor implementation remains the sole owner of history state.
          for (const prompt of [...history].reverse()) this.addToHistory(prompt);
        }
      })(tui, theme, keybindings);
    });
  });
}

export { HEADLESS_MARKER, isHeadlessSession, promptsFromAllSessions, promptsFromSessions, userPromptText } from "./history.js";
