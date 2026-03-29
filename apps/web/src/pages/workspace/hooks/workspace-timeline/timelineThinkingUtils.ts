// Legacy helper module kept temporarily so stale imports can compile.
// Runtime and web timeline assembly no longer synthesize or render thinking items.

type ThinkingRound = {
  content: string;
  firstIdx: number;
  lastIdx: number;
};

export function buildThinkingRounds(): Map<string, ThinkingRound[]> {
  return new Map();
}

export function mergeThinkingRounds(rawRounds: ThinkingRound[]): ThinkingRound[] {
  return rawRounds;
}

export function insertThinkingItems(): void {
  // no-op
}
