import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";

const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BRAILLE_SPINNER_INTERVAL_MS = 120;

export function BrailleSpinner({
  className,
}: {
  className?: string;
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setFrame((current) => (current + 1) % BRAILLE_SPINNER_FRAMES.length);
    }, BRAILLE_SPINNER_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span
      aria-hidden="true"
      className={cn("inline-block w-[1ch] font-mono leading-none text-primary", className)}
    >
      {BRAILLE_SPINNER_FRAMES[frame]}
    </span>
  );
}
