import { useState } from "react";
import { ChevronLeft, ChevronRight, MessageCircleQuestion } from "lucide-react";
import { Button } from "../ui/button";

type QuestionOption = {
  label: string;
  description?: string;
};

type QuestionItem = {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
};

type QuestionCardProps = {
  requestId: string;
  questions: QuestionItem[];
  busy: boolean;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
};

export function QuestionCard({ requestId, questions, busy, onAnswer }: QuestionCardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedByQuestion, setSelectedByQuestion] = useState<Map<string, Set<string>>>(new Map());
  const [freeTextByQuestion, setFreeTextByQuestion] = useState<Map<string, string>>(new Map());

  const total = questions.length;
  const question = questions[currentStep];
  if (!question) {
    return null;
  }

  const hasOptions = question.options && question.options.length > 0;
  const selected = selectedByQuestion.get(question.question) ?? new Set<string>();

  function toggleOption(questionText: string, label: string, multiSelect: boolean) {
    setSelectedByQuestion((current) => {
      const next = new Map(current);
      const existing = next.get(questionText) ?? new Set<string>();
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

      next.set(questionText, updated);
      return next;
    });

    if (!multiSelect && !isLastStep) {
      setTimeout(() => setCurrentStep((s) => s + 1), 200);
    }
  }

  function setFreeText(questionText: string, value: string) {
    setFreeTextByQuestion((current) => {
      const next = new Map(current);
      next.set(questionText, value);
      return next;
    });
  }

  function buildAnswers(): Record<string, string> {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const qHasOptions = q.options && q.options.length > 0;
      if (qHasOptions) {
        const sel = selectedByQuestion.get(q.question);
        answers[q.question] = sel ? Array.from(sel).join(", ") : "";
      } else {
        answers[q.question] = freeTextByQuestion.get(q.question) ?? "";
      }
    }
    return answers;
  }

  function isCurrentStepAnswered(): boolean {
    if (hasOptions) {
      return selected.size > 0;
    }
    const text = freeTextByQuestion.get(question.question) ?? "";
    return text.trim().length > 0;
  }

  const allAnswered = questions.every((q) => {
    const qHasOptions = q.options && q.options.length > 0;
    if (qHasOptions) {
      const sel = selectedByQuestion.get(q.question);
      return sel && sel.size > 0;
    }
    const text = freeTextByQuestion.get(q.question) ?? "";
    return text.trim().length > 0;
  });

  const isLastStep = currentStep === total - 1;
  const canGoNext = isCurrentStepAnswered() && !isLastStep;
  const canSubmit = isLastStep && allAnswered;

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
                    onClick={() => toggleOption(question.question, option.label, isMulti)}
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
            value={freeTextByQuestion.get(question.question) ?? ""}
            onChange={(event) => setFreeText(question.question, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !busy) {
                event.preventDefault();
                if (isLastStep && allAnswered) {
                  onAnswer(requestId, buildAnswers());
                } else if (canGoNext) {
                  handleNext();
                }
              }
            }}
            placeholder="Type your answer..."
            className="mt-2 w-full rounded-md border border-border/35 bg-background/35 px-3 py-2 text-left text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
          />
        )}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {total > 1 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={currentStep === 0}
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
              disabled={!canGoNext}
              className="h-7 w-7 p-0"
              onClick={handleNext}
              aria-label="Next question"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>

        <Button
          type="button"
          size="sm"
          disabled={busy || !canSubmit}
          className="h-8 rounded-md px-4 text-xs"
          onClick={() => onAnswer(requestId, buildAnswers())}
          aria-label={`Submit answer ${requestId}`}
        >
          {busy ? "Sending..." : "Submit Answer"}
        </Button>
      </div>
    </section>
  );
}
