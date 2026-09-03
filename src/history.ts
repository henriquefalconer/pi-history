export type SessionLike = {
  path: string;
  modified: Date;
  entries: readonly unknown[];
};

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
 * Return prompts in the order Editor.addToHistory produces: newest first,
 * with every prompt from the newest session before older sessions.
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
