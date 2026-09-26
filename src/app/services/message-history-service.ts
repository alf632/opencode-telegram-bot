import { getSessionMessages, opencodeV2 } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";

const LATEST_ASSISTANT_RESPONSE_MESSAGES_LIMIT = 20;

export interface UserMessageItem {
  id: string;
  text: string;
  created: number;
}

export interface AssistantMessageMetrics {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}


export async function loadUserMessages(
  sessionId: string,
  _directory: string,
): Promise<UserMessageItem[]> {
  const { data, error } = await getSessionMessages(sessionId);

  if (error || !data) {
    throw error || new Error("No message data received");
  }

  const { data: sessionBody, error: sessionError } = await opencodeV2.session.get({
    sessionID: sessionId,
  });

  if (sessionError || !sessionBody) {
    throw sessionError || new Error("No session data received");
  }

  const revertMessageID = sessionBody.data.revert?.messageID;

  const messages = data
    .filter((message) => message.role === "user")
    .map(
      (message): UserMessageItem => ({
        id: message.id,
        text: message.text,
        created: message.created,
      }),
    )
    .sort((a, b) => b.created - a.created);

  if (revertMessageID) {
    const revertIndex = messages.findIndex((msg) => msg.id === revertMessageID);
    if (revertIndex !== -1) {
      return messages.slice(revertIndex + 1);
    }
  }

  return messages;
}

export async function loadLatestAssistantResponse(
  sessionId: string,
  _directory: string,
): Promise<string | null> {
  try {
    const { data: messages, error } = await getSessionMessages(
      sessionId,
      LATEST_ASSISTANT_RESPONSE_MESSAGES_LIMIT,
    );

    if (error || !messages) {
      logger.warn("[Messages] Failed to fetch latest assistant response:", error);
      return null;
    }

    const latestResponse = messages.reduce<{
      text: string;
      created: number;
    } | null>((latest, message) => {
      if (message.role !== "assistant") {
        return latest;
      }

      if (!latest || message.created >= latest.created) {
        return { text: message.text, created: message.created };
      }

      return latest;
    }, null);

    return latestResponse?.text ?? null;
  } catch (err) {
    logger.error("[Messages] Error loading latest assistant response:", err);
    return null;
  }
}

type V2AssistantMessage = {
  type: "assistant";
  id: string;
  time: { created: number; completed?: number };
  content: Array<{ type: string; text?: string }>;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  cost?: number;
};

export async function loadLatestAssistantMetrics(
  sessionId: string,
  _directory: string,
): Promise<AssistantMessageMetrics | null> {
  const { data, error } = await opencodeV2.session.messages({ sessionID: sessionId });
  if (error || !data) {
    throw error || new Error("No message data received");
  }

  const messages = data.data as unknown[];
  const latest = messages.reduce<V2AssistantMessage | null>((current, message) => {
    const assistantMessage = message as V2AssistantMessage;
    if (assistantMessage.type !== "assistant") {
      return current;
    }
    if (!current || assistantMessage.time.created >= current.time.created) {
      return assistantMessage;
    }
    return current;
  }, null);

  if (!latest) {
    return null;
  }

  const tokens = latest.tokens;
  if (!tokens) {
    return null;
  }

  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cache.read,
    cacheWrite: tokens.cache.write,
    cost: latest.cost ?? 0,
  };
}
