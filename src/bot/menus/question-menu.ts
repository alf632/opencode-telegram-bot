import { Context, InlineKeyboard } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import {
  getSessionForm,
  replyToSessionForm,
  type SessionFormField,
  type SessionFormInfo,
  type SessionFormValue,
} from "../../app/services/session-form-service.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { t } from "../../i18n/index.js";
import { editRenderedBotPart, sendRenderedBotPart } from "../messages/telegram-text.js";
import type { TelegramRenderedPart, TelegramRichBlock } from "../render/types.js";

const MAX_BUTTON_LENGTH = 60;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TRUNCATION_SUFFIX = "…";
const QUESTION_EMOJI = "❓";

export type QuestionInteractionDeps = Pick<AppContainer, "interactionManager">;

type QuestionDataDeps = Pick<AppContainer, "questionManager">;

export type QuestionStateDeps = Pick<AppContainer, "interactionManager" | "questionManager">;

export type QuestionMenuDeps = Pick<
  AppContainer,
  "interactionManager" | "questionManager" | "summaryAggregator"
>;

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

export function clearQuestionInteraction(reason: string, deps: QuestionInteractionDeps): void {
  const state = deps.interactionManager.getSnapshot();
  if (state?.kind === "question") {
    deps.interactionManager.clear(reason);
  }
}

export function syncQuestionInteractionState(
  expectedInput: "callback" | "mixed",
  questionIndex: number,
  messageId: number | null,
  deps: QuestionStateDeps,
): void {
  const metadata: Record<string, unknown> = {
    questionIndex,
    inputMode: expectedInput === "mixed" ? "custom" : "options",
  };

  const requestID = deps.questionManager.getRequestID();
  if (requestID) {
    metadata.requestID = requestID;
  }

  if (messageId !== null) {
    metadata.messageId = messageId;
  }

  // The slot is opened by questionManager.startQuestions; only refine it here.
  if (deps.interactionManager.getSnapshot()?.kind !== "question") {
    return;
  }

  deps.interactionManager.transition({
    expectedInput,
    metadata,
  });
}

export async function updateQuestionMessage(
  ctx: Context,
  deps: QuestionDataDeps,
): Promise<void> {
  const { questionManager } = deps;
  const question = questionManager.getCurrentQuestion();
  if (!question) {
    logger.debug("[QuestionHandler] updateQuestionMessage: no current question");
    return;
  }

  const part = formatQuestionDetailsPart(question, deps);
  const keyboard = buildQuestionKeyboard(
    question,
    questionManager.getSelectedOptions(questionManager.getCurrentIndex()),
    deps,
  );

  logger.debug("[QuestionHandler] Updating question message");

  try {
    const chatId = ctx.chat?.id;
    const messageId = getCallbackMessageId(ctx);

    if (!chatId || messageId === null) {
      await ctx.editMessageText(part.fallbackText, {
        reply_markup: keyboard,
      });
      return;
    }

    await editRenderedBotPart({
      api: ctx.api,
      chatId,
      messageId,
      part,
      options: {
        reply_markup: keyboard,
      },
    });
  } catch (err) {
    logger.error("[QuestionHandler] Failed to update message:", err);
  }
}

export async function showCurrentQuestion(
  bot: Context["api"],
  chatId: number,
  deps: QuestionMenuDeps,
): Promise<void> {
  const { questionManager, summaryAggregator } = deps;
  const question = questionManager.getCurrentQuestion();

  if (!question) {
    await showPollSummary(bot, chatId, deps);
    return;
  }

  logger.debug(`[QuestionHandler] Showing question: ${question.header} - ${question.question}`);

  const part = formatQuestionDetailsPart(question, deps);
  const keyboard = buildQuestionKeyboard(
    question,
    questionManager.getSelectedOptions(questionManager.getCurrentIndex()),
    deps,
  );

  logger.debug(`[QuestionHandler] Sending message with keyboard, chatId=${chatId}`);

  try {
    const { messageId } = await sendRenderedBotPart({
      api: bot,
      chatId,
      part,
      options: {
        reply_markup: keyboard,
      },
    });
    questionManager.addMessageId(messageId);

    logger.debug(`[QuestionHandler] Message sent, messageId=${messageId}`);

    questionManager.setActiveMessageId(messageId);
    syncQuestionInteractionState(
      "callback",
      questionManager.getCurrentIndex(),
      questionManager.getActiveMessageId(),
      deps,
    );

    summaryAggregator.stopTypingIndicator();
  } catch (err) {
    questionManager.clear();
    clearQuestionInteraction("question_message_send_failed", deps);

    logger.error("[QuestionHandler] Failed to send question message:", err);
    throw err;
  }
}

export async function showNextQuestion(ctx: Context, deps: QuestionMenuDeps): Promise<void> {
  deps.questionManager.nextQuestion();

  if (!ctx.chat) {
    return;
  }

  if (deps.questionManager.hasNextQuestion()) {
    await showCurrentQuestion(ctx.api, ctx.chat.id, deps);
  } else {
    await showPollSummary(ctx.api, ctx.chat.id, deps);
  }
}

async function showPollSummary(
  bot: Context["api"],
  chatId: number,
  deps: QuestionStateDeps,
): Promise<void> {
  const { questionManager } = deps;
  const answers = questionManager.getAllAnswers();
  const totalQuestions = questionManager.getTotalQuestions();

  logger.info(
    `[QuestionHandler] Poll completed: ${answers.length}/${totalQuestions} questions answered`,
  );

  // Send all answers to the OpenCode API
  await sendAllAnswersToAgent(bot, chatId, deps);

  if (answers.length === 0) {
    await bot.sendMessage(chatId, t("question.completed_no_answers"));
  } else {
    const summary = formatAnswersSummary(answers);
    await bot.sendMessage(chatId, summary);
  }

  clearQuestionInteraction("question_completed", deps);
  questionManager.clear();
  logger.debug("[QuestionHandler] Poll completed and cleared");
}

// v2 validates an answer against the field it belongs to and rejects a
// mismatch with FormInvalidAnswerError — and it rejects the *whole* reply, so
// one wrong value loses every answer the user just gave. The rules, per field
// type: an external field is acknowledged with `true` and nothing else, a
// multiselect is a string[] of the field's own option values (the typed text
// cannot stand in for it), a typed answer becomes yes/true for a boolean and a
// finite number for number/integer, and a string is sent as typed. Selected
// options are already the server's own values. Unanswered fields, and a number
// the user did not type, are simply omitted.
const BOOLEAN_TRUE_ANSWER = /^(yes|true)$/i;

function coerceFormAnswer(
  field: SessionFormField,
  typedAnswer: string | undefined,
  selectedValues: string[],
): SessionFormValue | undefined {
  // The only value 2.0.16 accepts for an external field, and omitting the key
  // is rejected like any other mismatch.
  if (field.type === "external") {
    return true;
  }

  // A multiselect must stay a string[] of option values: a bare string is
  // rejected, and so is an array holding text the user typed, because the
  // items are validated against the options.
  if (field.type === "multiselect") {
    return selectedValues.length > 0 ? selectedValues : undefined;
  }

  if (typedAnswer !== undefined) {
    if (field.type === "boolean") {
      return BOOLEAN_TRUE_ANSWER.test(typedAnswer);
    }
    if (field.type === "number" || field.type === "integer") {
      const parsed = Number(typedAnswer);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return typedAnswer;
  }

  return selectedValues[0];
}

function buildFormAnswer(
  form: SessionFormInfo,
  deps: QuestionDataDeps,
): Record<string, SessionFormValue> {
  const answer: Record<string, SessionFormValue> = {};

  form.fields.forEach((field, index) => {
    const options = field.options ?? [];
    const selectedValues = [...deps.questionManager.getSelectedOptions(index)]
      .map((optionIndex) => options[optionIndex]?.value)
      .filter((value): value is string => value !== undefined);
    const typedAnswer = deps.questionManager.getCustomAnswer(index)?.trim() || undefined;

    const value = coerceFormAnswer(field, typedAnswer, selectedValues);
    if (value === undefined) {
      return;
    }

    answer[field.key] = value;
  });

  return answer;
}

async function sendAllAnswersToAgent(
  bot: Context["api"],
  chatId: number,
  deps: QuestionDataDeps,
): Promise<void> {
  const { questionManager } = deps;
  const currentSession = getCurrentSession();
  const requestID = questionManager.getRequestID();
  const sessionID = currentSession?.id;

  if (!sessionID) {
    logger.error("[QuestionHandler] No session for sending answers");
    await bot.sendMessage(chatId, t("question.no_active_request"));
    return;
  }

  if (!requestID) {
    logger.error("[QuestionHandler] No requestID for sending answers");
    await bot.sendMessage(chatId, t("question.no_active_request"));
    return;
  }

  // The re-read form is the source of truth for the answer keys, the value
  // types, and the form id the reply goes to. If it no longer matches the poll
  // the answers were collected for, submitting them would be a type or key
  // mismatch the server rejects.
  const { data: form, error: formError } = await getSessionForm(sessionID);
  if (formError) {
    logger.error("[QuestionHandler] Failed to read the pending form:", formError);
    await bot.sendMessage(chatId, t("question.send_answers_error"));
    return;
  }

  if (!form) {
    // No error and no form: the agent settled it while the user was answering.
    // A race, not a read failure, so it is an info and not an error.
    logger.info(
      `[QuestionHandler] Pending form ${requestID} is no longer pending in session ${sessionID}; dropping the collected answers`,
    );
    await bot.sendMessage(chatId, t("question.send_answers_error"));
    return;
  }

  if (form.id !== requestID) {
    logger.error(
      `[QuestionHandler] Pending form changed: poll=${requestID}, form=${form.id}`,
    );
    await bot.sendMessage(chatId, t("question.send_answers_error"));
    return;
  }

  const answer = buildFormAnswer(form, deps);

  logger.info(
    `[QuestionHandler] Sending answers to agent via form.reply: formID=${form.id}`,
  );
  logger.debug(`[QuestionHandler] Answers payload:`, JSON.stringify(answer, null, 2));

  // CRITICAL: Fire-and-forget! Do not wait for form.reply to complete,
  // otherwise it may block subsequent updates
  safeBackgroundTask({
    taskName: "form.reply",
    task: () => replyToSessionForm(sessionID, form.id, answer),
    onSuccess: ({ error }) => {
      if (error) {
        logger.error("[QuestionHandler] Failed to send answers via form.reply:", error);
        void bot.sendMessage(chatId, t("question.send_answers_error")).catch(() => {});
        return;
      }

      logger.info("[QuestionHandler] All answers sent to agent successfully via form.reply");
    },
  });
}

/** A paragraph of the question card: an optional bold lead-in plus regular text. */
interface QuestionSegment {
  label?: string | undefined;
  rest: string;
}

function segmentLength(segment: QuestionSegment): number {
  return (segment.label?.length ?? 0) + segment.rest.length;
}

function segmentToPlainText(segment: QuestionSegment): string {
  return `${segment.label ?? ""}${segment.rest}`;
}

function segmentToBlock(segment: QuestionSegment): TelegramRichBlock {
  if (!segment.label) {
    return { type: "paragraph", text: segment.rest };
  }

  const bold = { type: "bold" as const, text: segment.label };
  return { type: "paragraph", text: segment.rest ? [bold, segment.rest] : bold };
}

function sliceOnSafeBoundary(text: string, maxLength: number): string {
  let endIndex = Math.max(0, Math.min(text.length, maxLength));
  if (endIndex > 0 && isHighSurrogate(text.charCodeAt(endIndex - 1))) {
    endIndex -= 1;
  }

  return text.slice(0, endIndex);
}

function appendTruncationSuffix(segment: QuestionSegment): QuestionSegment {
  return { ...segment, rest: `${segment.rest}${TRUNCATION_SUFFIX}` };
}

/**
 * Keeps the card within the Telegram message limit by dropping whole segments
 * from the tail, cutting only the last one that still partially fits.
 */
function truncateQuestionSegments(
  segments: QuestionSegment[],
  limit: number,
): QuestionSegment[] {
  const separatorLength = 2;
  const result: QuestionSegment[] = [];
  let used = 0;

  for (const segment of segments) {
    const prefix = result.length > 0 ? separatorLength : 0;
    const length = segmentLength(segment);

    if (used + prefix + length <= limit) {
      result.push(segment);
      used += prefix + length;
      continue;
    }

    const available = limit - used - prefix - TRUNCATION_SUFFIX.length;
    const labelLength = segment.label?.length ?? 0;

    if (available > labelLength) {
      result.push(
        appendTruncationSuffix({
          label: segment.label,
          rest: sliceOnSafeBoundary(segment.rest, available - labelLength),
        }),
      );
    } else if (result.length > 0) {
      const lastSegment = result[result.length - 1];
      if (lastSegment) {
        result[result.length - 1] = appendTruncationSuffix(lastSegment);
      }
    } else {
      result.push(
        appendTruncationSuffix({
          rest: sliceOnSafeBoundary(
            segmentToPlainText(segment),
            Math.max(0, limit - TRUNCATION_SUFFIX.length),
          ),
        }),
      );
    }

    break;
  }

  return result;
}

function formatQuestionDetailsPart(question: {
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
}, deps: QuestionDataDeps): TelegramRenderedPart {
  const currentIndex = deps.questionManager.getCurrentIndex();
  const totalQuestions = deps.questionManager.getTotalQuestions();
  const progressText = totalQuestions > 0 ? `${currentIndex + 1}/${totalQuestions}` : "";

  const headerTitle = [QUESTION_EMOJI, progressText, question.header].filter(Boolean).join(" ");
  const multiple = question.multiple ? t("question.multi_hint") : "";
  const questionText = `${question.question}${multiple}`;

  const segments: QuestionSegment[] = [];
  if (headerTitle) {
    segments.push({ label: headerTitle, rest: "" });
  }
  if (questionText) {
    segments.push({ rest: questionText });
  }
  for (const option of question.options) {
    segments.push({
      label: option.label || undefined,
      rest: option.description ? `${option.label ? " — " : ""}${option.description}` : "",
    });
  }

  const visibleSegments = truncateQuestionSegments(
    segments.filter((segment) => segmentLength(segment) > 0),
    TELEGRAM_MESSAGE_LIMIT,
  );

  return {
    blocks: visibleSegments.map(segmentToBlock),
    fallbackText: visibleSegments.map(segmentToPlainText).join("\n\n"),
    source: "blocks",
  };
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function buildQuestionKeyboard(
  question: { options: Array<{ label: string; description: string }>; multiple?: boolean },
  selectedOptions: Set<number>,
  deps: QuestionDataDeps,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  const questionIndex = deps.questionManager.getCurrentIndex();

  logger.debug(`[QuestionHandler] Building keyboard for question ${questionIndex}`);

  question.options.forEach((option, index) => {
    const isSelected = selectedOptions.has(index);
    const icon = isSelected ? "✅ " : "";
    const buttonText = formatButtonText(option.label, icon);
    const callbackData = `question:select:${questionIndex}:${index}`;

    logger.debug(`[QuestionHandler] Button ${index}: "${buttonText}" -> "${callbackData}"`);

    keyboard.text(buttonText, callbackData).row();
  });

  if (question.multiple) {
    keyboard.text(t("question.button.submit"), `question:submit:${questionIndex}`).row();
    logger.debug(`[QuestionHandler] Added submit button`);
  }

  keyboard.text(t("question.button.custom"), `question:custom:${questionIndex}`).row();
  logger.debug(`[QuestionHandler] Added custom answer button`);

  keyboard.text(t("question.button.cancel"), `question:cancel:${questionIndex}`);
  logger.debug(`[QuestionHandler] Added cancel button`);

  logger.debug(`[QuestionHandler] Final keyboard: ${JSON.stringify(keyboard.inline_keyboard)}`);

  return keyboard;
}

function formatButtonText(label: string, icon: string): string {
  let text = `${icon}${label}`;

  if (text.length > MAX_BUTTON_LENGTH) {
    text = text.substring(0, MAX_BUTTON_LENGTH - 3) + "...";
  }

  return text;
}

function formatAnswersSummary(answers: Array<{ question: string; answer: string }>): string {
  let summary = t("question.summary.title");

  answers.forEach((item, index) => {
    summary += t("question.summary.question", {
      index: index + 1,
      question: item.question,
    });
    summary += t("question.summary.answer", { answer: item.answer });
  });

  return summary;
}
