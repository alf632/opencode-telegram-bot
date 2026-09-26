import type { Bot, Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import {
  getBusySessionStatuses,
  getSessionMessagePage,
  getSessionMessages,
  opencodeV2,
} from "../../opencode/client.js";
import { resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { setCurrentSession } from "../../app/services/session-service.js";
import { applySessionSettings } from "../../app/services/session-settings-service.js";
import type { SessionInfo } from "../../app/types/session.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { appendInlineMenuCancelButton, ensureActiveInlineMenu } from "../menus/inline-menu.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { alert, failure } from "./feedback.js";
import { attachToSession } from "../../app/services/attach-service.js";
import { renderAssistantFinalPartsSafe } from "../messages/assistant-rendering.js";
import { sendBotText, sendRenderedBotPart } from "../messages/telegram-text.js";
import {
  buildSessionPickQuote,
  findEligibleReply,
  findLatestUserPrompt,
  findMessageById,
  type SessionPickMessage,
} from "../../app/services/session-pick-reply.js";
import {
  buildSessionSelectionMenuView,
  parseBackgroundSessionCallback,
  parseSessionIdCallback,
  parseSessionPageCallback,
  SESSION_CALLBACK_PREFIX,
  loadSessionPage,
} from "../menus/session-selection-menu.js";

export type SessionSelectDeps = Pick<
  AppContainer,
  | "attachManager"
  | "ensureEventSubscription"
  | "foregroundSessionState"
  | "interactionManager"
  | "keyboardManager"
  | "permissionManager"
  | "questionManager"
  | "resetInteractions"
  | "summaryAggregator"
> & {
  bot: Bot<Context>;
};

interface SelectSessionByIdOptions {
  source: "menu" | "background_notification";
  deleteCallbackMessage: boolean;
  removeCallbackReplyMarkup: boolean;
  postSelectAction: "preview" | "latest_assistant_response" | "none";
}

const LATEST_ASSISTANT_RESPONSE_MESSAGES_LIMIT = 20;
const SESSION_PICK_PAGE_SIZE = 20;
const SESSION_PICK_SEND_GAP_MS = 1000;

async function removeCallbackReplyMarkup(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup();
  } catch (err) {
    logger.debug("[Sessions] Failed to remove background session button:", err);
  }
}

export async function selectSessionById(
  ctx: Context,
  deps: SessionSelectDeps,
  sessionId: string,
  options: SelectSessionByIdOptions,
): Promise<void> {
  const currentProject = getCurrentProject();

  if (!currentProject) {
    deps.resetInteractions("session_select_project_missing");
    await alert(ctx, "sessions.select_project_first");
    return;
  }

  const { data: sessionBody, error } = await opencodeV2.session.get({
    sessionID: sessionId,
  });

  if (error || !sessionBody) {
    throw error || new Error("Failed to get session details");
  }

  const session = sessionBody.data;

  logger.info(
    `[Bot] Session selected: id=${session.id}, title="${session.title}", project=${currentProject.worktree}, source=${options.source}`,
  );

  const sessionInfo: SessionInfo = {
    id: session.id,
    title: session.title,
    directory: currentProject.worktree,
  };
  setCurrentSession(sessionInfo);
  // Pull before attaching: the pinned message is rendered inside attachToSession
  // and reads the stored model, so its Model line comes out already pulled.
  applySessionSettings(session);
  deps.resetInteractions("session_switched");

  await ctx.answerCallbackQuery();

  let loadingMessageId: number | null = null;
  if (ctx.chat) {
    try {
      const loadingMessage = await ctx.api.sendMessage(ctx.chat.id, t("sessions.loading_context"));
      loadingMessageId = loadingMessage.message_id;
    } catch (err) {
      logger.error("[Sessions] Failed to send loading message:", err);
    }
  }

  const deliverPick = options.postSelectAction === "preview" && Boolean(ctx.chat);
  let pickMessages: SessionPickMessage[] | null = null;
  let pickBusy = false;
  if (deliverPick) {
    pickBusy = await readSessionBusy(session.id, currentProject.worktree);
    pickMessages = await loadSessionPickMessages(session.id, currentProject.worktree, pickBusy);
    deps.summaryAggregator.holdOutbound();
  }

  try {
    try {
      await attachToSession({
        ...deps,
        chatId: ctx.chat!.id,
        session: sessionInfo,
      });
    } catch (err) {
      if (loadingMessageId && ctx.chat) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, loadingMessageId);
        } catch (deleteError) {
          logger.debug("[Sessions] Failed to delete loading message after follow error:", deleteError);
        }
      }
      logger.error("[Sessions] Error following selected session:", err);
      throw err;
    }

    if (ctx.chat) {
      const chatId = ctx.chat.id;
      const currentAgent = await resolveProjectAgent();

      deps.keyboardManager.updateAgent(currentAgent);
      deps.keyboardManager.updateModel(getStoredModel());

      const contextInfo = deps.keyboardManager.getContextInfo();
      if (contextInfo) {
        deps.keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);
      }

      if (loadingMessageId) {
        try {
          await ctx.api.deleteMessage(chatId, loadingMessageId);
        } catch (err) {
          logger.debug("[Sessions] Failed to delete loading message:", err);
        }
      }

      const keyboard = deps.keyboardManager.getKeyboard();
      try {
        await ctx.api.sendMessage(
          chatId,
          t("sessions.selected", { title: session.title }),
          keyboard ? { reply_markup: keyboard } : {},
        );
      } catch (err) {
        logger.error("[Sessions] Failed to send selection message:", err);
      }

      if (deliverPick) {
        await sendSessionPickTranscript(
          ctx.api,
          chatId,
          session.id,
          currentProject.worktree,
          pickMessages,
          pickBusy,
        );
      }

      if (options.postSelectAction === "latest_assistant_response") {
        safeBackgroundTask({
          taskName: "sessions.sendLatestAssistantResponse",
          task: () => sendLatestAssistantResponse(ctx.api, chatId, session.id, currentProject.worktree),
        });
      }
    }
  } finally {
    if (deliverPick) {
      await releaseSessionPickHold(deps.summaryAggregator);
    }
  }

  if (options.removeCallbackReplyMarkup) {
    await removeCallbackReplyMarkup(ctx);
  }

  if (options.deleteCallbackMessage) {
    await ctx.deleteMessage();
  }
}

function shouldBlockBackgroundSessionOpen(deps: SessionSelectDeps): boolean {
  const activeInteraction = deps.interactionManager.getSnapshot();
  return activeInteraction !== null && activeInteraction.kind !== "inline";
}

export async function handleBackgroundSessionOpen(
  ctx: Context,
  deps: SessionSelectDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    return false;
  }

  const payload = parseBackgroundSessionCallback(data);
  if (!payload) {
    return false;
  }

  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }

  if (shouldBlockBackgroundSessionOpen(deps)) {
    await ctx.answerCallbackQuery({ text: t("interaction.blocked.finish_current") }).catch(() => {});
    return true;
  }

  try {
    await selectSessionById(ctx, deps, payload.sessionId, {
      source: "background_notification",
      deleteCallbackMessage: false,
      removeCallbackReplyMarkup: true,
      postSelectAction: payload.kind === "assistant_response" ? "latest_assistant_response" : "none",
    });
  } catch (error) {
    logger.error("[Sessions] Error selecting background session:", error);
    await ctx.answerCallbackQuery({ text: t("sessions.select_error"), show_alert: true }).catch(
      () => {},
    );
  }

  return true;
}

export async function handleSessionSelect(ctx: Context, deps: SessionSelectDeps): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data || !callbackQuery.data.startsWith(SESSION_CALLBACK_PREFIX)) {
    return false;
  }

  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }

  const page = parseSessionPageCallback(callbackQuery.data);
  const sessionId = parseSessionIdCallback(callbackQuery.data);

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "session", deps);
  if (!isActiveMenu) {
    return true;
  }

  try {
    const currentProject = getCurrentProject();

    if (!currentProject) {
      deps.resetInteractions("session_select_project_missing");
      await alert(ctx, "sessions.select_project_first");
      return true;
    }

    if (page !== null) {
      try {
        const pageSize = config.bot.sessionsListLimit;
        const pageData = await loadSessionPage(currentProject.worktree, page, pageSize);
        if (pageData.sessions.length === 0) {
          await ctx.answerCallbackQuery({ text: t("sessions.page_empty_callback") });
          return true;
        }

        const { text, keyboard } = buildSessionSelectionMenuView(pageData, pageSize);
        appendInlineMenuCancelButton(keyboard, "session");
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text, {
          reply_markup: keyboard,
        });
      } catch (error) {
        logger.error("[Sessions] Error loading sessions page:", error);
        await ctx.answerCallbackQuery({ text: t("sessions.page_load_error_callback") });
      }

      return true;
    }

    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
      return true;
    }

    await selectSessionById(ctx, deps, sessionId, {
      source: "menu",
      deleteCallbackMessage: true,
      removeCallbackReplyMarkup: false,
      postSelectAction: "preview",
    });
  } catch (error) {
    deps.resetInteractions("session_select_error");
    logger.error("[Sessions] Error selecting session:", error);
    await failure(ctx, "sessions.select_error");
  }

  return true;
}

function sessionPickSendGapMs(): number {
  return process.env.VITEST ? 0 : SESSION_PICK_SEND_GAP_MS;
}

function waitForSessionPickSend(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, sessionPickSendGapMs()));
}

async function releaseSessionPickHold(
  aggregator: SessionSelectDeps["summaryAggregator"],
): Promise<void> {
  if (aggregator.hasDeferredOutbound()) {
    await waitForSessionPickSend();
  }
  await aggregator.drainOutbound(sessionPickSendGapMs());
}

async function readSessionBusy(sessionId: string, _directory: string): Promise<boolean> {
  try {
    const { data, error } = await getBusySessionStatuses();
    if (error || !data) {
      logger.warn("[Sessions] Failed to read session status for pick:", error);
      return true;
    }
    return data[sessionId]?.type === "busy";
  } catch (err) {
    logger.warn("[Sessions] Failed to read session status for pick:", err);
    return true;
  }
}

// `completed` decides whether a reply counts as finished, which is what lets
// the preview show one while the session is still busy.
function mapNormalizedMessageToPickMessage(message: {
  id: string;
  role: "user" | "assistant";
  text: string;
  created: number;
  completed?: number;
}): SessionPickMessage {
  return {
    info: {
      id: message.id,
      role: message.role,
      time: {
        created: message.created,
        ...(message.completed === undefined ? {} : { completed: message.completed }),
      },
    },
    parts: [{ type: "text", text: message.text }],
  };
}

// v2 messages carry no parent link, so pair every reply with the nearest user
// message that came before it. That is what makes the preview quote the prompt
// the shown reply answers.
function linkParentPrompts(messages: SessionPickMessage[]): void {
  const chronological = [...messages].sort(
    (left, right) => (left.info.time?.created ?? 0) - (right.info.time?.created ?? 0),
  );
  let lastUserId: string | undefined;
  for (const message of chronological) {
    if (message.info.role === "user") {
      lastUserId = message.info.id;
      continue;
    }
    if (lastUserId !== undefined) {
      message.info.parentID = lastUserId;
    }
  }
}

async function loadSessionPickMessages(
  sessionId: string,
  _directory: string,
  busy: boolean,
): Promise<SessionPickMessage[] | null> {
  const loaded: SessionPickMessage[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  try {
    for (;;) {
      const { data: page, error } = await getSessionMessagePage(sessionId, {
        limit: SESSION_PICK_PAGE_SIZE,
        ...(cursor ? { cursor } : { order: "desc" }),
      });

      if (error || !page) {
        logger.warn("[Sessions] Failed to fetch session messages for pick:", error);
        return null;
      }

      if (page.messages.length === 0) {
        return loaded;
      }

      let added = 0;
      for (const message of page.messages) {
        if (seen.has(message.id)) {
          continue;
        }
        seen.add(message.id);
        loaded.push(mapNormalizedMessageToPickMessage(message));
        added += 1;
      }
      linkParentPrompts(loaded);

      if (added === 0 || findEligibleReply(loaded, busy)) {
        return loaded;
      }
      if (page.messages.length < SESSION_PICK_PAGE_SIZE) {
        return loaded;
      }
      if (!page.nextCursor || page.nextCursor === cursor) {
        return loaded;
      }
      cursor = page.nextCursor;
    }
  } catch (err) {
    logger.error("[Sessions] Error loading session messages for pick:", err);
    return null;
  }
}

async function loadParentMessage(
  sessionId: string,
  messageId: string,
  _directory: string,
): Promise<SessionPickMessage | null> {
  try {
    const { data: messages, error } = await getSessionMessages(sessionId, 200);
    if (error || !messages) {
      logger.warn("[Sessions] Failed to load the user message for the shown reply:", error);
      return null;
    }

    const parent = messages.find((message) => message.id === messageId);
    if (!parent) {
      return null;
    }

    return mapNormalizedMessageToPickMessage(parent);
  } catch (err) {
    logger.warn("[Sessions] Failed to load the user message for the shown reply:", err);
    return null;
  }
}

async function sendSessionPickTranscript(
  api: Context["api"],
  chatId: number,
  sessionId: string,
  directory: string,
  messages: SessionPickMessage[] | null,
  busy: boolean,
): Promise<void> {
  const reply = messages ? findEligibleReply(messages, busy) : null;
  let quoteSource: SessionPickMessage | null = null;

  if (messages && reply?.parentId) {
    quoteSource = findMessageById(messages, reply.parentId);
    if (!quoteSource) {
      quoteSource = await loadParentMessage(sessionId, reply.parentId, directory);
    }
  } else if (messages && !reply) {
    quoteSource = findLatestUserPrompt(messages);
  }

  const quote = quoteSource ? buildSessionPickQuote(quoteSource) : null;
  if (quote) {
    await waitForSessionPickSend();
    try {
      await sendBotText({
        api,
        chatId,
        text: quote.text,
        rawFallbackText: quote.rawFallbackText,
        format: "markdown_v2",
      });
    } catch (err) {
      logger.error("[Sessions] Failed to send the last user input quote:", err);
    }
  } else if (!reply) {
    await waitForSessionPickSend();
    try {
      await api.sendMessage(chatId, t("sessions.preview.empty"));
    } catch (err) {
      logger.error("[Sessions] Failed to send the empty session notice:", err);
    }
  }

  if (!reply) {
    return;
  }

  try {
    const parts = renderAssistantFinalPartsSafe(reply.text);
    for (const part of parts) {
      await waitForSessionPickSend();
      await sendRenderedBotPart({ api, chatId, part });
    }
  } catch (err) {
    logger.error("[Sessions] Failed to send session preview message:", err);
  }
}

async function loadLatestAssistantResponse(
  sessionId: string,
  _directory: string,
): Promise<string | null> {
  try {
    const { data: messages, error } = await getSessionMessages(
      sessionId,
      LATEST_ASSISTANT_RESPONSE_MESSAGES_LIMIT,
    );

    if (error || !messages) {
      logger.warn("[Sessions] Failed to fetch latest assistant response:", error);
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
    logger.error("[Sessions] Error loading latest assistant response:", err);
    return null;
  }
}

async function sendLatestAssistantResponse(
  api: Context["api"],
  chatId: number,
  sessionId: string,
  directory: string,
): Promise<void> {
  const responseText = await loadLatestAssistantResponse(sessionId, directory);
  if (!responseText) {
    return;
  }

  const parts = renderAssistantFinalPartsSafe(responseText);
  for (const part of parts) {
    await sendRenderedBotPart({
      api,
      chatId,
      part,
    });
  }
}
