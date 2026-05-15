import { parseUserMentions } from "../../../lib/mentions";
import { createChipElement, createSlashCommandChipElement } from "./composerChipUtils";
import { nextMentionId } from "./composerEditorUtils";

export const COMPOSER_DRAFT_STORAGE_KEY = "codesymphony:workspace:composer-drafts:v1";

type PersistedComposerDraftEntry = {
  content: string;
  updatedAt: number;
};

type PersistedComposerDraftState = {
  version: 1;
  draftsById: Record<string, PersistedComposerDraftEntry>;
};

const ATTACHMENT_MARKER_RE = /\{\{attachment:[^}]+\}\}/g;
const MAX_PERSISTED_DRAFT_COUNT = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sanitizePersistedComposerDraftContent(content: string): string {
  return content.replace(ATTACHMENT_MARKER_RE, "").replace(/\u00A0/g, " ");
}

function normalizePersistedComposerDrafts(
  value: unknown,
): Record<string, PersistedComposerDraftEntry> {
  if (!isPlainObject(value)) {
    return {};
  }

  const draftsById: Record<string, PersistedComposerDraftEntry> = {};
  for (const [draftId, entry] of Object.entries(value)) {
    const normalizedDraftId = draftId.trim();
    if (!normalizedDraftId || !isPlainObject(entry) || typeof entry.content !== "string") {
      continue;
    }

    const normalizedContent = sanitizePersistedComposerDraftContent(entry.content);
    if (normalizedContent.trim().length === 0) {
      continue;
    }

    draftsById[normalizedDraftId] = {
      content: normalizedContent,
      updatedAt: Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : 0,
    };
  }

  return draftsById;
}

function readPersistedComposerDraftState(
  storage: Pick<Storage, "getItem">,
): PersistedComposerDraftState {
  try {
    const raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    if (!raw) {
      return {
        version: 1,
        draftsById: {},
      };
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed) || parsed.version !== 1) {
      return {
        version: 1,
        draftsById: {},
      };
    }

    return {
      version: 1,
      draftsById: normalizePersistedComposerDrafts(parsed.draftsById),
    };
  } catch {
    return {
      version: 1,
      draftsById: {},
    };
  }
}

function writePersistedComposerDraftState(
  storage: Pick<Storage, "setItem" | "removeItem">,
  draftsById: Record<string, PersistedComposerDraftEntry>,
): void {
  if (Object.keys(draftsById).length === 0) {
    storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    return;
  }

  storage.setItem(
    COMPOSER_DRAFT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      draftsById,
    } satisfies PersistedComposerDraftState),
  );
}

export function resolveComposerDraftStorageId(params: {
  threadId: string | null;
  worktreeId: string | null;
}): string | null {
  const normalizedThreadId = params.threadId?.trim() ?? "";
  const normalizedWorktreeId = params.worktreeId?.trim() ?? "";

  if (!normalizedThreadId && !normalizedWorktreeId) {
    return null;
  }

  if (normalizedThreadId && normalizedWorktreeId) {
    return `worktree:${normalizedWorktreeId}:thread:${normalizedThreadId}`;
  }

  if (normalizedThreadId) {
    return `thread:${normalizedThreadId}`;
  }

  return `worktree:${normalizedWorktreeId}:unthreaded`;
}

export function readPersistedComposerDraft(
  storage: Pick<Storage, "getItem">,
  draftId: string | null,
): string | null {
  if (!draftId) {
    return null;
  }

  const state = readPersistedComposerDraftState(storage);
  return state.draftsById[draftId]?.content ?? null;
}

export function writePersistedComposerDraft(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  params: {
    draftId: string | null;
    content: string;
  },
): void {
  if (!params.draftId) {
    return;
  }

  const normalizedContent = sanitizePersistedComposerDraftContent(params.content);
  const state = readPersistedComposerDraftState(storage);
  const nextDraftsById = { ...state.draftsById };

  if (normalizedContent.trim().length === 0) {
    delete nextDraftsById[params.draftId];
    writePersistedComposerDraftState(storage, nextDraftsById);
    return;
  }

  nextDraftsById[params.draftId] = {
    content: normalizedContent,
    updatedAt: Date.now(),
  };

  const prunedDraftEntries = Object.entries(nextDraftsById)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_PERSISTED_DRAFT_COUNT);

  writePersistedComposerDraftState(storage, Object.fromEntries(prunedDraftEntries));
}

export function clearPersistedComposerDraft(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  draftId: string | null,
): void {
  if (!draftId) {
    return;
  }

  const state = readPersistedComposerDraftState(storage);
  if (!(draftId in state.draftsById)) {
    return;
  }

  const nextDraftsById = { ...state.draftsById };
  delete nextDraftsById[draftId];
  writePersistedComposerDraftState(storage, nextDraftsById);
}

export function buildComposerDraftFragment(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const normalizedContent = sanitizePersistedComposerDraftContent(content);

  for (const segment of parseUserMentions(normalizedContent)) {
    if (segment.kind === "text") {
      fragment.appendChild(document.createTextNode(segment.value));
      continue;
    }

    if (segment.kind === "slash-command") {
      fragment.appendChild(createSlashCommandChipElement(segment.name, segment.trigger));
      continue;
    }

    fragment.appendChild(createChipElement({
      id: nextMentionId(),
      path: segment.path,
      type: segment.isDirectory ? "directory" : "file",
    }));
  }

  return fragment;
}
