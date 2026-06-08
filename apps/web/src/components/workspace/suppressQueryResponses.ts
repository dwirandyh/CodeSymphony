import type { Terminal } from "@xterm/xterm";

/**
 * Suppress terminal query *responses* from being rendered as visible text.
 *
 * The runtime now runs a server-side headless emulator that answers terminal
 * capability queries (DA1/DSR/etc) on behalf of the session. The visible xterm
 * in the browser ALSO auto-answers those queries — and because we pipe
 * `xterm.onData` straight to the WebSocket (→ PTY), those duplicate replies
 * would be written to the PTY as fake keystrokes and surface as garbage like
 * `?62;4;9;22c` at the shell prompt. We consume the response-only sequences
 * here so only the server emulator answers.
 *
 * We only suppress sequences whose RESPONSE has a different final byte than the
 * QUERY, so we never break a query/command that shares the same final byte.
 *
 * SAFE to suppress (response-only):
 * - CSI R     — Cursor Position Report (query is CSI 6n)
 * - CSI I / O — Focus in/out reports (no query; mode 1004 enable only)
 * - CSI $y    — DECRPM mode report (query is CSI ? Ps $p)
 *
 * NOT suppressed (query and response share a final byte):
 * - CSI c (DA), CSI t (window ops), OSC color set/report
 *
 * Ported 1:1 from superset's suppressQueryResponses.
 */
export function suppressQueryResponses(terminal: Terminal): () => void {
  const disposables: { dispose: () => void }[] = [];
  const parser = terminal.parser;

  // CPR response: query ESC[6n ends in 'n', response ESC[24;1R ends in 'R'.
  disposables.push(parser.registerCsiHandler({ final: "R" }, () => true));

  // Focus in/out reports (mode 1004) — no query, response-only.
  disposables.push(parser.registerCsiHandler({ final: "I" }, () => true));
  disposables.push(parser.registerCsiHandler({ final: "O" }, () => true));

  // DECRPM mode report: query ESC[?Ps$p ends in 'p', response ESC[?Ps;Pm$y.
  disposables.push(
    parser.registerCsiHandler({ intermediates: "$", final: "y" }, () => true),
  );

  return () => {
    for (const disposable of disposables) {
      disposable.dispose();
    }
  };
}
