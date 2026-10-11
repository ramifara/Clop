import sharp from 'sharp';

// The tray icon's three states, drawn from the app icon (`electron/tray-menu.ts` `trayVariant`): normal, paused (dimmed, with a pause
// badge) and working (with an accent dot). 32 px, which Windows scales for the notification area.
const SIZE = 32;
const badge = svg => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${svg}</svg>`);
const PAUSED = '<circle cx="23" cy="23" r="8.5" fill="#1f1b22"/><rect x="19.5" y="19" width="2.6" height="8" rx=".8" fill="#fff"/><rect x="24.3" y="19" width="2.6" height="8" rx=".8" fill="#fff"/>';
const WORKING = '<circle cx="23" cy="23" r="8.5" fill="#fff"/><circle cx="23" cy="23" r="6.5" fill="#e8590c"/>';

/** The PNG for each state, from the app icon's PNG bytes. */
export async function trayIcons(icon) {
  const base = () => sharp(icon).resize(SIZE, SIZE);
  const normal = await base().png().toBuffer();
  const paused = await base().modulate({ saturation: 0.15, brightness: 0.8 }).composite([{ input: badge(PAUSED) }]).png().toBuffer();
  const working = await base().composite([{ input: badge(WORKING) }]).png().toBuffer();
  return { normal, paused, working };
}
