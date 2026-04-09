import { createRootRoute, Outlet } from "@tanstack/react-router";
import { AppCrashFallback } from "../components/error/AppCrashFallback";

export const Route = createRootRoute({
  component: () => (
    <Outlet />
  ),
  errorComponent: ({ error }) => (
    <AppCrashFallback
      error={error instanceof Error ? error : new Error("Unknown route error")}
      onReload={() => window.location.reload()}
      onResetHome={() => window.location.assign("/")}
    />
  ),
});
