import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRecentSessions } from "../../../src/app/services/recent-sessions-service.js";

const mocked = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getBusySessionStatuses: vi.fn(),
  sessionGet: vi.fn(),
  directApi: vi.fn(),
  attached: null as { id: string; directory: string } | null,
}));

vi.mock("../../../src/opencode/client.js", () => ({
  listSessions: mocked.listSessions,
  getBusySessionStatuses: mocked.getBusySessionStatuses,
  opencodeV2: { session: { get: mocked.sessionGet } },
  directApi: mocked.directApi,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({ getCurrentSession: () => mocked.attached }));

const session = (id: string, directory: string, updated: number) => ({
  id,
  directory,
  title: id,
  time: { created: updated, updated },
});

const rawSession = (id: string, directory: string, updated: number) => ({
  id,
  location: { directory },
  title: id,
  time: { created: updated, updated },
});

describe("cross-project recent session snapshot", () => {
  beforeEach(() => {
    mocked.attached = null;
    mocked.listSessions.mockReset();
    mocked.getBusySessionStatuses.mockReset();
    mocked.sessionGet.mockReset();
    mocked.directApi.mockReset();
    mocked.directApi.mockResolvedValue({ data: { data: [] }, error: null });
    mocked.getBusySessionStatuses.mockResolvedValue({ data: {}, error: null });
  });

  const directoryFromPath = (path: string): string => {
    const match = path.match(/location\[directory\]=([^&]*)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  };

  it("queries global root sessions and snapshots each directory with status precedence", async () => {
    mocked.listSessions.mockResolvedValue({
      data: [session("a", "/one", 4), session("b", "/two", 3), session("c", "/one", 2)],
      error: null,
    });
    mocked.getBusySessionStatuses.mockResolvedValue({
      data: { a: { type: "busy" }, c: { type: "retry" }, b: { type: "idle" } },
      error: null,
    });
    mocked.directApi.mockImplementation(async (_method: string, path: string) => {
      const dir = directoryFromPath(path);
      if (path.startsWith("/api/form")) {
        return { data: { data: dir === "/one" ? [{ sessionID: "a" }] : [] }, error: null };
      }
      return { data: { data: dir === "/one" ? [{ sessionID: "a" }] : [{ sessionID: "b" }] }, error: null };
    });

    const rows = await loadRecentSessions(3);

    expect(mocked.listSessions).toHaveBeenCalledWith({ roots: true, limit: 3 });
    expect(mocked.getBusySessionStatuses).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => row.status)).toEqual(["question", "permission", "running"]);
  });

  it("attributes a detached child permission through its parent chain to a listed root", async () => {
    mocked.listSessions.mockResolvedValue({ data: [session("root", "/other", 3)], error: null });
    mocked.directApi.mockImplementation(async (_method: string, path: string) => {
      if (path.startsWith("/api/permission/request")) {
        return { data: { data: [{ sessionID: "grandchild" }] }, error: null };
      }
      return { data: { data: [] }, error: null };
    });
    mocked.sessionGet.mockImplementation(async ({ sessionID }: { sessionID: string }) => ({
      data: { data: { parentID: sessionID === "grandchild" ? "child" : "root" } },
      error: null,
    }));

    expect((await loadRecentSessions(10))[0]?.status).toBe("permission");
    expect(mocked.sessionGet).toHaveBeenCalledTimes(2);
  });

  it("retains an older attached root inside the limit", async () => {
    mocked.attached = { id: "old", directory: "/old" };
    mocked.listSessions.mockResolvedValue({ data: [session("new", "/new", 10), session("next", "/new", 9)], error: null });
    mocked.sessionGet.mockResolvedValue({ data: { data: { ...rawSession("old", "/old", 1), parentID: undefined } }, error: null });

    expect((await loadRecentSessions(2)).map(({ session }) => session.id)).toEqual(["new", "old"]);
  });

  it("shows idle and an empty list without a selected project", async () => {
    mocked.listSessions.mockResolvedValueOnce({ data: [session("idle", "/repo", 1)], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    expect((await loadRecentSessions(10))[0]?.status).toBe("idle");
    expect(await loadRecentSessions(10)).toEqual([]);
  });
});
