import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
function runStatusLabel(run) {
    if (!run) {
        return "loading";
    }
    return run.status;
}
export function RunDetailPage() {
    const { runId } = useParams();
    const [run, setRun] = useState(null);
    const [events, setEvents] = useState([]);
    const [error, setError] = useState(null);
    const [approvalLoading, setApprovalLoading] = useState(false);
    const waitingApprovalStep = useMemo(() => {
        if (!run || run.status !== "waiting_approval") {
            return null;
        }
        return run.steps[run.currentStepIndex] ?? null;
    }, [run]);
    async function loadRun() {
        if (!runId) {
            return;
        }
        try {
            const data = await api.getRun(runId);
            setRun(data);
        }
        catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load run");
        }
    }
    async function loadEvents() {
        if (!runId) {
            return;
        }
        try {
            const data = await api.listRunEvents(runId);
            setEvents(data);
        }
        catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load run events");
        }
    }
    useEffect(() => {
        void loadRun();
        void loadEvents();
    }, [runId]);
    useEffect(() => {
        if (!runId) {
            return;
        }
        let disposed = false;
        const stream = new EventSource(`${api.runtimeBaseUrl}/api/runs/${runId}/events/stream`);
        stream.onmessage = () => {
            // noop: event-specific listeners are used below
        };
        stream.onopen = () => {
            if (disposed) {
                return;
            }
            setError((current) => current === "Lost connection to event stream" ? null : current);
        };
        const listener = (event) => {
            const payload = JSON.parse(event.data);
            setEvents((current) => {
                const alreadyExists = current.some((existing) => existing.id === payload.id);
                if (alreadyExists) {
                    return current;
                }
                return [...current, payload].sort((a, b) => a.idx - b.idx);
            });
            void loadRun();
        };
        const eventTypes = [
            "run.status_changed",
            "run.completed",
            "run.failed",
            "step.started",
            "step.log",
            "step.completed",
            "approval.requested",
            "approval.decided",
        ];
        for (const eventType of eventTypes) {
            stream.addEventListener(eventType, listener);
        }
        stream.onerror = () => {
            if (disposed) {
                return;
            }
            if (stream.readyState === EventSource.CLOSED) {
                setError("Lost connection to event stream");
            }
        };
        return () => {
            disposed = true;
            stream.close();
        };
    }, [runId]);
    async function decide(decision) {
        if (!runId) {
            return;
        }
        setApprovalLoading(true);
        setError(null);
        try {
            await api.decideApproval(runId, { decision });
            await loadRun();
        }
        catch (decideError) {
            setError(decideError instanceof Error ? decideError.message : "Failed to send approval decision");
        }
        finally {
            setApprovalLoading(false);
        }
    }
    return (_jsxs("div", { className: "container stack", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { style: { margin: 0 }, children: "Run Detail" }), _jsx(Link, { to: "/", children: "Back to workflows" })] }), error ? _jsxs("div", { className: "card", children: ["Error: ", error] }) : null, _jsxs("section", { className: "card stack", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("strong", { children: "Run ID" }), _jsx("span", { children: runId })] }), _jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("strong", { children: "Status" }), _jsx("span", { className: "badge", children: runStatusLabel(run) })] }), run?.error ? (_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("strong", { children: "Error" }), _jsx("span", { children: run.error })] })) : null] }), _jsxs("section", { className: "card stack", children: [_jsx("h2", { style: { margin: 0 }, children: "Steps" }), _jsx("ul", { className: "clean", children: run?.steps.map((step) => (_jsxs("li", { className: "card stack", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsxs("strong", { children: [step.order + 1, ". ", step.title] }), _jsx("span", { className: "badge", children: step.status })] }), _jsxs("div", { children: ["Kind: ", step.kind] }), step.output ? _jsxs("div", { children: ["Output: ", step.output] }) : null, step.error ? _jsxs("div", { children: ["Error: ", step.error] }) : null] }, step.id))) })] }), waitingApprovalStep ? (_jsxs("section", { className: "card stack", children: [_jsx("h2", { style: { margin: 0 }, children: "Approval Required" }), _jsxs("div", { children: ["Waiting on step ", _jsx("strong", { children: waitingApprovalStep.title })] }), _jsxs("div", { className: "row", children: [_jsx("button", { type: "button", onClick: () => void decide("approved"), disabled: approvalLoading, style: { background: "#16a34a" }, children: "Approve" }), _jsx("button", { type: "button", onClick: () => void decide("rejected"), disabled: approvalLoading, style: { background: "#b91c1c" }, children: "Reject" })] })] })) : null, _jsxs("section", { className: "card stack", children: [_jsx("h2", { style: { margin: 0 }, children: "Live Logs" }), _jsx("div", { className: "log", children: events.length === 0
                            ? "No events yet"
                            : events
                                .map((event) => `[${event.idx}] ${event.type} ${JSON.stringify(event.payload)}`)
                                .join("\n") })] })] }));
}
