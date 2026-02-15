export type RunStatus = "queued" | "running" | "waiting_approval" | "succeeded" | "failed";
export type ApprovalDecision = "approved" | "rejected";

export type RunMachineState = {
  status: RunStatus;
  currentStepIndex: number;
  totalSteps: number;
};

export type RunMachineEvent =
  | { type: "START" }
  | { type: "STEP_SUCCEEDED" }
  | { type: "STEP_FAILED" }
  | { type: "AWAIT_APPROVAL" }
  | { type: "APPROVAL_DECIDED"; decision: ApprovalDecision };

export class InvalidTransitionError extends Error {
  constructor(state: RunMachineState, event: RunMachineEvent) {
    super(`Invalid transition from ${state.status} with ${event.type}`);
  }
}

function ensureValidState(state: RunMachineState) {
  const allowedStatuses: RunStatus[] = ["queued", "running", "waiting_approval", "succeeded", "failed"];

  if (!allowedStatuses.includes(state.status)) {
    throw new Error("Invalid run status");
  }

  if (state.totalSteps < 1) {
    throw new Error("Run must have at least one step");
  }

  if (state.currentStepIndex < 0 || state.currentStepIndex >= state.totalSteps) {
    throw new Error("Current step index is out of bounds");
  }
}

export function createInitialState(totalSteps: number): RunMachineState {
  if (totalSteps < 1) {
    throw new Error("Run must have at least one step");
  }

  return {
    status: "queued",
    currentStepIndex: 0,
    totalSteps,
  };
}

export function isTerminalStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed";
}

function completeOrAdvance(state: RunMachineState): RunMachineState {
  const isLastStep = state.currentStepIndex === state.totalSteps - 1;

  if (isLastStep) {
    return {
      ...state,
      status: "succeeded",
    };
  }

  return {
    ...state,
    status: "running",
    currentStepIndex: state.currentStepIndex + 1,
  };
}

export function transition(state: RunMachineState, event: RunMachineEvent): RunMachineState {
  ensureValidState(state);

  switch (event.type) {
    case "START": {
      if (state.status !== "queued") {
        throw new InvalidTransitionError(state, event);
      }

      return {
        ...state,
        status: "running",
      };
    }

    case "STEP_SUCCEEDED": {
      if (state.status !== "running") {
        throw new InvalidTransitionError(state, event);
      }

      return completeOrAdvance(state);
    }

    case "STEP_FAILED": {
      if (state.status !== "running") {
        throw new InvalidTransitionError(state, event);
      }

      return {
        ...state,
        status: "failed",
      };
    }

    case "AWAIT_APPROVAL": {
      if (state.status !== "running") {
        throw new InvalidTransitionError(state, event);
      }

      return {
        ...state,
        status: "waiting_approval",
      };
    }

    case "APPROVAL_DECIDED": {
      if (state.status !== "waiting_approval") {
        throw new InvalidTransitionError(state, event);
      }

      if (event.decision === "rejected") {
        return {
          ...state,
          status: "failed",
        };
      }

      return completeOrAdvance(state);
    }

    default: {
      const neverEvent: never = event;
      throw new Error(`Unhandled event ${(neverEvent as { type: string }).type}`);
    }
  }
}
