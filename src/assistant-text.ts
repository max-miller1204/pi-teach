/**
 * Extract the final assistant text from a finished run's messages.
 *
 * Used as a fallback: if the model answers a learner's question in prose instead of
 * calling `answer_lesson_question`, the card would otherwise spin forever. Adapted
 * from the slack-bridge extension, which needs the same thing for the same reason.
 */

interface MaybeMessage {
  role?: string;
  content?: unknown;
}

/** Text of the last assistant message, or null if there is none. */
export function findLastAssistantText(messages: readonly unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as MaybeMessage;
    if (!msg || msg.role !== "assistant") continue;
    const text = extractText(msg.content);
    if (text) return text;
  }
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: string }).type === "text" &&
      typeof (part as { text?: string }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n").trim();
}
