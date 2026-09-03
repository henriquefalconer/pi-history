export const HEADLESS_MARKER = "hfalconer/pi-history:headless";

export type SessionLike = {
  path: string;
  modified: Date;
  entries: readonly unknown[];
};

export function isHeadlessSession(entries: readonly unknown[]): boolean {
  return entries.some((entry) => {
    const candidate = entry as { type?: unknown; customType?: unknown };
    return candidate.type === "custom" && candidate.customType === HEADLESS_MARKER;
  });
}

type MessageEntry = {
  type: "message";
  message: { role: string; content: string | readonly { type: string; text?: string }[] };
};

/** The same text extraction used by Pi's interactive transcript renderer. */
export function userPromptText(entry: unknown): string | undefined {
  const candidate = entry as Partial<MessageEntry>;
  if (candidate.type !== "message" || candidate.message?.role !== "user") return undefined;
  const content = candidate.message.content;
  const text = typeof content === "string"
    ? content
    : content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
  return text || undefined;
}

/**
 * Return one session's prompts in the order Editor.addToHistory produces.
 * This is kept separate because resume must preserve Pi's existing behavior.
 */
export function promptsFromSessions(sessions: readonly SessionLike[], currentPath?: string): string[] {
  const ordered = [...sessions]
    .filter((session) => session.path !== currentPath)
    .sort((a, b) => a.modified.getTime() - b.modified.getTime());
  const result: string[] = [];
  for (const session of ordered) {
    for (const entry of session.entries) {
      const prompt = userPromptText(entry);
      if (prompt?.trim()) result.unshift(prompt.trim());
    }
  }
  return result;
}

/** Return every persisted user prompt globally, newest prompt first. */
export function promptsFromAllSessions(sessions: readonly SessionLike[], currentPath?: string): string[] {
  const records: Array<{ prompt: string; timestamp: number; order: number }> = [];
  let order = 0;
  for (const session of sessions) {
    if (session.path === currentPath || isHeadlessSession(session.entries)) continue;
    for (const entry of session.entries) {
      const prompt = userPromptText(entry);
      if (!prompt?.trim()) continue;
      const timestampValue = (entry as { timestamp?: unknown }).timestamp;
      const timestamp = typeof timestampValue === "string" ? Date.parse(timestampValue) : Number.NaN;
      records.push({
        prompt: prompt.trim(),
        timestamp: Number.isFinite(timestamp) ? timestamp : session.modified.getTime(),
        order: order++,
      });
    }
  }
  return records
    .sort((a, b) => b.timestamp - a.timestamp || b.order - a.order)
    .map((record) => record.prompt);
}
