import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Run, RunEvent } from "@codesymphony/shared-types";
import { api } from "../lib/api";

function runStatusLabel(run: Run | null): string {
  if (!run) {
    return "loading";
  }

  return run.status;
}

export function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
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
    } catch (loadError) {
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
    } catch (loadError) {
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

      setError((current) =>
        current === "Lost connection to event stream" ? null : current,
      );
    };

    const listener = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as RunEvent;
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
    ] as const;

    for (const eventType of eventTypes) {
      stream.addEventListener(eventType, listener as EventListener);
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

  async function decide(decision: "approved" | "rejected") {
    if (!runId) {
      return;
    }

    setApprovalLoading(true);
    setError(null);

    try {
      await api.decideApproval(runId, { decision });
      await loadRun();
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "Failed to send approval decision");
    } finally {
      setApprovalLoading(false);
    }
  }

  return (
    <div className="container stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ margin: 0 }}>Run Detail</h1>
        <Link to="/">Back to workflows</Link>
      </div>

      {error ? <div className="card">Error: {error}</div> : null}

      <section className="card stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>Run ID</strong>
          <span>{runId}</span>
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>Status</strong>
          <span className="badge">{runStatusLabel(run)}</span>
        </div>
        {run?.error ? (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Error</strong>
            <span>{run.error}</span>
          </div>
        ) : null}
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Steps</h2>
        <ul className="clean">
          {run?.steps.map((step) => (
            <li key={step.id} className="card stack">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>
                  {step.order + 1}. {step.title}
                </strong>
                <span className="badge">{step.status}</span>
              </div>
              <div>Kind: {step.kind}</div>
              {step.output ? <div>Output: {step.output}</div> : null}
              {step.error ? <div>Error: {step.error}</div> : null}
            </li>
          ))}
        </ul>
      </section>

      {waitingApprovalStep ? (
        <section className="card stack">
          <h2 style={{ margin: 0 }}>Approval Required</h2>
          <div>
            Waiting on step <strong>{waitingApprovalStep.title}</strong>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() => void decide("approved")}
              disabled={approvalLoading}
              style={{ background: "#16a34a" }}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => void decide("rejected")}
              disabled={approvalLoading}
              style={{ background: "#b91c1c" }}
            >
              Reject
            </button>
          </div>
        </section>
      ) : null}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Live Logs</h2>
        <div className="log">
          {events.length === 0
            ? "No events yet"
            : events
                .map((event) => `[${event.idx}] ${event.type} ${JSON.stringify(event.payload)}`)
                .join("\n")}
        </div>
      </section>
    </div>
  );
}
