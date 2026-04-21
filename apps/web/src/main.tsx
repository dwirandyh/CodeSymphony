import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { ensureBrowserCryptoRandomUUID } from "./lib/browserCrypto";
import { createQueryClient } from "./lib/queryClient";
import { installDesktopShellVitePreloadGuard } from "./lib/vitePreloadGuard";
import { AppCrashFallback } from "./components/error/AppCrashFallback";
import "./styles.css";

ensureBrowserCryptoRandomUUID();
installDesktopShellVitePreloadGuard();

const queryClient = createQueryClient();

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

type RootErrorBoundaryState = {
  error: Error | null;
};

class RootErrorBoundary extends React.Component<React.PropsWithChildren, RootErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </RootErrorBoundary>
  </React.StrictMode>,
);
