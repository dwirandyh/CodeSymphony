import { cn } from "../../lib/utils";

type StartupSplashProps = {
  headline: string;
  detail: string;
  className?: string;
  pulse?: boolean;
};

export function StartupSplash({
  headline,
  detail,
  className,
  pulse = true,
}: StartupSplashProps) {
  return (
    <div
      className={cn(
        "flex min-h-screen w-full items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(75,152,255,0.18),_transparent_34%),linear-gradient(180deg,_#0d1218_0%,_#090c10_100%)] px-6 py-10",
        className,
      )}
      data-testid="startup-splash"
    >
      <div className="relative flex w-full max-w-sm flex-col items-center justify-center text-center">
        <div
          aria-hidden="true"
          className={cn(
            "absolute h-44 w-44 rounded-full bg-primary/16 blur-3xl transition-opacity duration-500",
            pulse ? "animate-pulse opacity-100" : "opacity-70",
          )}
        />

        <div className="relative flex flex-col items-center gap-5">
          <div className="rounded-[28px] border border-white/10 bg-white/[0.045] p-5 shadow-[0_30px_120px_rgba(0,0,0,0.45)] backdrop-blur-sm">
            <img
              src="/brand/codesymphony-logo.png"
              alt=""
              aria-hidden="true"
              draggable={false}
              className="h-20 w-20 select-none object-contain"
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.26em] text-foreground/88">
              {headline}
            </p>
            <p className="max-w-xs text-sm leading-6 text-muted-foreground">
              {detail}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
