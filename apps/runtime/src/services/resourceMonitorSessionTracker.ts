import type { ResourceMonitorSessionKind } from "@codesymphony/shared-types";

export type TrackedResourceSession = {
  sessionId: string;
  worktreeId: string;
  pid: number;
  label: string;
  kind: ResourceMonitorSessionKind;
};

export type ResourceMonitorSessionTracker = {
  upsertSession: (session: TrackedResourceSession) => void;
  removeSession: (sessionId: string) => void;
  listSessions: () => TrackedResourceSession[];
};

function isValidTrackedSession(session: TrackedResourceSession): boolean {
  return (
    session.sessionId.trim().length > 0
    && session.worktreeId.trim().length > 0
    && session.label.trim().length > 0
    && Number.isInteger(session.pid)
    && session.pid > 0
  );
}

export function createResourceMonitorSessionTracker(): ResourceMonitorSessionTracker {
  const sessions = new Map<string, TrackedResourceSession>();

  return {
    upsertSession(session) {
      if (!isValidTrackedSession(session)) {
        return;
      }

      sessions.set(session.sessionId, {
        ...session,
        sessionId: session.sessionId.trim(),
        worktreeId: session.worktreeId.trim(),
        label: session.label.trim(),
      });
    },
    removeSession(sessionId) {
      sessions.delete(sessionId);
    },
    listSessions() {
      return [...sessions.values()];
    },
  };
}
