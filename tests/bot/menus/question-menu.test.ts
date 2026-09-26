import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { showNextQuestion } from "../../../src/bot/menus/question-menu.js";
import { t } from "../../../src/i18n/index.js";
import { createTestAppContainer } from "../../helpers/app-container.js";
import type { AppContainer } from "../../../src/app/bootstrap/app-container.js";

const mocked = vi.hoisted(() => ({
  getSessionFormMock: vi.fn(),
  replyToSessionFormMock: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: vi.fn(() => ({ id: "p1", worktree: "/repo" })),
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: vi.fn(() => ({ id: "session-1", directory: "/repo" })),
}));

vi.mock("../../../src/app/services/session-form-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/app/services/session-form-service.js")>()),
  getSessionForm: mocked.getSessionFormMock,
  replyToSessionForm: mocked.replyToSessionFormMock,
}));

const FORM = {
  id: "frm_1",
  sessionID: "session-1",
  title: "Pick",
  fields: [
    {
      key: "mode",
      type: "string",
      title: "Mode",
      description: "How to run",
      options: [
        { value: "build", label: "Build", description: "compile" },
        { value: "plan", label: "Plan", description: "outline" },
      ],
    },
    { key: "note", type: "string", title: "Note" },
  ],
};

function createContext(): { ctx: Context; sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
  const ctx = {
    chat: { id: 42 },
    api: {
      sendMessage,
      sendRichMessage: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Bad Request: rich message unavailable"), { error_code: 400 }),
        ),
      editMessageText: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
  return { ctx, sendMessage };
}

let deps: AppContainer;

beforeEach(() => {
  deps = createTestAppContainer();
  mocked.getSessionFormMock.mockReset();
  mocked.getSessionFormMock.mockResolvedValue({ data: FORM, error: null });
  mocked.replyToSessionFormMock.mockReset();
  mocked.replyToSessionFormMock.mockResolvedValue({ error: null });
});

describe("bot/menus/question-menu", () => {
  it("submits the collected answers as a form reply keyed by field key", async () => {
    deps.questionManager.startQuestions(
      [
        { header: "Mode", question: "How to run", options: [{ label: "Build", description: "compile" }] },
        { header: "Note", question: "Note", options: [] },
      ],
      "frm_1",
    );
    deps.questionManager.selectOption(0, 0);
    deps.questionManager.setCustomAnswer(1, "ship it");
    const { ctx } = createContext();

    await showNextQuestion(ctx, deps);
    await showNextQuestion(ctx, deps);

    expect(mocked.getSessionFormMock).toHaveBeenCalledWith("session-1");
    expect(mocked.replyToSessionFormMock).toHaveBeenCalledWith("session-1", "frm_1", {
      mode: "build",
      note: "ship it",
    });
  });

  it("sends every selected option of a multiselect field", async () => {
    mocked.getSessionFormMock.mockResolvedValue({
      data: {
        ...FORM,
        fields: [
          {
            key: "targets",
            type: "multiselect",
            title: "Targets",
            options: [
              { value: "web", label: "Web" },
              { value: "api", label: "Api" },
            ],
          },
        ],
      },
      error: null,
    });
    deps.questionManager.startQuestions(
      [
        {
          header: "Targets",
          question: "Targets",
          options: [
            { label: "Web", description: "" },
            { label: "Api", description: "" },
          ],
          multiple: true,
        },
      ],
      "frm_1",
    );
    deps.questionManager.selectOption(0, 0);
    deps.questionManager.selectOption(0, 1);
    const { ctx } = createContext();

    await showNextQuestion(ctx, deps);

    expect(mocked.replyToSessionFormMock).toHaveBeenCalledWith("session-1", "frm_1", {
      targets: ["web", "api"],
    });
  });

  it("coerces a typed answer to the type the field declares", async () => {
    mocked.getSessionFormMock.mockResolvedValue({
      data: {
        ...FORM,
        fields: [
          { key: "flag", type: "boolean", title: "Flag" },
          { key: "count", type: "number", title: "Count" },
          { key: "retries", type: "integer", title: "Retries" },
          { key: "doc", type: "external", title: "Doc", url: "https://x.test" },
        ],
      },
      error: null,
    });
    deps.questionManager.startQuestions(
      [
        { header: "Flag", question: "Flag", options: [] },
        { header: "Count", question: "Count", options: [] },
        { header: "Retries", question: "Retries", options: [] },
        { header: "Doc", question: "Doc", options: [] },
      ],
      "frm_1",
    );
    deps.questionManager.setCustomAnswer(0, "yes");
    deps.questionManager.setCustomAnswer(1, "42");
    deps.questionManager.setCustomAnswer(2, "-3");
    deps.questionManager.setCustomAnswer(3, "https://x.test/ticket");
    const { ctx } = createContext();

    for (let i = 0; i < 4; i += 1) {
      await showNextQuestion(ctx, deps);
    }

    expect(mocked.replyToSessionFormMock).toHaveBeenCalledWith("session-1", "frm_1", {
      flag: true,
      count: 42,
      retries: -3,
      doc: "https://x.test/ticket",
    });
  });

  it("reads a boolean answer as false for anything that is not yes or true", async () => {
    mocked.getSessionFormMock.mockResolvedValue({
      data: { ...FORM, fields: [{ key: "flag", type: "boolean", title: "Flag" }] },
      error: null,
    });
    deps.questionManager.startQuestions(
      [{ header: "Flag", question: "Flag", options: [] }],
      "frm_1",
    );
    deps.questionManager.setCustomAnswer(0, "nope");
    const { ctx } = createContext();

    await showNextQuestion(ctx, deps);

    expect(mocked.replyToSessionFormMock).toHaveBeenCalledWith("session-1", "frm_1", {
      flag: false,
    });
  });

  it("omits a numeric field the user answered with something that is not a number", async () => {
    mocked.getSessionFormMock.mockResolvedValue({
      data: { ...FORM, fields: [{ key: "count", type: "number", title: "Count" }] },
      error: null,
    });
    deps.questionManager.startQuestions(
      [{ header: "Count", question: "Count", options: [] }],
      "frm_1",
    );
    deps.questionManager.setCustomAnswer(0, "three");
    const { ctx } = createContext();

    await showNextQuestion(ctx, deps);

    expect(mocked.replyToSessionFormMock).toHaveBeenCalledWith("session-1", "frm_1", {});
  });

  it("does not reply when the pending form no longer matches the poll", async () => {
    mocked.getSessionFormMock.mockResolvedValue({
      data: { ...FORM, id: "frm_2" },
      error: null,
    });
    deps.questionManager.startQuestions(
      [{ header: "Mode", question: "How to run", options: [] }],
      "frm_1",
    );
    deps.questionManager.setCustomAnswer(0, "build");
    const { ctx, sendMessage } = createContext();

    await showNextQuestion(ctx, deps);

    expect(mocked.replyToSessionFormMock).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(42, t("question.send_answers_error"));
  });

  it("reports a failure when the pending form cannot be read", async () => {
    mocked.getSessionFormMock.mockResolvedValue({
      data: null,
      error: new Error("HTTP 404 for GET"),
    });
    deps.questionManager.startQuestions(
      [{ header: "Mode", question: "How to run", options: [] }],
      "frm_1",
    );
    const { ctx, sendMessage } = createContext();

    await showNextQuestion(ctx, deps);

    expect(mocked.replyToSessionFormMock).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(42, t("question.send_answers_error"));
  });
});
