import type { Repository } from "@codesymphony/shared-types";

export const REPOSITORY_PANEL_PREFERENCES_STORAGE_KEY = "codesymphony:workspace:repository-panel-preferences";

export type RepositoryPanelDropPosition = "before" | "after";

export type RepositoryPanelPreferences = {
  order: string[];
  hidden: string[];
};

const EMPTY_PREFERENCES: RepositoryPanelPreferences = {
  order: [],
  hidden: [],
};

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (seen.has(id)) {
      return false;
    }

    seen.add(id);
    return true;
  });
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function loadRepositoryPanelPreferences(): RepositoryPanelPreferences {
  if (typeof window === "undefined") {
    return EMPTY_PREFERENCES;
  }

  try {
    const raw = window.localStorage.getItem(REPOSITORY_PANEL_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return EMPTY_PREFERENCES;
    }

    const parsed = JSON.parse(raw) as {
      order?: unknown;
      hidden?: unknown;
    };
    const order = Array.isArray(parsed?.order)
      ? parsed.order.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const hidden = Array.isArray(parsed?.hidden)
      ? parsed.hidden.filter((value: unknown): value is string => typeof value === "string")
      : [];

    return {
      order: uniqueIds(order),
      hidden: uniqueIds(hidden),
    };
  } catch {
    return EMPTY_PREFERENCES;
  }
}

export function normalizeRepositoryPanelPreferences(
  repositories: Pick<Repository, "id">[],
  preferences: RepositoryPanelPreferences,
): RepositoryPanelPreferences {
  if (repositories.length === 0) {
    return preferences;
  }

  const validIds = new Set(repositories.map((repository) => repository.id));
  const nextOrder = uniqueIds(preferences.order.filter((id) => validIds.has(id)));

  for (const repository of repositories) {
    if (!nextOrder.includes(repository.id)) {
      nextOrder.push(repository.id);
    }
  }

  const nextHidden = uniqueIds(preferences.hidden.filter((id) => validIds.has(id)));

  if (sameIds(nextOrder, preferences.order) && sameIds(nextHidden, preferences.hidden)) {
    return preferences;
  }

  return {
    order: nextOrder,
    hidden: nextHidden,
  };
}

export function sortRepositoriesByPreference<T extends Pick<Repository, "id">>(
  repositories: T[],
  order: string[],
): T[] {
  const orderIndex = new Map(order.map((id, index) => [id, index]));

  return [...repositories].sort((left, right) => {
    const leftIndex = orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

export function reorderRepositoryIds(
  order: string[],
  draggedRepositoryId: string,
  targetRepositoryId: string,
  position: RepositoryPanelDropPosition,
): string[] {
  if (draggedRepositoryId === targetRepositoryId) {
    return order;
  }

  const nextOrder = order.filter((id) => id !== draggedRepositoryId);
  const targetIndex = nextOrder.indexOf(targetRepositoryId);
  if (targetIndex < 0) {
    return order;
  }

  nextOrder.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, draggedRepositoryId);
  return nextOrder;
}
