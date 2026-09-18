export function alignAddress(address: number, alignment: number): number {
  return Math.ceil(address / alignment) * alignment;
}

export function formatAddress(address: number | string): string {
  if (typeof address === 'string') return address;
  return `0x${address.toString(16).toUpperCase()}`;
}

export function parseAddress(address: number | string): number {
  return Number.parseInt(String(address), 16);
}
