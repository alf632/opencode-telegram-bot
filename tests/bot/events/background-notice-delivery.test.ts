import { describe, expect, it, vi } from "vitest";
import { t } from "../../../src/i18n/index.js";
import type { BackgroundSessionNotification } from "../../../src/app/managers/background-session-manager.js";
import { createBackgroundNoticeDelivery } from "../../../src/bot/events/background-notice-delivery.js";
import type {
  SessionTargetPolicy,
  TelegramDestination,
  TelegramEventDelivery,
} from "../../../src/bot/events/telegram-event-delivery.js";

type SendTextMock = ReturnType<typeof vi.fn>;

function createDestination(): TelegramDestination {
  return { api: {} as TelegramDestination["api"], chatId: 42 };
}

function createHarness(options?: {
  destination?: TelegramDestination | null;
  isForegroundSession?: boolean;
}) {
  const destination =
    options?.destination === undefined ? createDestination() : options.destination;
  const policy: Pick<SessionTargetPolicy, "getDestination" | "isForegroundSession"> = {
    getDestination: () => destination,
    isForegroundSession: () => options?.isForegroundSession ?? false,
  };
  const sendText = vi.fn().mockResolvedValue(1);
  const delivery = { sendText } as unknown as TelegramEventDelivery;

  return { delivery, policy, sendText };
}

function createNotification(
  overrides: Partial<BackgroundSessionNotification> = {},
): BackgroundSessionNotification {
  return {
    kind: "permission_asked",
    sessionId: "sess-1",
    requestId: "req-1",
    ...overrides,
  };
}

function getKeyboardOptions(sendText: SendTextMock) {
  const [destination, text, options] = sendText.mock.calls[0] as [
    TelegramDestination,
    string,
    { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } },
  ];
  return { destination, text, inlineKeyboard: options.reply_markup.inline_keyboard };
}

describe("bot/events/background-notice-delivery", () => {
  it("does not post a notice for the session the user is following", async () => {
    const { delivery, policy, sendText } = createHarness({ isForegroundSession: true });

    await createBackgroundNoticeDelivery(policy, delivery)(createNotification());

    expect(sendText).not.toHaveBeenCalled();
  });

  it("posts a notice with an open-session button for a background session", async () => {
    const destination = createDestination();
    const { delivery, policy, sendText } = createHarness({
      destination,
      isForegroundSession: false,
    });

    await createBackgroundNoticeDelivery(policy, delivery)(createNotification());

    expect(sendText).toHaveBeenCalledTimes(1);
    const sent = getKeyboardOptions(sendText);
    expect(sent.destination).toBe(destination);
    expect(sent.text).toBe(
      t("background.permission_asked", {
        session: t("background.session_fallback", { id: "sess-1" }),
      }),
    );
    expect(sent.inlineKeyboard).toEqual([
      [{ text: t("background.open_session_button"), callback_data: "background-session:p:sess-1" }],
    ]);
  });

  it("does not post a notice without a destination", async () => {
    const isForegroundSession = vi.fn().mockReturnValue(false);
    const policy: Pick<SessionTargetPolicy, "getDestination" | "isForegroundSession"> = {
      getDestination: () => null,
      isForegroundSession,
    };
    const sendText = vi.fn().mockResolvedValue(1);
    const delivery = { sendText } as unknown as TelegramEventDelivery;

    await createBackgroundNoticeDelivery(policy, delivery)(createNotification());

    expect(sendText).not.toHaveBeenCalled();
    expect(isForegroundSession).not.toHaveBeenCalled();
  });
});
