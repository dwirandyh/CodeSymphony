import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { CreateWorkflowInput, Workflow, WorkflowStep } from "@codesymphony/shared-types";
import { api } from "../lib/api";

type EditorState = {
  id?: string;
  name: string;
  steps: Array<Pick<WorkflowStep, "order" | "title" | "kind" | "prompt">>;
};

function emptyEditor(): EditorState {
  return {
    name: "",
    steps: [
      {
        order: 0,
        title: "",
        kind: "prompt",
        prompt: "",
      },
    ],
  };
}

export function WorkflowsPage() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runLoadingId, setRunLoadingId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(emptyEditor());

  const selectedWorkflow = useMemo(
    () => (editor.id ? workflows.find((workflow) => workflow.id === editor.id) ?? null : null),
    [editor.id, workflows],
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listWorkflows();
      setWorkflows(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load workflows");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function setFromWorkflow(workflow: Workflow) {
    setEditor({
      id: workflow.id,
      name: workflow.name,
      steps: workflow.steps.map((step) => ({
        order: step.order,
        title: step.title,
        kind: step.kind,
        prompt: step.prompt,
      })),
    });
  }

  function addStep() {
    setEditor((current) => ({
      ...current,
      steps: [
        ...current.steps,
        {
          order: current.steps.length,
          title: "",
          kind: "prompt",
          prompt: "",
        },
      ],
    }));
  }

  function removeStep(index: number) {
    setEditor((current) => ({
      ...current,
      steps: current.steps
        .filter((_, stepIndex) => stepIndex !== index)
        .map((step, stepIndex) => ({
          ...step,
          order: stepIndex,
        })),
    }));
  }

  async function saveWorkflow() {
    setError(null);

    const normalized: CreateWorkflowInput = {
      name: editor.name,
      steps: editor.steps.map((step, index) => ({
        order: index,
        title: step.title,
        kind: step.kind,
        prompt: step.kind === "prompt" ? step.prompt : null,
      })),
    };

    try {
      if (editor.id) {
        await api.updateWorkflow(editor.id, normalized);
      } else {
        await api.createWorkflow(normalized);
      }

      setEditor(emptyEditor());
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save workflow");
    }
  }

  async function startRun(workflowId: string) {
    setRunLoadingId(workflowId);
    setError(null);

    try {
      const run = await api.createRun({ workflowId });
      navigate(`/runs/${run.id}`);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to start run");
    } finally {
      setRunLoadingId(null);
    }
  }

  return (
    <div className="container stack">
      <h1>CodeSymphony Workflows</h1>
      <div className="row">
        <Link to="/">Workflows</Link>
      </div>

      {error ? <div className="card">Error: {error}</div> : null}

      <div className="grid">
        <section className="card stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Saved Workflows</h2>
            <button
              type="button"
              onClick={() => setEditor(emptyEditor())}
              style={{ background: "#334155" }}
            >
              New
            </button>
          </div>

          {loading ? <div>Loading workflows...</div> : null}

          <ul className="clean">
            {workflows.map((workflow) => (
              <li key={workflow.id} className="card">
                <div className="stack">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>{workflow.name}</strong>
                    <span className="badge">{workflow.steps.length} steps</span>
                  </div>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <button type="button" onClick={() => setFromWorkflow(workflow)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void startRun(workflow.id)}
                      disabled={runLoadingId === workflow.id}
                      style={{ background: "#16a34a" }}
                    >
                      {runLoadingId === workflow.id ? "Starting..." : "Run"}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="card stack">
          <h2 style={{ margin: 0 }}>{selectedWorkflow ? "Edit Workflow" : "Create Workflow"}</h2>

          <label className="stack">
            <span>Name</span>
            <input
              value={editor.name}
              onChange={(event) =>
                setEditor((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder="Workflow name"
            />
          </label>

          <div className="stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>Steps</h3>
              <button type="button" onClick={addStep} style={{ background: "#334155" }}>
                Add Step
              </button>
            </div>

            {editor.steps.map((step, index) => (
              <div key={`${index}-${step.order}`} className="card stack">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>Step {index + 1}</strong>
                  {editor.steps.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => removeStep(index)}
                      style={{ background: "#b91c1c" }}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>

                <label className="stack">
                  <span>Title</span>
                  <input
                    value={step.title}
                    onChange={(event) =>
                      setEditor((current) => ({
                        ...current,
                        steps: current.steps.map((currentStep, stepIndex) =>
                          stepIndex === index
                            ? {
                                ...currentStep,
                                title: event.target.value,
                              }
                            : currentStep,
                        ),
                      }))
                    }
                    placeholder="Step title"
                  />
                </label>

                <label className="stack">
                  <span>Kind</span>
                  <select
                    value={step.kind}
                    onChange={(event) =>
                      setEditor((current) => ({
                        ...current,
                        steps: current.steps.map((currentStep, stepIndex) =>
                          stepIndex === index
                            ? {
                                ...currentStep,
                                kind: event.target.value as WorkflowStep["kind"],
                              }
                            : currentStep,
                        ),
                      }))
                    }
                  >
                    <option value="prompt">Prompt</option>
                    <option value="approval">Approval checkpoint</option>
                  </select>
                </label>

                {step.kind === "prompt" ? (
                  <label className="stack">
                    <span>Prompt</span>
                    <textarea
                      value={step.prompt ?? ""}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          steps: current.steps.map((currentStep, stepIndex) =>
                            stepIndex === index
                              ? {
                                  ...currentStep,
                                  prompt: event.target.value,
                                }
                              : currentStep,
                          ),
                        }))
                      }
                      rows={4}
                      placeholder="What should Claude do for this step?"
                    />
                  </label>
                ) : null}
              </div>
            ))}
          </div>

          <button type="button" onClick={() => void saveWorkflow()}>
            {selectedWorkflow ? "Update Workflow" : "Create Workflow"}
          </button>
        </section>
      </div>
    </div>
  );
}
