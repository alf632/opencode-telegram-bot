import type { Event } from "@opencode-ai/sdk/v2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundSessionTracker } from "../../../src/app/managers/background-session-manager.js";

const mocked = vi.hoisted(() => ({
  isScheduledTaskSessionIgnoredMock: vi.fn((_sessionId: string) => false),
}));

vi.mock("../../../src/app/services/scheduled-task-session-ignore-service.js", () => ({
  isScheduledTaskSessionIgnored: mocked.isScheduledTaskSessionIgnoredMock,
}));

function event(value: unknown): Event {
  return value as Event;
}

async function flushNotifications(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe("BackgroundSessionTracker", () => {
  beforeEach(() => {
    mocked.isScheduledTaskSessionIgnoredMock.mockReturnValue(false);
  });

  it("notifies once when a background session becomes idle after an assistant message completes", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);

    tracker.processEvent(
      event({
        type: "session.updated",
        properties: { info: { id: "session-2", title: "Background Task" } },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "message.updated",
        properties: {
          info: {
            id: "message-1",
            sessionID: "session-2",
            role: "assistant",
            time: { completed: 123 },
          },
        },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).not.toHaveBeenCalled();

    tracker.processEvent(
      event({
        type: "session.idle",
        properties: { sessionID: "session-2" },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).toHaveBeenCalledWith({
      kind: "assistant_response",
      sessionId: "session-2",
      sessionTitle: "Background Task",
      messageId: "message-1",
    });
  });

  it("does not notify for the current session", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);

    tracker.processEvent(
      event({
        type: "message.updated",
        properties: {
          info: {
            id: "message-1",
            sessionID: "session-1",
            role: "assistant",
            time: { completed: 123 },
          },
        },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "session.idle",
        properties: { sessionID: "session-1" },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).not.toHaveBeenCalled();
  });

  it("coalesces multiple completed assistant messages into one idle notification", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);
    const firstCompletedEvent = event({
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          sessionID: "session-2",
          role: "assistant",
          time: { completed: 123 },
        },
      },
    });
    const secondCompletedEvent = event({
      type: "message.updated",
      properties: {
        info: {
          id: "message-2",
          sessionID: "session-2",
          role: "assistant",
          time: { completed: 456 },
        },
      },
    });

    tracker.processEvent(firstCompletedEvent, "session-1");
    tracker.processEvent(firstCompletedEvent, "session-1");
    tracker.processEvent(secondCompletedEvent, "session-1");
    tracker.processEvent(
      event({
        type: "session.idle",
        properties: { sessionID: "session-2" },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-2" }),
    );
  });

  it("notifies about background questions and permissions", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);

    tracker.processEvent(
      event({
        type: "question.asked",
        properties: { id: "question-1", sessionID: "session-2", questions: [] },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "session-2", permission: "bash" },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).toHaveBeenCalledWith({
      kind: "question_asked",
      sessionId: "session-2",
      sessionTitle: undefined,
      requestId: "question-1",
    });
    expect(onNotification).toHaveBeenCalledWith({
      kind: "permission_asked",
      sessionId: "session-2",
      sessionTitle: undefined,
      requestId: "permission-1",
    });
  });

  it("deduplicates question and permission request ids", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);
    const questionEvent = event({
      type: "question.asked",
      properties: { id: "question-1", sessionID: "session-2", questions: [] },
    });
    const permissionEvent = event({
      type: "permission.asked",
      properties: { id: "permission-1", sessionID: "session-2", permission: "bash" },
    });

    tracker.processEvent(questionEvent, "session-1");
    tracker.processEvent(questionEvent, "session-1");
    tracker.processEvent(permissionEvent, "session-1");
    tracker.processEvent(permissionEvent, "session-1");

    await flushNotifications();

    expect(onNotification).toHaveBeenCalledTimes(2);
  });

  it("coalesces repeated permission requests of one session into a single notice", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);

    tracker.processEvent(
      event({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "session-2", permission: "bash" },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "permission.asked",
        properties: { id: "permission-2", sessionID: "session-2", permission: "edit" },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "permission_asked", requestId: "permission-1" }),
    );
  });

  it("notifies again when a permission request is asked after a reply", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);

    tracker.processEvent(
      event({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "session-2", permission: "bash" },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "permission.asked",
        properties: { id: "permission-2", sessionID: "session-2", permission: "edit" },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "permission.replied",
        properties: { sessionID: "session-2", requestID: "permission-1", reply: "once" },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "permission.asked",
        properties: { id: "permission-3", sessionID: "session-2", permission: "webfetch" },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).toHaveBeenCalledTimes(2);
    expect(onNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "permission_asked", requestId: "permission-3" }),
    );
  });

  it("coalesces repeated question requests of one session and re-arms on a reply", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);

    tracker.processEvent(
      event({
        type: "question.asked",
        properties: { id: "question-1", sessionID: "session-2", questions: [] },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "question.asked",
        properties: { id: "question-2", sessionID: "session-2", questions: [] },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).toHaveBeenCalledTimes(1);

    tracker.processEvent(
      event({
        type: "question.replied",
        properties: { sessionID: "session-2", requestID: "question-1", answers: [] },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "question.asked",
        properties: { id: "question-3", sessionID: "session-2", questions: [] },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).toHaveBeenCalledTimes(2);
    expect(onNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "question_asked", requestId: "question-3" }),
    );
  });

  it("re-arms the coalesced question notice when the question is rejected", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);

    tracker.processEvent(
      event({
        type: "question.asked",
        properties: { id: "question-1", sessionID: "session-2", questions: [] },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "question.asked",
        properties: { id: "question-2", sessionID: "session-2", questions: [] },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "question.rejected",
        properties: { sessionID: "session-2", requestID: "question-1" },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "question.asked",
        properties: { id: "question-3", sessionID: "session-2", questions: [] },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).toHaveBeenCalledTimes(2);
    expect(onNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "question_asked", requestId: "question-3" }),
    );
  });

  it("treats question and permission notices of one session as independent", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);

    tracker.processEvent(
      event({
        type: "question.asked",
        properties: { id: "question-1", sessionID: "session-2", questions: [] },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "session-2", permission: "bash" },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "question.asked",
        properties: { id: "question-2", sessionID: "session-2", questions: [] },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "permission.asked",
        properties: { id: "permission-2", sessionID: "session-2", permission: "edit" },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).toHaveBeenCalledTimes(2);
  });

  it("ignores child sessions to avoid duplicate subagent notifications", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);

    tracker.processEvent(
      event({
        type: "session.created",
        properties: { info: { id: "child-1", parentID: "session-1", title: "Subagent" } },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "message.updated",
        properties: {
          info: {
            id: "message-1",
            sessionID: "child-1",
            role: "assistant",
            time: { completed: 123 },
          },
        },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "session.idle",
        properties: { sessionID: "child-1" },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).not.toHaveBeenCalled();
  });

  it("ignores scheduled task sessions", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);
    mocked.isScheduledTaskSessionIgnoredMock.mockImplementation(
      (sessionId: string) => sessionId === "scheduled-session",
    );

    tracker.processEvent(
      event({
        type: "message.updated",
        properties: {
          info: {
            id: "message-1",
            sessionID: "scheduled-session",
            role: "assistant",
            time: { completed: 123 },
          },
        },
      }),
      "session-1",
    );
    tracker.processEvent(
      event({
        type: "session.idle",
        properties: { sessionID: "scheduled-session" },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).not.toHaveBeenCalled();
  });

  it("clears dedupe state when the directory changes", async () => {
    const tracker = new BackgroundSessionTracker();
    const onNotification = vi.fn();
    tracker.setOnNotification(onNotification);
    const completedEvent = event({
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          sessionID: "session-2",
          role: "assistant",
          time: { completed: 123 },
        },
      },
    });

    tracker.setDirectory("D:/repo-a");
    tracker.processEvent(completedEvent, "session-1");
    tracker.processEvent(
      event({
        type: "session.idle",
        properties: { sessionID: "session-2" },
      }),
      "session-1",
    );
    tracker.setDirectory("D:/repo-b");
    tracker.processEvent(completedEvent, "session-1");
    tracker.processEvent(
      event({
        type: "session.idle",
        properties: { sessionID: "session-2" },
      }),
      "session-1",
    );

    await flushNotifications();

    expect(onNotification).toHaveBeenCalledTimes(2);
  });
});
