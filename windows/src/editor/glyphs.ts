// Pipelines and preset zones carry an SF Symbol name on macOS. Windows has no SF Symbols, so each name maps to a character
// the system fonts draw; a name from a Mac library that is not listed here shows the generic one.
export const GLYPHS: Readonly<Record<string, string>> = {
  'wand.and.sparkles': '✨', photo: '🖼', 'photo.stack': '🗂', 'photo.on.rectangle.angled': '🎞', folder: '📁', tv: '📺', 'arrow.down.right.and.arrow.up.left': '⤡',
  signature: '✍', 'speaker.slash.fill': '🔇', 'music.note': '🎵', bolt: '⚡', star: '⭐', heart: '❤', scissors: '✂', crop: '⛶', film: '🎬', doc: '📄',
  archivebox: '📦', trash: '🗑', paperplane: '✈', camera: '📷', mic: '🎤', waveform: '〰', play: '▶', flame: '🔥', tag: '🏷', cloud: '☁', link: '🔗', globe: '🌐',
};
export const DEFAULT_GLYPH = '✦';
export const ICON_NAMES = Object.keys(GLYPHS);
export const glyph = (name?: string) => (name && GLYPHS[name]) || DEFAULT_GLYPH;
