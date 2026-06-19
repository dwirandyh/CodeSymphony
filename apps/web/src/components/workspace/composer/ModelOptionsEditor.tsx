import { useMemo } from "react";
import { Check } from "lucide-react";
import {
  buildProviderOptionSelectionsFromDescriptors,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ModelCapabilities,
} from "@codesymphony/shared-types";
import { cn } from "../../../lib/utils";

type ModelOptionsEditorProps = {
  capabilities: ModelCapabilities;
  selections: ProviderOptionSelection[];
  onChange: (selections: ProviderOptionSelection[]) => void;
  className?: string;
};

function SelectOptionEditor({
  descriptor,
  value,
  onChange,
}: {
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-medium text-muted-foreground">
        {descriptor.label}
      </label>
      <div className="space-y-px">
        {descriptor.options.map((option) => {
          const isSelected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-foreground transition-colors -mx-2",
                isSelected
                  ? "bg-white/[0.06]"
                  : "hover:bg-white/[0.04]",
              )}
              onMouseDown={(event) => {
                event.stopPropagation();
                event.preventDefault();
              }}
              onClick={() => onChange(option.value)}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {isSelected ? <Check className="h-3 w-3 shrink-0" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ToggleOptionEditor({
  descriptor,
  value,
  onChange,
}: {
  descriptor: Extract<ProviderOptionDescriptor, { type: "toggle" }>;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <label className="text-[11px] font-medium text-muted-foreground">
        {descriptor.label}
      </label>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        className={cn(
          "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors",
          value ? "bg-accent" : "bg-secondary",
        )}
        onMouseDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
        }}
        onClick={() => onChange(!value)}
      >
        <span
          className={cn(
            "pointer-events-none inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform",
            value ? "translate-x-3.5" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}

export function ModelOptionsEditor({
  capabilities,
  selections,
  onChange,
  className,
}: ModelOptionsEditorProps) {
  const descriptors = capabilities.optionDescriptors;

  const handleSelectChange = (descriptorId: string, value: string | boolean) => {
    const existing = selections.findIndex((s) => s.id === descriptorId);
    const overrides = existing >= 0
      ? selections.map((selection, index) => (
        index === existing ? { id: descriptorId, value } : selection
      ))
      : [...selections, { id: descriptorId, value }];
    onChange(buildProviderOptionSelectionsFromDescriptors(capabilities, overrides));
  };

  if (descriptors.length === 0) {
    return null;
  }

  return (
    <div
      className={cn("space-y-3", className)}
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
    >
      {descriptors.map((descriptor) => {
        const selection = selections.find((s) => s.id === descriptor.id);
        if (descriptor.type === "select") {
          return (
            <SelectOptionEditor
              key={descriptor.id}
              descriptor={descriptor}
              value={(selection?.value as string) ?? descriptor.currentValue}
              onChange={(value) => handleSelectChange(descriptor.id, value)}
            />
          );
        }
        if (descriptor.type === "toggle") {
          return (
            <ToggleOptionEditor
              key={descriptor.id}
              descriptor={descriptor}
              value={(selection?.value as boolean) ?? descriptor.currentValue}
              onChange={(value) => handleSelectChange(descriptor.id, value)}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

export function getSelectionValue(
  selections: ProviderOptionSelection[],
  id: string,
  fallback: string | boolean,
): string | boolean {
  const selection = selections.find((s) => s.id === id);
  return selection?.value ?? fallback;
}
