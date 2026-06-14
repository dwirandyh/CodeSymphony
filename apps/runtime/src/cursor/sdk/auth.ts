const CURSOR_PROVIDER_UNSUPPORTED_MESSAGE =
  "Cursor uses the authenticated Cursor account via the Cursor SDK and does not support custom provider base URLs or API keys.";

export function resolveCursorApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.CURSOR_API_KEY?.trim();
  if (!key) {
    throw new Error([
      "CURSOR_API_KEY is required for the Cursor SDK.",
      "Set `CURSOR_API_KEY` in apps/runtime/.env and restart the runtime.",
    ].join("\n"));
  }

  return key;
}

export function withCursorSdkSetupHint(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const message = error.message;
  if (/auth|unauthorized|forbidden|api key|invalid key|401|403/i.test(message)) {
    return new Error([
      message,
      "",
      "Cursor SDK authentication failed for the runtime user.",
      "Set `CURSOR_API_KEY` in apps/runtime/.env and restart the runtime.",
    ].join("\n"));
  }

  return error;
}

export function assertCursorSdkProviderConfig(params: {
  providerApiKey?: string | null;
  providerBaseUrl?: string | null;
}): void {
  if (params.providerApiKey?.trim() || params.providerBaseUrl?.trim()) {
    throw new Error(CURSOR_PROVIDER_UNSUPPORTED_MESSAGE);
  }
}
