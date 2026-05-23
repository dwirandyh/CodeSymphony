export function shouldEagerlyEnableCriticalWorkspaceData(params: {
  desktopApp: boolean;
  hasPersistedShellSnapshot: boolean;
}) {
  return params.desktopApp && params.hasPersistedShellSnapshot;
}
