import type { GlobalSession } from "@opencode-ai/sdk/v2";
import { directApi, getBusySessionStatuses, listSessions, opencodeV2 } from "../../opencode/client.js";
import { getCurrentSession } from "../stores/settings-store.js";

export type RecentStatus = "question" | "permission" | "running" | "idle";
type RecentSessionInfo = Pick<GlobalSession, "id" | "directory" | "title" | "time">;
export type RecentSession = { session: RecentSessionInfo; status: RecentStatus };

interface V2FormInfo {
  id: string;
  sessionID: string;
  title: string;
}

interface V2PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
}

async function loadGlobalSessions(limit: number): Promise<RecentSessionInfo[]> {
  const { data, error } = await listSessions({ roots: true, limit });
  if (error || !data) throw error || new Error("No sessions received from OpenCode");
  return data;
}

export async function resolveSessionParentChain(
  sessionId: string,
  _directory: string,
  roots: Set<string>,
): Promise<{ root: string; links: Array<{ child: string; parent: string }> } | null> {
  const seen = new Set<string>();
  const links: Array<{ child: string; parent: string }> = [];
  let id = sessionId;
  while (!roots.has(id) && !seen.has(id)) {
    seen.add(id);
    const { data, error } = await opencodeV2.session.get({ sessionID: id });
    if (error || !data?.data?.parentID) return null;
    links.push({ child: id, parent: data.data.parentID });
    id = data.data.parentID;
  }
  return roots.has(id) ? { root: id, links } : null;
}

function normalizeDirectory(directory: string): string {
  return directory.replace(/\\/g, "/");
}

export async function loadRecentSessions(limit: number): Promise<RecentSession[]> {
  const sessions: RecentSessionInfo[] = await loadGlobalSessions(limit);
  const attached = getCurrentSession();
  if (attached && !sessions.some((session) => session.id === attached.id) && sessions.length > 0) {
    const { data, error } = await opencodeV2.session.get({
      sessionID: attached.id,
    });
    if (!error && data?.data && !data.data.parentID) {
      const session = data.data;
      sessions.splice(limit - 1, 1, {
        id: session.id,
        title: session.title,
        directory: session.location.directory,
        time: session.time,
      });
    }
  }
  sessions.sort((a, b) => b.time.updated - a.time.updated);
  const byDirectory = new Map<string, RecentSessionInfo[]>();
  for (const session of sessions) {
    const group = byDirectory.get(session.directory) ?? [];
    group.push(session);
    byDirectory.set(session.directory, group);
  }

  const statuses = new Map<string, RecentStatus>();
  await Promise.all(
    [...byDirectory].map(async ([directory, group]) => {
      const normalizedDirectory = normalizeDirectory(directory);
      const [{ data: statusResult, error: statusError }, { data: formResult }, { data: permissionResult }] =
        await Promise.all([
          getBusySessionStatuses(),
          directApi<{ data: V2FormInfo[] }>(
            "GET",
            `/api/form?location[directory]=${encodeURIComponent(normalizedDirectory)}`,
          ),
          directApi<{ data: V2PermissionRequest[] }>(
            "GET",
            `/api/permission/request?location[directory]=${encodeURIComponent(normalizedDirectory)}`,
          ),
        ]);
      if (statusError || !statusResult) {
        throw statusError || new Error("No status received");
      }

      const roots = new Set(group.map((session) => session.id));
      const questions = new Set(formResult?.data.map((form) => form.sessionID) ?? []);
      const permissions = new Set<string>();
      for (const request of permissionResult?.data ?? []) {
        const chain = await resolveSessionParentChain(request.sessionID, directory, roots);
        if (chain) permissions.add(chain.root);
      }
      for (const session of group) {
        const run = statusResult[session.id]?.type;
        statuses.set(
          session.id,
          questions.has(session.id)
            ? "question"
            : permissions.has(session.id)
              ? "permission"
              : run === "busy" || run === "retry"
                ? "running"
                : "idle",
        );
      }
    }),
  );
  return sessions.map((session) => ({ session, status: statuses.get(session.id) ?? "idle" }));
}
