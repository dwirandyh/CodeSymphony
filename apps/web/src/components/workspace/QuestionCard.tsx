import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, MessageCircleQuestion } from "lucide-react";
import { Button } from "../ui/button";

type QuestionOption = {
  label: string;
  description?: string;
  preview?: string;
};

type QuestionItem = {
  id?: string;
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
};

type QuestionAnnotation = {
  preview?: string;
  notes?: string;
};

type QuestionCardProps = {
  requestId: string;
  questions: QuestionItem[];
  busy: boolean;
  onAnswer: (requestId: string, answers: Record<string, string>, annotations?: Record<string, QuestionAnnotation>) => void;
  onDismiss: (requestId: string) => void;
};

export function QuestionCard({ requestId, questions, busy, onAnswer, onDismiss }: QuestionCardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedByQuestion, setSelectedByQuestion] = useState<Map<string, Set<string>>>(() => new Map());
  const [freeTextByQuestion, setFreeTextByQuestion] = useState<Map<string, string>>(() => new Map());
  const [notesByQuestion, setNotesByQuestion] = useState<Map<string, string>>(() => new Map());

  const total = questions.length;
  const question = questions[currentStep];
  const questionKey = question?.id ?? `q-${currentStep}`;
  const selected = selectedByQuestion.get(questionKey) ?? new Set<string>();
  const freeText = freeTextByQuestion.get(questionKey) ?? "";
  const noteText = notesByQuestion.get(questionKey) ?? "";

  const selectedPreview = useMemo(() => {
    if (!question?.options?.length || selected.size === 0) {
      return null;
    }

    const previews = question.options
      .filter((option) => selected.has(option.label) && typeof option.preview === "string" && option.preview.trim().length > 0)
      .map((option) => option.preview!.trim());

    return previews.length > 0 ? previews.join("\n\n") : null;
  }, [question, selected]);

  if (!question) {
    return null;
  }

  const hasOptions = question.options && question.options.length > 0;

  function toggleOption(questionId: string, label: string, multiSelect: boolean) {
    setSelectedByQuestion((current) => {
      const next = new Map(current);
      const existing = next.get(questionId) ?? new Set<string>();
      const updated = new Set(existing);

      if (multiSelect) {
        if (updated.has(label)) {
          updated.delete(label);
        } else {
          updated.add(label);
        }
      } else {
        updated.clear();
        updated.add(label);
      }

      next.set(questionId, updated);
      return next;
    });
  }

  function setFreeText(questionId: string, value: string) {
    setFreeTextByQuestion((current) => {
      const next = new Map(current);
      next.set(questionId, value);
      return next;
    });
  }

  function setNoteText(questionId: string, value: string) {
    setNotesByQuestion((current) => {
      const next = new Map(current);
      next.set(questionId, value);
      return next;
    });
  }

  function buildAnswers(): Record<string, string> {
    const answers: Record<string, string> = {};
    questions.forEach((q, index) => {
      const key = q.id ?? `q-${index}`;
      const qHasOptions = q.options && q.options.length > 0;
      if (qHasOptions) {
        const selections = selectedByQuestion.get(key);
        const note = notesByQuestion.get(key)?.trim() ?? "";
        answers[q.question] = selections && selections.size > 0
          ? Array.from(selections).join(", ")
          : note;
      } else {
        answers[q.question] = freeTextByQuestion.get(key) ?? "";
      }
    });
    return answers;
  }

  function buildAnnotations(): Record<string, QuestionAnnotation> | undefined {
    const annotations = new Map<string, QuestionAnnotation>();

    questions.forEach((q, index) => {
      const key = q.id ?? `q-${index}`;
      const notes = notesByQuestion.get(key)?.trim();
      if (!notes) {
        return;
      }

      annotations.set(q.question, { notes });
    });

    return annotations.size > 0 ? Object.fromEntries(annotations) : undefined;
  }

  function isQuestionAnswered(q: QuestionItem, index: number): boolean {
    const key = q.id ?? `q-${index}`;
    if (q.options && q.options.length > 0) {
      const selections = selectedByQuestion.get(key);
      const notes = notesByQuestion.get(key) ?? "";
      return (selections?.size ?? 0) > 0 || notes.trim().length > 0;
    }

    const text = freeTextByQuestion.get(key) ?? "";
    return text.trim().length > 0;
  }

  const isLastStep = currentStep === total - 1;
  const canGoNext = isQuestionAnswered(question, currentStep) && !isLastStep;
  const canSubmit = isLastStep && questions.every((q, index) => isQuestionAnswered(q, index));

  function handleNext() {
    if (canGoNext) {
      setCurrentStep((s) => s + 1);
    }
  }

  function handlePrev() {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1);
    }
  }

  return (
    <section
      className="rounded-lg border border-blue-500/30 bg-background/20 px-3 py-3 backdrop-blur-sm"
      data-testid={`question-card-${requestId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <MessageCircleQuestion className="h-4 w-4 shrink-0 text-blue-400" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-400">Claude is asking</p>
        </div>
        {total > 1 ? (
          <span className="shrink-0 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[10px] tabular-nums tracking-wide text-blue-400">
            {currentStep + 1} / {total}
          </span>
        ) : (
          <span className="shrink-0 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-blue-400">
            Awaiting Answer
          </span>
        )}
      </div>

      <div className="mt-3">
        {question.header ? (
          <p className="mb-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {question.header}
          </p>
        ) : null}
        <p className="text-left text-sm text-foreground/90">{question.question}</p>

        {hasOptions ? (
          <div className="mt-2">
            <p className="mb-1.5 text-[10px] text-muted-foreground/60">
              {question.multiSelect ? "Select one or more" : "Select one"}
            </p>
            <div className="flex flex-col gap-1.5">
              {question.options!.map((option) => {
                const isSelected = selected.has(option.label);
                const isMulti = question.multiSelect ?? false;
                return (
                  <button
                    key={option.label}
                    type="button"
                    disabled={busy}
                    onClick={() => toggleOption(questionKey, option.label, isMulti)}
                    className={`flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                      isSelected
                        ? "border-blue-500/50 bg-blue-500/15 text-blue-300"
                        : "border-border/35 bg-background/35 text-muted-foreground hover:border-border/60 hover:text-foreground"
                    }`}
                  >
                    {isMulti ? (
                      <span
                        className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
                          isSelected
                            ? "border-blue-400 bg-blue-500/30"
                            : "border-muted-foreground/40 bg-transparent"
                        }`}
                      >
                        {isSelected ? (
                          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="text-blue-300">
                            <path d="M1.5 4L3.2 5.8L6.5 2.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : null}
                      </span>
                    ) : (
                      <span
                        className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                          isSelected
                            ? "border-blue-400 bg-blue-500/30"
                            : "border-muted-foreground/40 bg-transparent"
                        }`}
                      >
                        {isSelected ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-blue-300" />
                        ) : null}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{option.label}</span>
                      {option.description ? (
                        <span className="mt-0.5 block text-[11px] text-muted-foreground/70">{option.description}</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <input
            type="text"
            disabled={busy}
            value={freeText}
            onChange={(event) => setFreeText(questionKey, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !busy) {
                event.preventDefault();
                if (canSubmit) {
                  onAnswer(requestId, buildAnswers(), buildAnnotations());
                } else if (canGoNext) {
                  handleNext();
                }
              }
            }}
            placeholder="Type your answer..."
            className="mt-2 w-full rounded-md border border-border/35 bg-background/35 px-3 py-2 text-left text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
          />
        )}

        {hasOptions ? (
          <div className="mt-2 space-y-2">
            {selectedPreview ? (
              <pre className="overflow-x-auto rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-[11px] leading-relaxed text-blue-100 whitespace-pre-wrap">
                {selectedPreview}
              </pre>
            ) : null}
            <div>
              <p className="mb-1.5 text-[10px] text-muted-foreground/60">Optional note</p>
              <textarea
                disabled={busy}
                value={noteText}
                onChange={(event) => setNoteText(questionKey, event.target.value)}
                placeholder={selected.size > 0 ? "Add context for your selection..." : "Or provide another answer..."}
                rows={selectedPreview ? 4 : 3}
                className="w-full rounded-md border border-border/35 bg-background/35 px-3 py-2 text-left text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {total > 1 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={currentStep === 0 || busy}
              className="h-7 w-7 p-0"
              onClick={handlePrev}
              aria-label="Previous question"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {total > 1 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!canGoNext || busy}
              className="h-7 w-7 p-0"
              onClick={handleNext}
              aria-label="Next question"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onDismiss(requestId)}
            aria-label={`Dismiss question ${requestId}`}
          >
            Dismiss
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !canSubmit}
            className="h-8 rounded-md px-4 text-xs"
            onClick={() => onAnswer(requestId, buildAnswers(), buildAnnotations())}
            aria-label={`Submit answer ${requestId}`}
          >
            {busy ? "Sending..." : "Submit Answer"}
          </Button>
        </div>
      </div>
    </section>
  );
}
