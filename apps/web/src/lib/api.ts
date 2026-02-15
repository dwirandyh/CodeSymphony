import type {
  ApproveRunInput,
  ApprovalCheckpoint,
  CreateRunInput,
  CreateWorkflowInput,
  Run,
  RunEvent,
  Workflow,
} from "@codesymphony/shared-types";

const API_BASE = import.meta.env.VITE_RUNTIME_URL ?? "http://127.0.0.1:4321/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
    },
    ...init,
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed");
  }

  return payload.data as T;
}

export const api = {
  listWorkflows: () => request<Workflow[]>("/workflows"),
  getWorkflow: (id: string) => request<Workflow>(`/workflows/${id}`),
  createWorkflow: (input: CreateWorkflowInput) =>
    request<Workflow>("/workflows", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateWorkflow: (id: string, input: CreateWorkflowInput) =>
    request<Workflow>(`/workflows/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  createRun: (input: CreateRunInput) =>
    request<Run>("/runs", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getRun: (runId: string) => request<Run>(`/runs/${runId}`),
  listRunEvents: (runId: string) => request<RunEvent[]>(`/runs/${runId}/events`),
  decideApproval: (runId: string, input: ApproveRunInput) =>
    request<ApprovalCheckpoint>(`/runs/${runId}/approval`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  runtimeBaseUrl: API_BASE.replace(/\/api$/, ""),
};
