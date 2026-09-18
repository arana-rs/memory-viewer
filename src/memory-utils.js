export function alignAddress(address, alignment) {
  return Math.ceil(address / alignment) * alignment;
}

export function formatAddress(address) {
  if (typeof address === 'string') return address;
  return `0x${address.toString(16).toUpperCase()}`;
}

export function parseAddress(address) {
  return Number.parseInt(String(address), 16);
}
