export function setBooleanMapEntry(
  current: Map<string, boolean>,
  key: string,
  nextValue: boolean,
): Map<string, boolean> {
  if (!current.has(key) && nextValue === false) {
    return current;
  }

  if (current.get(key) === nextValue) {
    return current;
  }

  const next = new Map(current);
  next.set(key, nextValue);
  return next;
}
