import { describe, expect, it, beforeEach } from "vitest";
import type { ChatEvent, ChatMessage, ChatTimelineSnapshot } from "@codesymphony/shared-types";
import {
  disposeThreadCollections,
  getThreadCollections,
  resetThreadCollectionsForTest,
} from "./threadCollections";
import { hydrateThreadFromSnapshot } from "./threadHydrator";
import {
  resetThreadStreamStateRegistryForTest,
  setThreadLastEventIdx,
  setThreadLastMessageSeq,
} from "./threadStreamState";

function makeEvent(idx: number, id = `event-${idx}`): ChatEvent {
  return {
    id,
    threadId: "thread-1",
    idx,
    type: "tool.output",
    payload: { output: `event-${idx}` },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function makeMessage(seq: number, id = `message-${seq}`, content = `message-${seq}`): ChatMessage {
  return {
    id,
    threadId: "thread-1",
    seq,
    role: "assistant",
    content,
    attachments: [],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function makeSnapshot(params?: Partial<ChatTimelineSnapshot>): ChatTimelineSnapshot {
  return {
    timelineItems: [],
    summary: {
      oldestRenderableKey: null,
      oldestRenderableKind: null,
      oldestRenderableMessageId: null,
      oldestRenderableHydrationPending: false,
      headIdentityStable: true,
    },
    newestIdx: null,
    newestSeq: null,
    messages: [],
    events: [],
    ...params,
  };
}

beforeEach(() => {
  resetThreadCollectionsForTest();
  resetThreadStreamStateRegistryForTest();
});

describe("threadHydrator", () => {
  it("does not let an older snapshot replace newer streamed rows", () => {
    const { eventsCollection, messagesCollection } = getThreadCollections("thread-1");
    messagesCollection.insert([
      makeMessage(1, "message-1", "local-1"),
      makeMessage(2, "message-2", "local-2"),
    ]);
    eventsCollection.insert([
      makeEvent(1, "event-1"),
      makeEvent(2, "event-2"),
    ]);
    setThreadLastMessageSeq("thread-1", 2);
    setThreadLastEventIdx("thread-1", 2);

    hydrateThreadFromSnapshot({
      threadId: "thread-1",
      mode: "replace",
      snapshot: makeSnapshot({
        newestSeq: 1,
        newestIdx: 1,
        messages: [makeMessage(1, "message-1", "snapshot-older")],
        events: [makeEvent(1, "event-1")],
      }),
    });

    expect((messagesCollection.toArray as ChatMessage[]).map((message) => ({
      id: message.id,
      seq: message.seq,
      content: message.content,
    }))).toEqual([
      { id: "message-1", seq: 1, content: "local-1" },
      { id: "message-2", seq: 2, content: "local-2" },
    ]);
    expect((eventsCollection.toArray as ChatEvent[]).map((event) => event.id)).toEqual([
      "event-1",
      "event-2",
    ]);
  });

  it("prepends older events without clearing newer messages when a pagination page has no messages", () => {
    const { eventsCollection, messagesCollection } = getThreadCollections("thread-1");
    messagesCollection.insert([
      makeMessage(0, "message-0"),
      makeMessage(1, "message-1"),
    ]);
    eventsCollection.insert([
      makeEvent(101, "event-101"),
      makeEvent(102, "event-102"),
    ]);
    setThreadLastMessageSeq("thread-1", 1);
    setThreadLastEventIdx("thread-1", 102);

    const hydrated = hydrateThreadFromSnapshot({
      threadId: "thread-1",
      mode: "prepend",
      snapshot: makeSnapshot({
        newestIdx: 100,
        newestSeq: null,
        messages: [],
        events: [
          makeEvent(99, "event-99"),
          makeEvent(100, "event-100"),
        ],
      }),
    });

    expect(hydrated.messages.map((message) => message.id)).toEqual([
      "message-0",
      "message-1",
    ]);
    expect(hydrated.events.map((event) => event.id)).toEqual([
      "event-99",
      "event-100",
      "event-101",
      "event-102",
    ]);
  });

  it("disposes thread collections and recreates them empty", () => {
    const initial = getThreadCollections("thread-1");
    initial.messagesCollection.insert(makeMessage(1));
    initial.eventsCollection.insert(makeEvent(1));

    disposeThreadCollections("thread-1");

    const recreated = getThreadCollections("thread-1");
    expect(recreated.messagesCollection).not.toBe(initial.messagesCollection);
    expect(recreated.eventsCollection).not.toBe(initial.eventsCollection);
    expect(recreated.messagesCollection.toArray).toHaveLength(0);
    expect(recreated.eventsCollection.toArray).toHaveLength(0);
  });
});
