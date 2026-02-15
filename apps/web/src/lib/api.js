const API_BASE = import.meta.env.VITE_RUNTIME_URL ?? "http://127.0.0.1:4321/api";
async function request(path, init) {
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
    return payload.data;
}
export const api = {
    listWorkflows: () => request("/workflows"),
    getWorkflow: (id) => request(`/workflows/${id}`),
    createWorkflow: (input) => request("/workflows", {
        method: "POST",
        body: JSON.stringify(input),
    }),
    updateWorkflow: (id, input) => request(`/workflows/${id}`, {
        method: "PUT",
        body: JSON.stringify(input),
    }),
    createRun: (input) => request("/runs", {
        method: "POST",
        body: JSON.stringify(input),
    }),
    getRun: (runId) => request(`/runs/${runId}`),
    listRunEvents: (runId) => request(`/runs/${runId}/events`),
    decideApproval: (runId, input) => request(`/runs/${runId}/approval`, {
        method: "POST",
        body: JSON.stringify(input),
    }),
    runtimeBaseUrl: API_BASE.replace(/\/api$/, ""),
};
