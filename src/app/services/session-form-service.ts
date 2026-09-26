import { directApi } from "../../opencode/client.js";
import type { Question } from "../types/question.js";

// OpenCode v2 dropped the v1 `session.question.*` surface and renamed it to
// forms: GET /api/session/{id}/form returns {data: Form.Info[]} with `fields`
// (not `questions`), answers go back as {answer: {<fieldKey>: value}}, and a
// pending form is dismissed with DELETE .../form/{formID}.

export interface SessionFormOption {
  value: string;
  label: string;
  description?: string;
}

// The six shapes 2.0.16 declares for Form.Field. A union keeps the mapping
// total: a new server-side type becomes a compile error, not a silent
// free-text question.
export type SessionFormFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "multiselect"
  | "external";

export interface SessionFormField {
  key: string;
  type: SessionFormFieldType;
  title?: string;
  description?: string;
  options?: SessionFormOption[];
}

export interface SessionFormInfo {
  id: string;
  sessionID: string;
  title: string;
  fields: SessionFormField[];
}

export type SessionFormValue = string | number | boolean | string[];

export async function getSessionForm(sessionId: string): Promise<{
  data: SessionFormInfo | null;
  error: Error | null;
}> {
  const { data, error } = await directApi<{ data: SessionFormInfo[] }>(
    "GET",
    `/api/session/${sessionId}/form`,
  );
  if (error) {
    return { data: null, error };
  }
  return { data: data?.data[0] ?? null, error: null };
}

export async function replyToSessionForm(
  sessionId: string,
  formId: string,
  answer: Record<string, SessionFormValue>,
): Promise<{ error: Error | null }> {
  const { error } = await directApi(
    "POST",
    `/api/session/${sessionId}/form/${formId}/reply`,
    { answer },
  );
  return { error };
}

export async function cancelSessionForm(
  sessionId: string,
  formId: string,
): Promise<{ error: Error | null }> {
  const { error } = await directApi("DELETE", `/api/session/${sessionId}/form/${formId}`);
  return { error };
}

// The poll renders {header, question, options, multiple}; a form field only
// carries options for the select-like types. Index order is preserved so the
// submitted answer can be keyed back by position.
export function mapFormFieldsToQuestions(form: SessionFormInfo): Question[] {
  return form.fields.map((field) => ({
    header: field.title ?? field.key,
    question: field.description ?? field.title ?? field.key,
    options: (field.options ?? []).map((option) => ({
      label: option.label,
      description: option.description ?? "",
    })),
    ...(field.type === "multiselect" ? { multiple: true } : {}),
  }));
}
