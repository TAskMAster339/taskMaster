/** Append in bounded batches; callers cancel when replacing the view. */
export function appendInBatches<T>(
  items: readonly T[],
  append: (batch: readonly T[], start: number) => void,
  schedule: (callback: () => void) => void,
  batchSize = 32,
): () => void {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError("Invalid batch size");
  let cancelled = false;
  let offset = 0;
  const next = (): void => {
    if (cancelled) return;
    const start = offset;
    offset = Math.min(items.length, offset + batchSize);
    append(items.slice(start, offset), start);
    if (!cancelled && offset < items.length) schedule(next);
  };
  if (items.length) schedule(next);
  return () => { cancelled = true; };
}
