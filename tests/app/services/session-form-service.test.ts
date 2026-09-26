import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelSessionForm,
  getSessionForm,
  mapFormFieldsToQuestions,
  replyToSessionForm,
} from "../../../src/app/services/session-form-service.js";

const mocked = vi.hoisted(() => ({
  directApiMock: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  directApi: mocked.directApiMock,
}));

function createForm(overrides: Record<string, unknown> = {}) {
  return {
    id: "frm_1",
    sessionID: "ses-1",
    title: "Pick one",
    fields: [
      { key: "mode", type: "string", title: "Mode", description: "How to run", options: [] },
    ],
    ...overrides,
  };
}

describe("app/services/session-form-service", () => {
  beforeEach(() => {
    mocked.directApiMock.mockReset();
  });

  it("reads the pending form of a session", async () => {
    mocked.directApiMock.mockResolvedValueOnce({ data: { data: [createForm()] }, error: null });

    const form = await getSessionForm("ses-1");

    expect(mocked.directApiMock).toHaveBeenCalledWith("GET", "/api/session/ses-1/form");
    expect(form.data?.id).toBe("frm_1");
    expect(form.error).toBeNull();
  });

  it("reports no form when the session has none pending", async () => {
    mocked.directApiMock.mockResolvedValueOnce({ data: { data: [] }, error: null });

    const form = await getSessionForm("ses-1");

    expect(form.data).toBeNull();
    expect(form.error).toBeNull();
  });

  it("surfaces a failed form lookup", async () => {
    const error = new Error("HTTP 404 for GET");
    mocked.directApiMock.mockResolvedValueOnce({ data: null, error });

    const form = await getSessionForm("ses-1");

    expect(form.data).toBeNull();
    expect(form.error).toBe(error);
  });

  it("maps form fields onto poll questions", () => {
    const questions = mapFormFieldsToQuestions(
      createForm({
        fields: [
          {
            key: "mode",
            type: "string",
            title: "Mode",
            description: "How to run",
            options: [{ value: "build", label: "Build", description: "compile" }],
          },
          {
            key: "targets",
            type: "multiselect",
            title: "Targets",
            options: [{ value: "web", label: "Web" }, { value: "api", label: "Api" }],
          },
          { key: "note", type: "string" },
        ],
      }),
    );

    expect(questions).toEqual([
      {
        header: "Mode",
        question: "How to run",
        options: [{ label: "Build", description: "compile" }],
      },
      {
        header: "Targets",
        question: "Targets",
        options: [
          { label: "Web", description: "" },
          { label: "Api", description: "" },
        ],
        multiple: true,
      },
      {
        header: "note",
        question: "note",
        options: [],
      },
    ]);
  });

  it("replies with the answer keyed by field key", async () => {
    mocked.directApiMock.mockResolvedValueOnce({ data: null, error: null });

    const { error } = await replyToSessionForm("ses-1", "frm_1", { mode: "build" });

    expect(error).toBeNull();
    expect(mocked.directApiMock).toHaveBeenCalledWith(
      "POST",
      "/api/session/ses-1/form/frm_1/reply",
      { answer: { mode: "build" } },
    );
  });

  it("cancels a pending form", async () => {
    mocked.directApiMock.mockResolvedValueOnce({ data: null, error: null });

    const { error } = await cancelSessionForm("ses-1", "frm_1");

    expect(error).toBeNull();
    expect(mocked.directApiMock).toHaveBeenCalledWith(
      "DELETE",
      "/api/session/ses-1/form/frm_1",
    );
  });
});
