import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { ensureBrowserCryptoRandomUUID } from "./lib/browserCrypto";
import { createQueryClient } from "./lib/queryClient";
import { isDesktopShell } from "./lib/openExternalUrl";
import { bootstrapWorkspaceStartup } from "./lib/startupBoot";
import { initializeStartupPerfSession } from "./lib/startupPerf";
import { installDesktopShellVitePreloadGuard } from "./lib/vitePreloadGuard";
import { RootErrorBoundary } from "./components/error/RootErrorBoundary";
import { installGlobalErrorReporter } from "./components/error/installGlobalErrorReporter";
import "./styles.css";

ensureBrowserCryptoRandomUUID();
installDesktopShellVitePreloadGuard();
installGlobalErrorReporter();
initializeStartupPerfSession({
  target: isDesktopShell() ? "desktop" : "web",
});

const queryClient = createQueryClient();

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const RootMode = import.meta.env.DEV ? React.Fragment : React.StrictMode;

void bootstrapWorkspaceStartup(queryClient);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <RootMode>
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </RootErrorBoundary>
  </RootMode>,
);
