import { describe, expect, it } from "vitest";
import { createInitialState, InvalidTransitionError, transition } from "../src/runStateMachine";

describe("runStateMachine", () => {
  it("transitions queued -> running on start", () => {
    const state = createInitialState(2);
    const next = transition(state, { type: "START" });

    expect(next.status).toBe("running");
    expect(next.currentStepIndex).toBe(0);
  });

  it("advances to next step after success", () => {
    const initial = transition(createInitialState(2), { type: "START" });
    const next = transition(initial, { type: "STEP_SUCCEEDED" });

    expect(next.status).toBe("running");
    expect(next.currentStepIndex).toBe(1);
  });

  it("marks run succeeded on last step success", () => {
    const started = transition(createInitialState(1), { type: "START" });
    const done = transition(started, { type: "STEP_SUCCEEDED" });

    expect(done.status).toBe("succeeded");
    expect(done.currentStepIndex).toBe(0);
  });

  it("moves to waiting approval then continues when approved", () => {
    const started = transition(createInitialState(2), { type: "START" });
    const waiting = transition(started, { type: "AWAIT_APPROVAL" });
    const resumed = transition(waiting, { type: "APPROVAL_DECIDED", decision: "approved" });

    expect(waiting.status).toBe("waiting_approval");
    expect(resumed.status).toBe("running");
    expect(resumed.currentStepIndex).toBe(1);
  });

  it("fails run when approval rejected", () => {
    const started = transition(createInitialState(2), { type: "START" });
    const waiting = transition(started, { type: "AWAIT_APPROVAL" });
    const rejected = transition(waiting, { type: "APPROVAL_DECIDED", decision: "rejected" });

    expect(rejected.status).toBe("failed");
  });

  it("throws on invalid transition", () => {
    const state = createInitialState(2);

    expect(() => transition(state, { type: "STEP_SUCCEEDED" })).toThrow(InvalidTransitionError);
  });
});
