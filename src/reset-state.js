const resetters = new Set();

export function registerResetter(reset) {
  if (typeof reset !== 'function') {
    throw new TypeError('El resetter debe ser una función.');
  }

  resetters.add(reset);
  return () => resetters.delete(reset);
}

export function resetAllStates() {
  resetters.forEach((reset) => reset());
  document.dispatchEvent(new CustomEvent('memory:reset'));
}
