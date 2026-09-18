const resetters = new Set<() => void>();

export function registerResetter(reset: () => void): () => boolean {
  if (typeof reset !== 'function') {
    throw new TypeError('El resetter debe ser una función.');
  }

  resetters.add(reset);
  return () => resetters.delete(reset);
}

export function resetAllStates(): void {
  resetters.forEach((reset) => reset());
  document.dispatchEvent(new CustomEvent('memory:reset'));
}
