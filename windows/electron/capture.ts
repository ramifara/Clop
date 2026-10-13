/** A window `setContentProtection` can be called on. */
export interface Protectable { isDestroyed(): boolean; setContentProtection(enable: boolean): void }

/**
 * "Show Clop UI in screenshots" (`allowClopToAppearInScreenshots`): while it is off, the floating window (result cards, the compact
 * list and the drop zone) is hidden from screenshots and recordings, as macOS does with `sharingType`. Settings, the pipeline editor,
 * batch, crop, compare and preview stay capturable, so they can be shown in a bug report.
 */
export function protectFromCapture(floating: Protectable | undefined, allow: boolean) {
  if (floating && !floating.isDestroyed()) floating.setContentProtection(!allow);
}
