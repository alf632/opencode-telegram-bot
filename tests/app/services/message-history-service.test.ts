import { beforeEach, describe, expect, it, vi } from "vitest";

const messages = vi.hoisted(() => vi.fn());
vi.mock("../../../src/opencode/client.js", () => ({
  opencodeV2: { session: { messages } },
}));

import { loadLatestAssistantMetrics } from "../../../src/app/services/message-history-service.js";

const assistant = (created: number, input: number, summary = false) => ({
  type: "assistant" as const,
  id: `msg-${created}`,
  time: { created, completed: created + 1 },
  content: [{ type: "text" as const, text: summary ? "Summary" : "Private answer text" }],
  tokens: { input, output: 12, reasoning: 3, cache: { read: 8, write: 4 } },
  cost: 0.123,
});

const user = (created: number) => ({
  type: "user" as const,
  id: `msg-${created}`,
  time: { created },
  text: "Hello",
});

describe("loadLatestAssistantMetrics", () => {
  beforeEach(() => messages.mockReset());

  it("selects the latest assistant and returns only its metrics", async () => {
    messages.mockResolvedValue({
      data: { data: [assistant(20, 200), assistant(10, 100), assistant(5, 50)] },
    });

    expect(await loadLatestAssistantMetrics("session", "directory")).toEqual({
      input: 200, output: 12, reasoning: 3, cacheRead: 8, cacheWrite: 4, cost: 0.123,
    });
    expect(messages).toHaveBeenCalledWith({ sessionID: "session" });
  });

  it("returns no breakdown when there is no assistant message", async () => {
    messages.mockResolvedValue({ data: { data: [user(1)] } });
    expect(await loadLatestAssistantMetrics("session", "directory")).toBeNull();
  });

  it("does not mistake a failed fetch for empty history", async () => {
    messages.mockResolvedValue({ error: new Error("offline") });
    await expect(loadLatestAssistantMetrics("session", "directory")).rejects.toThrow("offline");
  });
});
