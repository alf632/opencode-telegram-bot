import type { Bot, Context } from "grammy";
import { getBusySessionStatuses, opencodeV2 } from "../../opencode/client.js";
import { isOpencodeServerHealthy } from "../../opencode/ready-refresh.js";
import type { AppContainer } from "../bootstrap/app-container.js";
import type { PermissionRequest } from "../types/permission.js";
import type { SessionInfo } from "../types/session.js";
import { getCurrentSession } from "./session-service.js";
import { getCurrentProject } from "../stores/settings-store.js";
import { getSessionForm, mapFormFieldsToQuestions } from "./session-form-service.js";
import { resolveSessionParentChain } from "./recent-sessions-service.js";
import { resetStreamThrottle } from "../../bot/streaming/stream-throttle.js";
import { logger } from "../../utils/logger.js";
import { isExpectedOpencodeUnavailableError } from "../../utils/opencode-error.js";

interface EnsureAttachPinnedSessionParams {
  api: Bot<Context>["api"];
  chatId: number;
  session: SessionInfo;
  forceFullRestore?: boolean;
}

export interface AttachPresentationDeps {
  ensurePinnedSession(params: EnsureAttachPinnedSessionParams): Promise<void>;
  syncAttachState(attached: boolean, busy: boolean): Promise<void>;
  showCurrentQuestion(api: Bot<Context>["api"], chatId: number): Promise<void>;
  showPermissionRequest(
    api: Bot<Context>["api"],
    chatId: number,
    request: PermissionRequest,
  ): Promise<void>;
}

let attachPresentation: AttachPresentationDeps | null = null;

export function configureAttachPresentation(deps: AttachPresentationDeps | null): void {
  attachPresentation = deps;
}

export type AttachStateDeps = Pick<AppContainer, "attachManager">;

export type DetachSessionDeps = Pick<AppContainer, "attachManager" | "resetAggregator">;

type AttachRestoreDeps = Pick<
  AppContainer,
  "attachManager" | "permissionManager" | "questionManager" | "summaryAggregator" | "interactionManager"
>;

export interface AttachSessionDeps extends AttachRestoreDeps {
  bot: Bot<Context>;
  chatId: number;
  session: SessionInfo;
  ensureEventSubscription: (directory: string) => Promise<void>;
  forceFullRestore?: boolean | undefined;
}

export interface AttachSessionResult {
  busy: boolean;
  alreadyAttached: boolean;
  restoredQuestion: boolean;
  restoredPermissions: number;
}

export interface RestoreAttachedCurrentSessionDeps extends AttachRestoreDeps {
  bot: Bot<Context>;
  chatId: number;
  ensureEventSubscription: (directory: string) => Promise<void>;
  forceFullRestore?: boolean;
}

function getAttachBusyStatus(
  sessionId: string,
  statuses: Record<string, { type?: string }> | undefined,
): boolean {
  return statuses?.[sessionId]?.type === "busy";
}

async function syncPinnedAttachState(deps: AttachStateDeps): Promise<void> {
  if (!attachPresentation) {
    return;
  }

  const attached = deps.attachManager.getSnapshot();
  await attachPresentation.syncAttachState(attached !== null, attached?.busy ?? false);
}

async function restorePendingQuestion(
  deps: AttachRestoreDeps,
  bot: Bot<Context>,
  chatId: number,
  sessionId: string,
  _directory: string,
): Promise<boolean> {
  const { data: pendingForm, error } = await getSessionForm(sessionId);

  // A session with no pending form is the normal case, not a failure: the
  // route answers 200 with an empty list. Only a real error is worth warning.
  if (error) {
    if (isExpectedOpencodeUnavailableError(error)) {
      logger.warn("[Attach] OpenCode server unavailable; skipping pending form restore");
    } else {
      logger.warn("[Attach] Failed to load pending forms during attach:", error);
    }
    return false;
  }

  if (!pendingForm) {
    logger.debug("[Attach] No pending form to restore");
    return false;
  }

  if (!attachPresentation) {
    return false;
  }

  deps.questionManager.startQuestions(mapFormFieldsToQuestions(pendingForm), pendingForm.id);
  await attachPresentation.showCurrentQuestion(bot.api, chatId);
  return true;
}

async function restorePendingPermissions(
  deps: AttachRestoreDeps,
  bot: Bot<Context>,
  chatId: number,
  sessionId: string,
  directory: string,
  questionActive: boolean,
): Promise<number> {
  const { data, error } = await opencodeV2.session.permission.list({
    sessionID: sessionId,
  });

  if (error || !data) {
    if (isExpectedOpencodeUnavailableError(error)) {
      logger.warn("[Attach] OpenCode server unavailable; skipping pending permission restore");
    } else {
      logger.warn("[Attach] Failed to load pending permissions during attach:", error);
    }
    return 0;
  }

  const pendingPermissions: PermissionRequest[] = [];
  for (const request of data.data) {
    const chain = await resolveSessionParentChain(request.sessionID, directory, new Set([sessionId]));
    if (!chain) continue;
    for (const link of chain.links.reverse()) {
      deps.summaryAggregator.registerRestoredPermissionChild(link.child, link.parent);
    }
    pendingPermissions.push({
      id: request.id,
      sessionID: request.sessionID,
      permission: request.action,
      patterns: request.resources,
      metadata: request.metadata ?? {},
      always: request.save ?? [],
    });
  }
  if (!attachPresentation) {
    return 0;
  }

  for (const request of pendingPermissions) {
    if (questionActive) {
      deps.interactionManager.waitPermission(request);
    } else {
      await attachPresentation.showPermissionRequest(bot.api, chatId, request);
    }
  }

  return pendingPermissions.length;
}

export async function attachToSession(deps: AttachSessionDeps): Promise<AttachSessionResult> {
  const { bot, chatId, session, ensureEventSubscription, forceFullRestore = false } = deps;
  const { attachManager, permissionManager, questionManager, summaryAggregator } = deps;
  const alreadyAttached = attachManager.isAttachedSession(session.id, session.directory);

  await attachPresentation?.ensurePinnedSession({
    api: bot.api,
    chatId,
    session,
    forceFullRestore,
  });

  if (!alreadyAttached) {
    await ensureEventSubscription(session.directory);
    summaryAggregator.setSession(session.id);
    summaryAggregator.setBotAndChatId(bot, chatId);
    attachManager.attach(session.id, session.directory);
  } else {
    summaryAggregator.setSession(session.id);
    summaryAggregator.setBotAndChatId(bot, chatId);
  }

  const { data: statuses, error: statusesError } = await getBusySessionStatuses();

  if (statusesError) {
    if (isExpectedOpencodeUnavailableError(statusesError)) {
      logger.warn("[Attach] OpenCode server unavailable; skipping session status restore");
    } else {
      logger.warn("[Attach] Failed to load session status during attach:", statusesError);
    }
  }

  const busy = getAttachBusyStatus(session.id, statuses);
  if (busy) {
    attachManager.markBusy(session.id);
  } else {
    attachManager.markIdle(session.id);
  }

  await syncPinnedAttachState(deps);

  let restoredQuestion = false;
  let restoredPermissions = 0;

  if (
    (!alreadyAttached || forceFullRestore) &&
    !questionManager.isActive() &&
    !permissionManager.isActive()
  ) {
    restoredQuestion = await restorePendingQuestion(deps, bot, chatId, session.id, session.directory);

    restoredPermissions = await restorePendingPermissions(
      deps,
      bot,
      chatId,
      session.id,
      session.directory,
      restoredQuestion,
    );
  }

  return {
    busy,
    alreadyAttached,
    restoredQuestion,
    restoredPermissions,
  };
}

export async function restoreAttachedCurrentSession(
  deps: RestoreAttachedCurrentSessionDeps,
): Promise<boolean> {
  const currentProject = getCurrentProject();
  const currentSession = getCurrentSession();

  if (!currentProject || !currentSession) {
    return false;
  }

  if (currentSession.directory !== currentProject.worktree) {
    logger.warn(
      `[Attach] Skipping auto-restore because project/session mismatch: sessionDirectory=${currentSession.directory}, projectDirectory=${currentProject.worktree}`,
    );
    return false;
  }

  try {
    if (!(await isOpencodeServerHealthy())) {
      logger.warn(
        `[Attach] OpenCode server is unavailable; skipping followed session restore: session=${currentSession.id}, directory=${currentSession.directory}`,
      );
      return false;
    }

    await attachToSession({ ...deps, session: currentSession });
    logger.info(
      `[Attach] Restored followed session on startup: session=${currentSession.id}, directory=${currentSession.directory}`,
    );
    return true;
  } catch (error) {
    logger.error("[Attach] Failed to restore followed session on startup:", error);
    return false;
  }
}

export function detachAttachedSession(reason: string, deps: DetachSessionDeps): void {
  if (!deps.attachManager.isAttached()) {
    return;
  }

  const attachedSessionId = deps.attachManager.getSnapshot()?.sessionId;
  if (attachedSessionId) {
    resetStreamThrottle(attachedSessionId);
  }

  deps.resetAggregator();
  deps.attachManager.clear(reason);
  void syncPinnedAttachState(deps);
}

export async function markAttachedSessionBusy(
  sessionId: string,
  deps: AttachStateDeps,
): Promise<void> {
  if (!deps.attachManager.markBusy(sessionId)) {
    return;
  }

  await syncPinnedAttachState(deps);
}

export async function markAttachedSessionIdle(
  sessionId: string,
  deps: AttachStateDeps,
): Promise<void> {
  if (!deps.attachManager.markIdle(sessionId)) {
    return;
  }

  await syncPinnedAttachState(deps);
}
