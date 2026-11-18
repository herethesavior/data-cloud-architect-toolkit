import type { InventorySnapshot } from '@dcat/core';

export function exportInventoryJson(inventory: InventorySnapshot): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

export function downloadTextFile(filename: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Defer revocation: Firefox and Safari can abort a download whose blob URL
  // is revoked in the same task as the click.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
