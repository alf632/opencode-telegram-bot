import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import {
  handleBackgroundSessionOpen,
  handleSessionSelect,
} from "../../../src/bot/callbacks/session-callback-handler.js";
import { sessionsCommand } from "../../../src/bot/commands/sessions-command.js";
import { buildBackgroundSessionOpenKeyboard } from "../../../src/bot/menus/session-selection-menu.js";
import { t } from "../../../src/i18n/index.js";
import { defined } from "../../helpers/defined.js";
import { safeBackgroundTask } from "../../../src/utils/safe-background-task.js";
import { startInteractionForTest } from "../../helpers/interaction.js";
import { createTestAppContainer } from "../../helpers/app-container.js";
import type { AppContainer } from "../../../src/app/bootstrap/app-container.js";

const mocked = vi.hoisted(() => ({
  currentProject: {
    id: "project-1",
    worktree: "/repo",
  } as { id: string; worktree: string; name?: string } | null,
  sessionListMock: vi.fn(),
  sessionGetMock: vi.fn(),
  sessionMessagesMock: vi.fn(),
  sessionMessagePageMock: vi.fn(),
  sessionStatusMock: vi.fn(),
  sessionMessageMock: vi.fn(),
  setCurrentSessionMock: vi.fn(),
  clearInteractionMock: vi.fn(),
  keyboardInitializeMock: vi.fn(),
  keyboardGetKeyboardMock: vi.fn(() => ({ inline_keyboard: [] })),
  keyboardUpdateAgentMock: vi.fn(),
  keyboardUpdateModelMock: vi.fn(),
  keyboardUpdateContextMock: vi.fn(),
  applySessionSettingsMock: vi.fn(),
  getStoredModelMock: vi.fn(() => ({
    providerID: "opencode-go",
    modelID: "deepseek-v4-flash",
    variant: "default",
  })),
  keyboardGetContextInfoMock: vi.fn(() => null),
  resolveProjectAgentMock: vi.fn(async () => "build"),
  attachToSessionMock: vi.fn(),
  ensureEventSubscriptionMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  listSessions: mocked.sessionListMock,
  getBusySessionStatuses: mocked.sessionStatusMock,
  getSessionMessages: mocked.sessionMessagesMock,
  getSessionMessagePage: mocked.sessionMessagePageMock,
  opencodeV2: {
    session: {
      get: mocked.sessionGetMock,
    },
  },
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: vi.fn(() => mocked.currentProject),
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  setCurrentSession: mocked.setCurrentSessionMock,
}));

vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  resolveProjectAgent: mocked.resolveProjectAgentMock,
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: mocked.getStoredModelMock,
}));

vi.mock("../../../src/app/services/session-settings-service.js", () => ({
  applySessionSettings: mocked.applySessionSettingsMock,
}));

vi.mock("../../../src/app/services/attach-service.js", () => ({
  attachToSession: mocked.attachToSessionMock,
}));

vi.mock("../../../src/utils/safe-background-task.js", () => ({
  safeBackgroundTask: vi.fn(),
}));

const safeBackgroundTaskMock = vi.mocked(safeBackgroundTask);

type SessionStub = {
  id: string;
  title: string;
  directory: string;
  time: {
    created: number;
  };
};

function createSession(index: number): SessionStub {
  return {
    id: `session-${index + 1}`,
    title: `Session ${index + 1}`,
    directory: "/repo",
    time: {
      created: 1700000000000 + index * 1000,
    },
  };
}

function createSessionMessage(
  role: "user" | "assistant",
  text: string,
  created: number,
  completed?: number,
): { id: string; role: "user" | "assistant"; text: string; created: number; completed?: number } {
  return {
    id: `${role}-${created}`,
    role,
    text,
    created,
    ...(completed === undefined ? {} : { completed }),
  };
}

function createCommandContext(): Context {
  return {
    chat: { id: 111 },
    reply: vi.fn().mockResolvedValue({ message_id: 456 }),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
      deleteMessage: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

function createCallbackContext(data: string, messageId: number): Context {
  return {
    chat: { id: 111 },
    callbackQuery: {
      data,
      message: {
        message_id: messageId,
      },
    } as Context["callbackQuery"],
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 888 }),
      sendRichMessage: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("Bad Request: rich message unavailable"), { error_code: 400 })),
      deleteMessage: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

function createDeps() {
  return {
    ...container,
    ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    resetInteractions: mocked.clearInteractionMock,
    keyboardManager: {
      initialize: mocked.keyboardInitializeMock,
      getKeyboard: mocked.keyboardGetKeyboardMock,
      getContextInfo: mocked.keyboardGetContextInfoMock,
      updateAgent: mocked.keyboardUpdateAgentMock,
      updateModel: mocked.keyboardUpdateModelMock,
      updateContext: mocked.keyboardUpdateContextMock,
    } as never,
    bot: { api: {} } as Bot<Context>,
  };
}

function getKeyboardButtons(ctx: Context): Array<Array<{ text: string; callback_data?: string }>> {
  const calls = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls;
  const options = calls[0]?.[1] as {
    reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> };
  };
  return options.reply_markup.inline_keyboard;
}

let container: AppContainer;

beforeEach(() => {
  container = createTestAppContainer();
});

describe("bot/commands/sessions", () => {
  beforeEach(() => {
    container.interactionManager.clear("test_setup");
    mocked.currentProject = {
      id: "project-1",
      worktree: "/repo",
    };

    mocked.sessionListMock.mockReset();
    mocked.sessionGetMock.mockReset();
    mocked.sessionMessagesMock.mockReset();
    mocked.sessionMessagesMock.mockResolvedValue({ data: [], error: null });
    mocked.sessionMessagePageMock.mockReset();
    mocked.sessionMessagePageMock.mockResolvedValue({
      data: { messages: [], nextCursor: undefined },
      error: null,
    });
    mocked.sessionStatusMock.mockReset();
    mocked.sessionStatusMock.mockResolvedValue({ data: {}, error: null });
    mocked.sessionMessageMock.mockReset();
    mocked.setCurrentSessionMock.mockReset();
    mocked.clearInteractionMock.mockReset();
    mocked.keyboardInitializeMock.mockReset();
    mocked.keyboardGetKeyboardMock.mockReset();
    mocked.keyboardGetKeyboardMock.mockReturnValue({ inline_keyboard: [] });
    mocked.keyboardGetContextInfoMock.mockReset();
    mocked.keyboardGetContextInfoMock.mockReturnValue(null);
    mocked.keyboardUpdateAgentMock.mockReset();
    mocked.keyboardUpdateModelMock.mockReset();
    mocked.keyboardUpdateContextMock.mockReset();
    mocked.applySessionSettingsMock.mockReset();
    mocked.resolveProjectAgentMock.mockReset();
    mocked.resolveProjectAgentMock.mockResolvedValue("build");
    mocked.attachToSessionMock.mockReset();
    mocked.attachToSessionMock.mockResolvedValue({
      busy: false,
      alreadyAttached: false,
      restoredQuestion: false,
      restoredPermissions: 0,
    });
    mocked.ensureEventSubscriptionMock.mockReset();
    safeBackgroundTaskMock.mockReset();
  });

  it("shows next-page button when sessions exceed page size", async () => {
    const sessions = Array.from({ length: 11 }, (_, index) => createSession(index));
    mocked.sessionListMock.mockResolvedValueOnce({ data: sessions, error: null });

    const ctx = createCommandContext();
    await sessionsCommand(ctx as never, createDeps());

    expect(mocked.sessionListMock).toHaveBeenCalledWith({
      directory: "/repo",
      limit: 11,
      roots: true,
    });

    const keyboardRows = getKeyboardButtons(ctx);
    expect(keyboardRows[0]?.[0]?.callback_data).toBe("session:session-1");
    expect(keyboardRows[9]?.[0]?.callback_data).toBe("session:session-10");
    expect(keyboardRows[10]?.[0]?.callback_data).toBe("session:page:1");
    expect(keyboardRows[11]?.[0]?.callback_data).toBe("inline:cancel:session");
  });

  it("blocks sessions command while foreground session is busy", async () => {
    container.foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    const ctx = createCommandContext();
    await sessionsCommand(ctx as never, createDeps());

    expect(mocked.sessionListMock).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("bot.session_busy"));
  });

  it("handles next-page callback and renders second page with prev button", async () => {
    const pageTwoData = Array.from({ length: 12 }, (_, index) => createSession(index));
    mocked.sessionListMock.mockResolvedValueOnce({ data: pageTwoData, error: null });

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    const ctx = createCallbackContext("session:page:1", 456);
    const handled = await handleSessionSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sessionListMock).toHaveBeenCalledWith({
      directory: "/repo",
      limit: 21,
      roots: true,
    });
    expect(ctx.editMessageText).toHaveBeenCalledTimes(1);

    const [text, options] = defined((ctx.editMessageText as ReturnType<typeof vi.fn>).mock.calls[0]) as [
      string,
      { reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> } },
    ];

    expect(text).toBe(t("sessions.select_page", { page: 2 }));
    const inlineRows = options.reply_markup.inline_keyboard;
    expect(inlineRows[0]?.[0]?.callback_data).toBe("session:session-11");
    expect(inlineRows[1]?.[0]?.callback_data).toBe("session:session-12");
    expect(inlineRows[2]?.[0]?.callback_data).toBe("session:page:0");
    expect(inlineRows[3]?.[0]?.callback_data).toBe("inline:cancel:session");
  });

  it("returns page-empty callback message when requested page has no sessions", async () => {
    mocked.sessionListMock.mockResolvedValueOnce({ data: [], error: null });

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    const ctx = createCallbackContext("session:page:2", 456);
    const handled = await handleSessionSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("sessions.page_empty_callback"),
    });
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it("keeps active menu and interaction state when page load fails", async () => {
    mocked.sessionListMock.mockResolvedValueOnce({
      data: null,
      error: new Error("session list failed"),
    });

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    const ctx = createCallbackContext("session:page:1", 456);
    const handled = await handleSessionSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("sessions.page_load_error_callback"),
    });
    expect((ctx.api.deleteMessage as ReturnType<typeof vi.fn>).mock.calls).toEqual([]);
    expect(ctx.deleteMessage).not.toHaveBeenCalled();
    expect(mocked.clearInteractionMock).not.toHaveBeenCalled();
  });

  it("keeps generic selection error flow when session details fetch fails", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: null,
      error: new Error("session get failed"),
    });

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    const ctx = createCallbackContext("session:session-1", 456);
    const handled = await handleSessionSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.clearInteractionMock).toHaveBeenCalledWith("session_select_error");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: t("sessions.select_error") });
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("resolves the project agent before sending the keyboard for an existing session", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: { data: createSession(0) },
      error: null,
    });
    mocked.resolveProjectAgentMock.mockResolvedValueOnce("plan");

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    const ctx = createCallbackContext("session:session-1", 456);
    const handled = await handleSessionSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.resolveProjectAgentMock).toHaveBeenCalledOnce();
    expect(mocked.keyboardUpdateAgentMock).toHaveBeenCalledWith("plan");
    expect(mocked.attachToSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bot: expect.any(Object),
        chatId: 111,
        session: {
          id: "session-1",
          title: "Session 1",
          directory: "/repo",
        },
        ensureEventSubscription: mocked.ensureEventSubscriptionMock,
      }),
    );
    expect((ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([
      111,
      t("sessions.selected", { title: "Session 1" }),
      expect.objectContaining({
        reply_markup: { inline_keyboard: [] },
      }),
    ]);
    expect(safeBackgroundTaskMock).not.toHaveBeenCalled();
    expect((ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]).toBe(
      t("sessions.preview.empty"),
    );
  });

  it("pages past a newer prompt and shows the finished reply it answers", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: { data: createSession(0) },
      error: null,
    });
    // Newest page: 20 tool-only assistant turns plus a prompt nobody answered.
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      id: `page1-${index}`,
      role: "assistant",
      text: "",
      created: 2000 + index,
    }));
    firstPage[19] = createSessionMessage("user", "unanswered prompt", 2019);
    mocked.sessionMessagePageMock.mockReset();
    mocked.sessionMessagePageMock
      .mockResolvedValueOnce({ data: { messages: firstPage, nextCursor: "cursor-1" }, error: null })
      .mockResolvedValueOnce({
        data: {
          messages: [
            createSessionMessage("user", "answered prompt", 100),
            createSessionMessage("assistant", "finished reply", 150),
          ],
          nextCursor: undefined,
        },
        error: null,
      });

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    const ctx = createCallbackContext("session:session-1", 456);
    await handleSessionSelect(ctx, createDeps());

    expect(mocked.sessionMessagePageMock).toHaveBeenNthCalledWith(1, "session-1", {
      limit: 20,
      order: "desc",
    });
    expect(mocked.sessionMessagePageMock).toHaveBeenNthCalledWith(2, "session-1", {
      limit: 20,
      cursor: "cursor-1",
    });
    const sent = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => String(call[1]),
    );
    expect(sent.some((text) => text.includes("answered prompt"))).toBe(true);
    expect(sent.some((text) => text.includes("finished reply"))).toBe(true);
    expect(sent.some((text) => text.includes("unanswered prompt"))).toBe(false);
    expect(sent.some((text) => text.includes("Recent messages:"))).toBe(false);
    expect(safeBackgroundTaskMock).not.toHaveBeenCalled();
  });

  it("sends the empty notice when a later history page fails", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: { data: createSession(0) },
      error: null,
    });
    const firstPage = Array.from({ length: 20 }, (_, index) =>
      createSessionMessage("user", "only a prompt", 2000 + index),
    );
    mocked.sessionMessagePageMock.mockReset();
    mocked.sessionMessagePageMock
      .mockResolvedValueOnce({ data: { messages: firstPage, nextCursor: "cursor-1" }, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("page failed") });

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    const ctx = createCallbackContext("session:session-1", 456);
    await handleSessionSelect(ctx, createDeps());

    const sent = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[1]),
    );
    expect(sent).toContain(t("sessions.preview.empty"));
    expect(sent.some((text) => text.includes("only a prompt"))).toBe(false);
  });

  it("stops after the first page for a busy session once a completed reply is found", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: { data: createSession(0) },
      error: null,
    });
    mocked.sessionStatusMock.mockResolvedValueOnce({
      data: { "session-1": { type: "busy" } },
      error: null,
    });
    const firstPage = [
      createSessionMessage("user", "the prompt", 2000),
      createSessionMessage("assistant", "finished reply", 2001, 2010),
      ...Array.from({ length: 18 }, (_, index) =>
        createSessionMessage("assistant", "", 2100 + index),
      ),
    ];
    mocked.sessionMessagePageMock.mockReset();
    mocked.sessionMessagePageMock.mockResolvedValueOnce({
      data: { messages: firstPage, nextCursor: "cursor-1" },
      error: null,
    });

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    const ctx = createCallbackContext("session:session-1", 456);
    await handleSessionSelect(ctx, createDeps());

    // The completed reply is eligible even while busy, so paging must stop here.
    expect(mocked.sessionMessagePageMock).toHaveBeenCalledTimes(1);
    const sent = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[1]),
    );
    expect(sent.some((text) => text.includes("finished reply"))).toBe(true);
  });

  it("does not show an in-flight reply when session status cannot be read", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: { data: createSession(0) },
      error: null,
    });
    mocked.sessionStatusMock.mockResolvedValueOnce({ error: { message: "down" } });
    mocked.sessionMessagePageMock.mockReset();
    mocked.sessionMessagePageMock.mockResolvedValueOnce({
      data: {
        messages: [
          createSessionMessage("user", "the prompt", 1),
          createSessionMessage("assistant", "partial reply", 2),
        ],
        nextCursor: undefined,
      },
      error: null,
    });

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    const ctx = createCallbackContext("session:session-1", 456);
    await handleSessionSelect(ctx, createDeps());

    const sent = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[1]),
    );
    expect(sent.some((text) => text.includes("partial reply"))).toBe(false);
    expect(sent.some((text) => text.includes("the prompt"))).toBe(true);
  });

  it("sends the latest user prompt as a quote when there is no assistant reply to preview", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: { data: createSession(0) },
      error: null,
    });
    const messages = Array.from({ length: 5 }, (_, index) =>
      createSessionMessage("user", "only a prompt", 2000 + index),
    );
    mocked.sessionMessagePageMock.mockReset();
    mocked.sessionMessagePageMock.mockResolvedValueOnce({
      data: { messages, nextCursor: undefined },
      error: null,
    });

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    const ctx = createCallbackContext("session:session-1", 456);
    await handleSessionSelect(ctx, createDeps());

    const sent = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[1]),
    );
    expect(sent).not.toContain(t("sessions.preview.empty"));
    expect(sent.some((text) => text.includes("only a prompt"))).toBe(true);
  });

  it("pulls the settings of the selected session before attaching to it", async () => {
    const session = createSession(0);
    mocked.sessionGetMock.mockResolvedValueOnce({ data: { data: session }, error: null });

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    await handleSessionSelect(createCallbackContext("session:session-1", 456), createDeps());

    expect(mocked.applySessionSettingsMock).toHaveBeenCalledWith(session);
    expect(defined(mocked.applySessionSettingsMock.mock.invocationCallOrder[0])).toBeLessThan(
      defined(mocked.attachToSessionMock.mock.invocationCallOrder[0]),
    );
  });

  it("puts the pulled model on the keyboard sent with the selection message", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({ data: { data: createSession(0) }, error: null });

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    await handleSessionSelect(createCallbackContext("session:session-1", 456), createDeps());

    expect(mocked.keyboardUpdateModelMock).toHaveBeenCalledWith({
      providerID: "opencode-go",
      modelID: "deepseek-v4-flash",
      variant: "default",
    });
    expect(defined(mocked.keyboardUpdateModelMock.mock.invocationCallOrder[0])).toBeLessThan(
      defined(mocked.keyboardGetKeyboardMock.mock.invocationCallOrder[0]),
    );
  });

  it("pulls the settings when a background session notification is opened", async () => {
    const session = createSession(0);
    mocked.sessionGetMock.mockResolvedValueOnce({ data: { data: session }, error: null });

    const handled = await handleBackgroundSessionOpen(
      createCallbackContext("background-session:session-1", 456),
      createDeps(),
    );

    expect(handled).toBe(true);
    expect(mocked.applySessionSettingsMock).toHaveBeenCalledWith(session);
  });

  it("blocks session selection callback while foreground session is busy", async () => {
    container.foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "session",
        messageId: 456,
      },
    });

    const ctx = createCallbackContext("session:session-1", 456);
    const handled = await handleSessionSelect(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sessionGetMock).not.toHaveBeenCalled();
    expect(mocked.setCurrentSessionMock).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("bot.session_busy"),
    });
  });

  it("builds a persistent background session open button", () => {
    const keyboard = buildBackgroundSessionOpenKeyboard("session-1", "assistant_response");

    expect(keyboard.inline_keyboard[0]?.[0]).toEqual({
      text: t("background.open_session_button"),
      callback_data: "background-session:a:session-1",
    });
  });

  it("selects a background session without an active sessions menu", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: { data: createSession(0) },
      error: null,
    });

    const ctx = createCallbackContext("background-session:session-1", 456);
    const handled = await handleBackgroundSessionOpen(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sessionGetMock).toHaveBeenCalledWith({
      sessionID: "session-1",
    });
    expect(mocked.setCurrentSessionMock).toHaveBeenCalledWith({
      id: "session-1",
      title: "Session 1",
      directory: "/repo",
    });
    expect(mocked.attachToSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bot: expect.any(Object),
        chatId: 111,
        session: {
          id: "session-1",
          title: "Session 1",
          directory: "/repo",
        },
        ensureEventSubscription: mocked.ensureEventSubscriptionMock,
      }),
    );
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledOnce();
    expect(ctx.deleteMessage).not.toHaveBeenCalled();
    expect((ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1]).toEqual([
      111,
      t("sessions.selected", { title: "Session 1" }),
      expect.objectContaining({
        reply_markup: { inline_keyboard: [] },
      }),
    ]);
    expect(safeBackgroundTaskMock).not.toHaveBeenCalled();
  });

  it("sends the full latest assistant response after opening an assistant background notification", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: { data: createSession(0) },
      error: null,
    });
    const latestResponse = `Final assistant response. ${"More details. ".repeat(380)}`.trimEnd();
    mocked.sessionMessagesMock.mockResolvedValueOnce({
      data: [
        createSessionMessage("assistant", "Old assistant response", 100),
        createSessionMessage("user", "User prompt should not be forwarded", 200),
        createSessionMessage("assistant", latestResponse, 400),
      ],
      error: null,
    });

    const ctx = createCallbackContext("background-session:a:session-1", 456);
    const handled = await handleBackgroundSessionOpen(ctx, createDeps());

    expect(handled).toBe(true);
    expect(safeBackgroundTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskName: "sessions.sendLatestAssistantResponse",
      }),
    );

    const taskOptions = safeBackgroundTaskMock.mock.calls[0]?.[0];
    if (!taskOptions) {
      throw new Error("Expected latest assistant response background task");
    }

    const sendMessageMock = ctx.api.sendMessage as ReturnType<typeof vi.fn>;
    const previousSendCount = sendMessageMock.mock.calls.length;
    await taskOptions.task();

    expect(mocked.sessionMessagesMock).toHaveBeenCalledWith("session-1", 20);

    const assistantResponseCalls = sendMessageMock.mock.calls.slice(previousSendCount);
    expect(assistantResponseCalls.length).toBeGreaterThan(1);
    expect(assistantResponseCalls.map((call) => call[1]).join("")).toBe(latestResponse);
    expect(assistantResponseCalls.map((call) => call[1]).join("")).not.toContain(
      "User prompt should not be forwarded",
    );
  });

  it("does not send preview or latest assistant response for background question notifications", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: { data: createSession(0) },
      error: null,
    });

    const ctx = createCallbackContext("background-session:q:session-1", 456);
    const handled = await handleBackgroundSessionOpen(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sessionMessagesMock).not.toHaveBeenCalled();
    expect(safeBackgroundTaskMock).not.toHaveBeenCalled();
  });

  it("keeps background session button usable when another inline menu is active", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: { data: createSession(0) },
      error: null,
    });
    startInteractionForTest(container.interactionManager, {
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "model",
        messageId: 999,
      },
    });

    const ctx = createCallbackContext("background-session:session-1", 456);
    const handled = await handleBackgroundSessionOpen(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sessionGetMock).toHaveBeenCalledWith({
      sessionID: "session-1",
    });
    expect(mocked.setCurrentSessionMock).toHaveBeenCalledWith({
      id: "session-1",
      title: "Session 1",
      directory: "/repo",
    });
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledOnce();
  });

  it("keeps successful background selection when removing the button fails", async () => {
    mocked.sessionGetMock.mockResolvedValueOnce({
      data: { data: createSession(0) },
      error: null,
    });

    const ctx = createCallbackContext("background-session:session-1", 456);
    (ctx.editMessageReplyMarkup as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("edit failed"),
    );
    const handled = await handleBackgroundSessionOpen(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.setCurrentSessionMock).toHaveBeenCalledWith({
      id: "session-1",
      title: "Session 1",
      directory: "/repo",
    });
    expect(mocked.attachToSessionMock).toHaveBeenCalledOnce();
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledOnce();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
  });

  it("blocks background session open while foreground session is busy", async () => {
    container.foregroundSessionState.markBusy("session-1", "D:\\Projects\\Repo");

    const ctx = createCallbackContext("background-session:session-2", 456);
    const handled = await handleBackgroundSessionOpen(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sessionGetMock).not.toHaveBeenCalled();
    expect(mocked.setCurrentSessionMock).not.toHaveBeenCalled();
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("bot.session_busy"),
    });
  });

  it("blocks background session open during non-inline interactions", async () => {
    startInteractionForTest(container.interactionManager, {
      kind: "question",
      expectedInput: "callback",
    });

    const ctx = createCallbackContext("background-session:session-1", 456);
    const handled = await handleBackgroundSessionOpen(ctx, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sessionGetMock).not.toHaveBeenCalled();
    expect(mocked.setCurrentSessionMock).not.toHaveBeenCalled();
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: t("interaction.blocked.finish_current"),
    });
  });

  it("ignores unrelated callbacks in background session handler", async () => {
    const ctx = createCallbackContext("model:openai/gpt", 456);
    const handled = await handleBackgroundSessionOpen(ctx, createDeps());

    expect(handled).toBe(false);
    expect(mocked.sessionGetMock).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });
});
