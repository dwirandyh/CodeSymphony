/** Skip chat-session → URL sync while explicit user intent owns thread selection. */
export function shouldSkipChatThreadNavigationNotify(params: {
  userIntentThreadId: string | null | undefined;
}): boolean {
  return params.userIntentThreadId !== undefined;
}