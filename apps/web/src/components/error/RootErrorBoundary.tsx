import React from "react";
import { debugLog } from "../../lib/debugLog";
import { AppCrashFallback } from "./AppCrashFallback";

type RootErrorBoundaryState = {
  error: Error | null;
};

export class RootErrorBoundary extends React.Component<React.PropsWithChildren, RootErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Force-flush so the crash survives the unmount/reload that follows.
    debugLog(
      "app.crash",
      error.message,
      {
        name: error.name,
        stack: error.stack ?? null,
        componentStack: info.componentStack ?? null,
      },
      { force: true },
    );
  }

  render() {
    if (this.state.error) {
      return (
        <AppCrashFallback
          error={this.state.error}
          onReload={() => window.location.reload()}
          onResetHome={() => window.location.assign("/")}
        />
      );
    }

    return this.props.children;
  }
}
