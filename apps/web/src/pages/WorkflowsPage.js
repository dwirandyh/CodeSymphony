import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
function emptyEditor() {
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
    const [workflows, setWorkflows] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [runLoadingId, setRunLoadingId] = useState(null);
    const [editor, setEditor] = useState(emptyEditor());
    const selectedWorkflow = useMemo(() => (editor.id ? workflows.find((workflow) => workflow.id === editor.id) ?? null : null), [editor.id, workflows]);
    async function load() {
        setLoading(true);
        setError(null);
        try {
            const data = await api.listWorkflows();
            setWorkflows(data);
        }
        catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load workflows");
        }
        finally {
            setLoading(false);
        }
    }
    useEffect(() => {
        void load();
    }, []);
    function setFromWorkflow(workflow) {
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
    function removeStep(index) {
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
        const normalized = {
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
            }
            else {
                await api.createWorkflow(normalized);
            }
            setEditor(emptyEditor());
            await load();
        }
        catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : "Failed to save workflow");
        }
    }
    async function startRun(workflowId) {
        setRunLoadingId(workflowId);
        setError(null);
        try {
            const run = await api.createRun({ workflowId });
            navigate(`/runs/${run.id}`);
        }
        catch (runError) {
            setError(runError instanceof Error ? runError.message : "Failed to start run");
        }
        finally {
            setRunLoadingId(null);
        }
    }
    return (_jsxs("div", { className: "container stack", children: [_jsx("h1", { children: "CodeSymphony Workflows" }), _jsx("div", { className: "row", children: _jsx(Link, { to: "/", children: "Workflows" }) }), error ? _jsxs("div", { className: "card", children: ["Error: ", error] }) : null, _jsxs("div", { className: "grid", children: [_jsxs("section", { className: "card stack", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h2", { style: { margin: 0 }, children: "Saved Workflows" }), _jsx("button", { type: "button", onClick: () => setEditor(emptyEditor()), style: { background: "#334155" }, children: "New" })] }), loading ? _jsx("div", { children: "Loading workflows..." }) : null, _jsx("ul", { className: "clean", children: workflows.map((workflow) => (_jsx("li", { className: "card", children: _jsxs("div", { className: "stack", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("strong", { children: workflow.name }), _jsxs("span", { className: "badge", children: [workflow.steps.length, " steps"] })] }), _jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("button", { type: "button", onClick: () => setFromWorkflow(workflow), children: "Edit" }), _jsx("button", { type: "button", onClick: () => void startRun(workflow.id), disabled: runLoadingId === workflow.id, style: { background: "#16a34a" }, children: runLoadingId === workflow.id ? "Starting..." : "Run" })] })] }) }, workflow.id))) })] }), _jsxs("section", { className: "card stack", children: [_jsx("h2", { style: { margin: 0 }, children: selectedWorkflow ? "Edit Workflow" : "Create Workflow" }), _jsxs("label", { className: "stack", children: [_jsx("span", { children: "Name" }), _jsx("input", { value: editor.name, onChange: (event) => setEditor((current) => ({
                                            ...current,
                                            name: event.target.value,
                                        })), placeholder: "Workflow name" })] }), _jsxs("div", { className: "stack", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h3", { style: { margin: 0 }, children: "Steps" }), _jsx("button", { type: "button", onClick: addStep, style: { background: "#334155" }, children: "Add Step" })] }), editor.steps.map((step, index) => (_jsxs("div", { className: "card stack", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsxs("strong", { children: ["Step ", index + 1] }), editor.steps.length > 1 ? (_jsx("button", { type: "button", onClick: () => removeStep(index), style: { background: "#b91c1c" }, children: "Remove" })) : null] }), _jsxs("label", { className: "stack", children: [_jsx("span", { children: "Title" }), _jsx("input", { value: step.title, onChange: (event) => setEditor((current) => ({
                                                            ...current,
                                                            steps: current.steps.map((currentStep, stepIndex) => stepIndex === index
                                                                ? {
                                                                    ...currentStep,
                                                                    title: event.target.value,
                                                                }
                                                                : currentStep),
                                                        })), placeholder: "Step title" })] }), _jsxs("label", { className: "stack", children: [_jsx("span", { children: "Kind" }), _jsxs("select", { value: step.kind, onChange: (event) => setEditor((current) => ({
                                                            ...current,
                                                            steps: current.steps.map((currentStep, stepIndex) => stepIndex === index
                                                                ? {
                                                                    ...currentStep,
                                                                    kind: event.target.value,
                                                                }
                                                                : currentStep),
                                                        })), children: [_jsx("option", { value: "prompt", children: "Prompt" }), _jsx("option", { value: "approval", children: "Approval checkpoint" })] })] }), step.kind === "prompt" ? (_jsxs("label", { className: "stack", children: [_jsx("span", { children: "Prompt" }), _jsx("textarea", { value: step.prompt ?? "", onChange: (event) => setEditor((current) => ({
                                                            ...current,
                                                            steps: current.steps.map((currentStep, stepIndex) => stepIndex === index
                                                                ? {
                                                                    ...currentStep,
                                                                    prompt: event.target.value,
                                                                }
                                                                : currentStep),
                                                        })), rows: 4, placeholder: "What should Claude do for this step?" })] })) : null] }, `${index}-${step.order}`)))] }), _jsx("button", { type: "button", onClick: () => void saveWorkflow(), children: selectedWorkflow ? "Update Workflow" : "Create Workflow" })] })] })] }));
}
