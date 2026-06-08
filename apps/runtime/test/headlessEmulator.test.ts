import { describe, expect, it } from "vitest";
import { HeadlessEmulator } from "../src/services/headlessEmulator";

describe("HeadlessEmulator", () => {
  it("answers a DA1 query (CSI c) with a device-attributes reply via onData", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    const replies: string[] = [];
    emulator.onData((data) => replies.push(data));

    await emulator.writeSync("\x1b[c");

    expect(replies.join("")).toContain("\x1b[?");
    emulator.dispose();
  });

  it("answers a DSR cursor-position query (CSI 6n) with a CPR report", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    const replies: string[] = [];
    emulator.onData((data) => replies.push(data));

    await emulator.writeSync("\x1b[6n");

    // CPR response ends in 'R'
    expect(replies.join("")).toMatch(/\x1b\[\d+;\d+R/u);
    emulator.dispose();
  });

  it("answers the kitty keyboard query (CSI ?u) — the query opencode blocks on at startup", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    const replies: string[] = [];
    emulator.onData((data) => replies.push(data));

    await emulator.writeSync("\x1b[?u");

    // The runtime advertises TERM_PROGRAM=kitty, so full-screen TUIs send the
    // kitty keyboard progressive-enhancement query and wait for a reply before
    // painting. Without an answer they stall (the "stuck until refresh" bug).
    expect(replies.join("")).toBe("\x1b[?0u");
    emulator.dispose();
  });

  it("answers the OSC 11 background-color query — the other query opencode blocks on", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    const replies: string[] = [];
    emulator.onData((data) => replies.push(data));

    await emulator.writeSync("\x1b]11;?\x07");

    // xterm headless does not auto-answer OSC 10/11 (fg/bg color) queries, so we
    // answer them ourselves. opencode queries the background color at startup
    // and blocks until it gets a reply.
    const reply = replies.join("");
    expect(reply).toMatch(/^\x1b\]11;rgb:[0-9a-f]{2,4}\/[0-9a-f]{2,4}\/[0-9a-f]{2,4}(?:\x07|\x1b\\)$/u);
    emulator.dispose();
  });

  it("answers the OSC 10 foreground-color query", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    const replies: string[] = [];
    emulator.onData((data) => replies.push(data));

    await emulator.writeSync("\x1b]10;?\x07");

    expect(replies.join("")).toMatch(/^\x1b\]10;rgb:[0-9a-f]{2,4}\/[0-9a-f]{2,4}\/[0-9a-f]{2,4}(?:\x07|\x1b\\)$/u);
    emulator.dispose();
  });

  it("does not answer an OSC 11 set (non-query) command", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    const replies: string[] = [];
    emulator.onData((data) => replies.push(data));

    // Setting the background color (not a query) must not produce a reply.
    await emulator.writeSync("\x1b]11;rgb:0000/0000/0000\x07");

    expect(replies.join("")).toBe("");
    emulator.dispose();
  });

  it("tracks alternate-screen mode from DECSET 1049", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    await emulator.writeSync("\x1b[?1049h");
    expect(emulator.getModes().alternateScreen).toBe(true);

    await emulator.writeSync("\x1b[?1049l");
    expect(emulator.getModes().alternateScreen).toBe(false);
    emulator.dispose();
  });

  it("tracks alternate-screen mode even when the sequence is split across writes", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    await emulator.writeSync("\x1b[?10");
    await emulator.writeSync("49h");
    expect(emulator.getModes().alternateScreen).toBe(true);
    emulator.dispose();
  });

  it("tracks bracketed-paste mode from DECSET 2004", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    await emulator.writeSync("\x1b[?2004h");
    expect(emulator.getModes().bracketedPaste).toBe(true);
    emulator.dispose();
  });

  it("captures written text in the serialized snapshot", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    await emulator.writeSync("hello world");
    const snapshot = emulator.getSnapshot();
    expect(snapshot.snapshotAnsi).toContain("hello world");
    expect(snapshot.cols).toBe(80);
    expect(snapshot.rows).toBe(24);
    emulator.dispose();
  });

  it("emits rehydrate sequences for non-default modes but never alt-screen", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    await emulator.writeSync("\x1b[?2004h"); // bracketed paste on (non-default)
    await emulator.writeSync("\x1b[?1049h"); // alt-screen on

    const snapshot = emulator.getSnapshot();
    expect(snapshot.rehydrateSequences).toContain("\x1b[?2004h");
    // Alt-screen is restored via the serialized buffer, never via rehydrate.
    expect(snapshot.rehydrateSequences).not.toContain("\x1b[?1049h");
    expect(snapshot.rehydrateSequences).not.toContain("\x1b[?47h");
    emulator.dispose();
  });

  it("parses cwd from an OSC-7 sequence", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    await emulator.writeSync("\x1b]7;file://localhost/Users/me/project\x07");
    expect(emulator.getCwd()).toBe("/Users/me/project");
    emulator.dispose();
  });

  it("resizes the underlying terminal", async () => {
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
    emulator.resize(120, 40);
    const snapshot = emulator.getSnapshot();
    expect(snapshot.cols).toBe(120);
    expect(snapshot.rows).toBe(40);
    emulator.dispose();
  });
});
