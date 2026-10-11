import type { SettingKey } from './schema';
import type { SettingsTab } from './tabs';

// The rows of the Settings window, described in the words the user reads: a port of `SettingsSearchIndex.all` (Clop/SettingsSearchIndex.swift)
// with Windows wording, rows for the Windows-only and previously unlisted keys, and a `ui` hint for how the window draws each row. The window lays
// out each tab from these rows in order, and the search ranks them, so a row is written once for both. Pure data, so the renderer can import it
// (the schema itself needs Node). Row ids keep the macOS form `<tab>.<section>.<key>`; `clop://settings/<tab>/<id>` opens a row.
//
// `keys` names the settings the row writes. A row with none (the MCP installer, About) is a custom pane. Rows are drawn from the schema's type
// unless `ui.control` names another control.

export type Control =
  | 'toggle' | 'select' | 'number' | 'text' | 'formats' | 'list'
  | 'nameTemplate' | 'pathTemplate' | 'compression' | 'pdfDpi' | 'sizeRange' | 'resolutionRange' | 'fpsCap' | 'minFps' | 'linkExpiration'
  | 'dirs' | 'ignoredApps' | 'editorApp' | 'workdir' | 'embedded'
  | 'modifiers' | 'actionKeys' | 'resizeKeys' | 'actions' | 'presetZones'
  | 'pipelines' | 'automation' | 'sourceAutomation' | 'mcpToggle' | 'mcpInstall' | 'updates' | 'about';
export type MediaName = 'image' | 'video' | 'audio' | 'pdf';
export interface EntryUI {
  /** Set while nothing in Clop for Windows reads this setting. The row stays editable, so a stored value survives and search finds it, but the window says it does nothing yet. The text says why. */
  pending?: string;
  control?: Control;
  /** The file type a row is about: which watched folders, editor, name template or compression it edits. */
  kind?: MediaName;
  /** Which template of the file type: optimised results, converted results, or the clipboard image name. */
  mode?: 'optimised' | 'converted' | 'clipboard';
  /** The choices of a select as `[value, label]`, in the order shown. An enum without labels offers its values; a number offers only these. */
  labels?: [string, string][];
  unit?: string;
  /** `embedded` rows are drawn inside another row; a link to one scrolls to that row. */
  within?: string;
  source?: 'clipboard' | 'dropZone';
  layout?: 'floating' | 'compact';
  /** The row works only while one of these settings has this value (a switch is on, a placement is chosen); otherwise it is drawn dimmed. */
  when?: [SettingKey, string | boolean][];
}
export interface SettingEntry {
  id: string;
  keys: SettingKey[];
  title: string;
  subtitle: string;
  /** Words a person would search for that the title and subtitle do not contain: someone types "mov" or "replace the original", the row says "Auto-conversion behaviour". */
  keywords: string[];
  tab: SettingsTab;
  section: string;
  ui?: EntryUI;
}

type Row = Omit<SettingEntry, 'keys'> & { keys: string[] };
const rows: Row[] = [

  // general › main
  { id: 'general.main.showMenubarIcon', keys: ['showMenubarIcon'], title: 'Tray icon', subtitle: 'Show the Clop icon in the notification area', keywords: ['tray', 'notification area', 'taskbar', 'system tray', 'hide', 'hidden', 'icon', 'missing', 'disappeared'], tab: 'general', section: '', ui: { control: 'toggle' } },
  { id: 'general.main.launchAtLogin', keys: ['launchAtLogin'], title: 'Start with Windows', subtitle: 'Start Clop when you sign in', keywords: ['startup', 'login', 'boot', 'autostart', 'sign in', 'run at startup'], tab: 'general', section: '' },
  { id: 'general.main.defaultLinkExpiration', keys: ['defaultLinkExpiration'], title: 'Shared links expire after', subtitle: 'How long a link made by sending a file stays alive', keywords: [], tab: 'general', section: '', ui: { pending: 'shared links come with a later change', control: 'select', labels: [['3600', '1 hour'], ['21600', '6 hours'], ['86400', '1 day'], ['259200', '3 days'], ['604800', '1 week'], ['2592000', '1 month'], ['0', 'Never']] } },
  { id: 'general.main.pauseAutomaticOptimisations', keys: ['pauseAutomaticOptimisations'], title: 'Pause automatic optimisations', subtitle: '', keywords: ['resume', 'stop', 'disable', 'snooze', 'watcher', 'watched folders', 'clipboard', 'nothing happens', 'not working', 'temporarily', 'off'], tab: 'general', section: '' },
  { id: 'general.main.allowClopToAppearInScreenshots', keys: ['allowClopToAppearInScreenshots'], title: 'Show Clop UI in screenshots', subtitle: '', keywords: ['screen recording', 'capture', 'screenshot', 'floating results', 'drop zone', 'visible', 'hidden', 'snipping tool', 'record', 'demo', 'share'], tab: 'general', section: '' },

  // general › Edit with external app
  { id: 'general.editwithexternalapp.editorAppImage', keys: ['editorAppImage'], title: 'Edit images with', subtitle: 'The program Edit with opens from the right-click menu of a result. Without one, Windows picks the default app.', keywords: ['editor', 'external app', 'open with', 'edit with', 'choose app', 'program', 'exe', 'default app'], tab: 'general', section: 'Edit with external app', ui: { control: 'editorApp' } },
  { id: 'general.editwithexternalapp.editorAppVideo', keys: ['editorAppVideo'], title: 'Edit videos with', subtitle: '', keywords: ['editor', 'external app', 'open with', 'edit with', 'choose app', 'program', 'exe', 'default app'], tab: 'general', section: 'Edit with external app', ui: { control: 'editorApp' } },
  { id: 'general.editwithexternalapp.editorAppAudio', keys: ['editorAppAudio'], title: 'Edit audio with', subtitle: '', keywords: ['editor', 'external app', 'open with', 'edit with', 'choose app', 'program', 'exe', 'default app'], tab: 'general', section: 'Edit with external app', ui: { control: 'editorApp' } },
  { id: 'general.editwithexternalapp.editorAppPDF', keys: ['editorAppPDF'], title: 'Edit PDFs with', subtitle: '', keywords: ['editor', 'external app', 'open with', 'edit with', 'choose app', 'program', 'exe', 'default app'], tab: 'general', section: 'Edit with external app', ui: { control: 'editorApp' } },

  // general › Working directory
  { id: 'general.workingdirectory.workdir', keys: ['workdir'], title: 'Working directory path', subtitle: 'Where backups and temporary files are kept. Takes effect the next time Clop starts.', keywords: ['workdir', 'folder', 'cache', 'temp', 'temporary', 'backups', 'scratch', 'disk space', 'location', 'move', 'reset'], tab: 'general', section: 'Working directory', ui: { control: 'workdir' } },
  { id: 'general.workingdirectory.workdirCleanupInterval', keys: ['workdirCleanupInterval'], title: 'Clean up files older than', subtitle: 'Periodically delete files older than this from Clop\'s working directory', keywords: [], tab: 'general', section: 'Working directory', ui: { control: 'select', labels: [['600', '10 minutes'], ['3600', '1 hour'], ['43200', '12 hours'], ['86400', '1 day'], ['259200', '3 days'], ['604800', '1 week'], ['2592000', '1 month'], ['0', 'Never clean up']] } },

  // general › Optimisation
  { id: 'general.optimisation.stripMetadata', keys: ['stripMetadata'], title: 'Strip EXIF Metadata', subtitle: 'Delete identifiable metadata from files (e.g. the camera that took the photo, location, date and time)', keywords: ['exif', 'metadata', 'gps', 'location', 'privacy', 'camera'], tab: 'general', section: 'Optimisation' },
  { id: 'general.optimisation.preserveColorMetadata', keys: ['preserveColorMetadata'], title: 'Preserve color profile metadata', subtitle: 'Keep color profile metadata tags untouched when stripping EXIF metadata', keywords: [], tab: 'general', section: 'Optimisation', ui: { when: [['stripMetadata', true]] } },
  { id: 'general.optimisation.preserveDates', keys: ['preserveDates'], title: 'Preserve file creation and modification dates', subtitle: 'The optimised file will have the same creation and modification dates as the original file', keywords: ['timestamp', 'created', 'modified', 'date', 'mtime'], tab: 'general', section: 'Optimisation' },
  { id: 'general.optimisation.optimisedFileProtectionMs', keys: ['optimisedFileProtectionMs'], title: 'Re-optimisation loop detection window', subtitle: 'Increase if files in a synced folder (OneDrive, Dropbox) get optimised twice', keywords: [], tab: 'general', section: 'Optimisation', ui: { control: 'select', labels: [['3000', '3 seconds'], ['10000', '10 seconds'], ['30000', '30 seconds'], ['60000', '60 seconds']] } },

  // general › Troubleshooting
  { id: 'general.troubleshooting.persistDebugLogs', keys: ['persistDebugLogs'], title: 'Keep a debug log', subtitle: 'Write what Clop does to logs\\clop.log in its app data folder', keywords: ['log', 'logs', 'debug', 'diagnostics', 'support', 'bug report', 'troubleshoot'], tab: 'general', section: 'Troubleshooting' },

  // clipboard › Clipboard
  { id: 'clipboard.clipboard.enableClipboardOptimiser', keys: ['enableClipboardOptimiser'], title: 'Enable clipboard optimiser', subtitle: 'Watch for copied data and optimise it automatically', keywords: ['clipboard', 'copy', 'paste', 'watch', 'automatic'], tab: 'clipboard', section: 'Clipboard' },
  { id: 'clipboard.clipboard.optimiseTIFF', keys: ['optimiseTIFF'], title: 'TIFF data', subtitle: 'Usually from graphical design apps, sometimes better left alone', keywords: [], tab: 'clipboard', section: 'Clipboard' },
  { id: 'clipboard.clipboard.optimiseHEICAVIFClipboard', keys: ['optimiseHEICAVIFClipboard'], title: 'HEIC and AVIF data', subtitle: '', keywords: ['heic', 'heif', 'avif', 'iphone', 'photos', 'hdr', 'copied photo'], tab: 'clipboard', section: 'Clipboard' },
  { id: 'clipboard.clipboard.optimiseImagePathClipboard', keys: ['optimiseImagePathClipboard'], title: 'Image files', subtitle: 'Copying images in File Explorer puts file paths on the clipboard instead of image data', keywords: [], tab: 'clipboard', section: 'Clipboard' },
  { id: 'clipboard.clipboard.optimiseVideoClipboard', keys: ['optimiseVideoClipboard'], title: 'Video files', subtitle: 'Optimise copied video file paths', keywords: [], tab: 'clipboard', section: 'Clipboard' },
  { id: 'clipboard.clipboard.optimiseAudioClipboard', keys: ['optimiseAudioClipboard'], title: 'Audio files', subtitle: 'Optimise copied audio file paths', keywords: [], tab: 'clipboard', section: 'Clipboard' },
  { id: 'clipboard.clipboard.optimisePDFClipboard', keys: ['optimisePDFClipboard'], title: 'PDF files', subtitle: 'Optimise copied PDF file paths', keywords: [], tab: 'clipboard', section: 'Clipboard' },
  { id: 'clipboard.clipboard.appendClipboardResults', keys: ['appendClipboardResults'], title: 'Keep all clipboard results', subtitle: 'Show each clipboard optimisation as a separate result instead of replacing the previous one', keywords: [], tab: 'clipboard', section: 'Clipboard' },
  { id: 'clipboard.clipboard.copyConsecutiveClipboardImages', keys: ['copyConsecutiveClipboardImages'], title: 'Accumulate optimised images in clipboard', subtitle: 'Each new optimised image is added to a file list in the clipboard, so you can paste them all at once into image editor apps like Pixelmator or Affinity, or into notes', keywords: [], tab: 'clipboard', section: 'Clipboard' },
  { id: 'clipboard.clipboard.clipboardAccumulationTimeout', keys: ['clipboardAccumulationTimeout'], title: 'Accumulation timeout', subtitle: 'How long consecutive copied images keep accumulating into one file list', keywords: [], tab: 'clipboard', section: 'Clipboard', ui: { control: 'number', unit: 'seconds', when: [['copyConsecutiveClipboardImages', true]] } },

  // clipboard › Ignored apps
  { id: 'clipboard.ignoredapps.clipboardIgnoredAppBundleIds', keys: ['clipboardIgnoredAppBundleIds'], title: 'Ignored apps', subtitle: 'Skip clipboard optimisation when a copy comes from one of these apps', keywords: ['denylist', 'blocklist', 'exclude', 'exclusion', 'exe', 'program', 'frontmost', 'foreground app', 'figma', 'photoshop', 'password manager', 'copy', 'paste', 'per app'], tab: 'clipboard', section: 'Ignored apps', ui: { control: 'ignoredApps' } },

  // clipboard › Automation
  { id: 'clipboard.automation.clipboardAutomation', keys: [], title: 'Clipboard automation', subtitle: 'Run actions on every file you copy', keywords: ['pipeline', 'pipelines', 'automation', 'copy', 'paste', 'actions', 'clipboard'], tab: 'clipboard', section: 'Automation', ui: { control: 'sourceAutomation', source: 'clipboard' } },

  // files › Images
  { id: 'files.images.optimisedImageBehaviour', keys: ['optimisedImageBehaviour'], title: 'Optimised file placement', subtitle: 'Where the smaller file is saved, and whether it replaces the original', keywords: ['placement', 'where', 'save', 'saved', 'replace', 'original', 'in place', 'copy', 'same folder', 'specific folder', 'overwrite', 'output'], tab: 'files', section: 'Images', ui: { control: 'select', labels: [['temporary', 'Temporary folder'], ['inPlace', 'In place (replace original)'], ['sameFolder', 'Same folder as original'], ['specificFolder', 'Specific folder']] } },
  { id: 'files.images.sameFolderNameTemplateImage', keys: ['sameFolderNameTemplateImage'], title: 'Name template for optimised images saved in the same folder', subtitle: '', keywords: ['%f', 'suffix', 'optimised', 'rename', 'naming', 'filename', 'variables', 'date', 'counter', 'overwrite'], tab: 'files', section: 'Images', ui: { control: 'nameTemplate', kind: 'image', mode: 'optimised', when: [['optimisedImageBehaviour', 'sameFolder']] } },
  { id: 'files.images.specificFolderNameTemplateImage', keys: ['specificFolderNameTemplateImage'], title: 'Path template for optimised images saved in a specific folder', subtitle: '', keywords: ['%P', '%f', 'folder', 'destination', 'output path', 'where', 'naming', 'pattern', 'subfolder', 'variables'], tab: 'files', section: 'Images', ui: { control: 'pathTemplate', kind: 'image', mode: 'optimised', when: [['optimisedImageBehaviour', 'specificFolder']] } },
  { id: 'files.images.convertedImageBehaviour', keys: ['convertedImageBehaviour'], title: 'Auto-conversion behaviour for compatible formats', subtitle: 'Formats that many apps cannot open well are converted to a widely supported one automatically before optimising.', keywords: ['webp', 'avif', 'heic', 'bmp', 'png', 'jpeg', 'convert', 'conversion', 'replace', 'original', 'in place', 'copy', 'keep', 'beside', 'automatic', 'compatibility'], tab: 'files', section: 'Images', ui: { control: 'select', labels: [['temporary', 'Temporary folder'], ['inPlace', 'In place (replace original)'], ['sameFolder', 'Same folder as original'], ['specificFolder', 'Specific folder']] } },
  { id: 'files.images.manualConvertedImageBehaviour', keys: ['manualConvertedImageBehaviour'], title: 'Manual conversion behaviour', subtitle: 'When you pick a new format by clicking the file extension on a floating result, or via the submenu Convert to... in the right-click menu.', keywords: ['convert to', 'manual', 'right click', 'extension', 'click', 'replace', 'original', 'in place', 'copy'], tab: 'files', section: 'Images', ui: { control: 'select', labels: [['temporary', 'Temporary folder'], ['inPlace', 'In place (replace original)'], ['sameFolder', 'Same folder as original'], ['specificFolder', 'Specific folder']] } },
  { id: 'files.images.convertedSameFolderNameTemplateImage', keys: ['convertedSameFolderNameTemplateImage'], title: 'Name template for converted images saved in the same folder', subtitle: '', keywords: ['%f', 'webp', 'heic', 'jpeg', 'conversion', 'rename', 'naming', 'pattern', 'leftover', 'variables', 'manual convert'], tab: 'files', section: 'Images', ui: { control: 'nameTemplate', kind: 'image', mode: 'converted', when: [['convertedImageBehaviour', 'sameFolder'], ['manualConvertedImageBehaviour', 'sameFolder']] } },
  { id: 'files.images.convertedSpecificFolderNameTemplateImage', keys: ['convertedSpecificFolderNameTemplateImage'], title: 'Path template for converted images saved in a specific folder', subtitle: '', keywords: ['%P', '%f', 'webp', 'heic', 'jpeg', 'conversion', 'destination', 'output path', 'subfolder', 'naming', 'manual convert'], tab: 'files', section: 'Images', ui: { control: 'pathTemplate', kind: 'image', mode: 'converted', when: [['convertedImageBehaviour', 'specificFolder'], ['manualConvertedImageBehaviour', 'specificFolder']] } },

  // files › Videos
  { id: 'files.videos.optimisedVideoBehaviour', keys: ['optimisedVideoBehaviour'], title: 'Optimised file placement', subtitle: 'Where the smaller file is saved, and whether it replaces the original', keywords: ['placement', 'where', 'save', 'saved', 'replace', 'original', 'in place', 'copy', 'same folder', 'specific folder', 'overwrite', 'output'], tab: 'files', section: 'Videos', ui: { control: 'select', labels: [['temporary', 'Temporary folder'], ['inPlace', 'In place (replace original)'], ['sameFolder', 'Same folder as original'], ['specificFolder', 'Specific folder']] } },
  { id: 'files.videos.sameFolderNameTemplateVideo', keys: ['sameFolderNameTemplateVideo'], title: 'Name template for optimised videos saved in the same folder', subtitle: '', keywords: ['pattern', 'rename', 'filename', 'suffix', 'counter', 'date', 'clop', 'placeholder', 'token', 'variables'], tab: 'files', section: 'Videos', ui: { control: 'nameTemplate', kind: 'video', mode: 'optimised', when: [['optimisedVideoBehaviour', 'sameFolder']] } },
  { id: 'files.videos.specificFolderNameTemplateVideo', keys: ['specificFolderNameTemplateVideo'], title: 'Path template for optimised videos saved in a specific folder', subtitle: '', keywords: ['destination', 'output directory', 'subfolder', 'pattern', 'rename', 'filename', 'where', 'placeholder', 'token', 'location'], tab: 'files', section: 'Videos', ui: { control: 'pathTemplate', kind: 'video', mode: 'optimised', when: [['optimisedVideoBehaviour', 'specificFolder']] } },
  { id: 'files.videos.convertedVideoBehaviour', keys: ['convertedVideoBehaviour'], title: 'Auto-conversion behaviour for compatible formats', subtitle: 'Formats that many apps cannot open well are converted to a widely supported one automatically before optimising.', keywords: ['mov', 'mkv', 'webm', 'mp4', 'convert', 'conversion', 'replace', 'original', 'in place', 'copy', 'keep', 'leftover', 'beside', 'automatic', 'compatibility'], tab: 'files', section: 'Videos', ui: { control: 'select', labels: [['temporary', 'Temporary folder'], ['inPlace', 'In place (replace original)'], ['sameFolder', 'Same folder as original'], ['specificFolder', 'Specific folder']] } },
  { id: 'files.videos.manualConvertedVideoBehaviour', keys: ['manualConvertedVideoBehaviour'], title: 'Manual conversion behaviour', subtitle: 'When you pick a new format by clicking the file extension on a floating result, or via the submenu Convert to... in the right-click menu.', keywords: ['convert to', 'manual', 'right click', 'extension', 'click', 'replace', 'original', 'in place', 'copy'], tab: 'files', section: 'Videos', ui: { control: 'select', labels: [['temporary', 'Temporary folder'], ['inPlace', 'In place (replace original)'], ['sameFolder', 'Same folder as original'], ['specificFolder', 'Specific folder']] } },
  { id: 'files.videos.convertedSameFolderNameTemplateVideo', keys: ['convertedSameFolderNameTemplateVideo'], title: 'Name template for converted videos saved in the same folder', subtitle: '', keywords: ['mp4', 'mov', 'pattern', 'rename', 'filename', 'suffix', 'leftover', 'duplicate', 'placeholder', 'token'], tab: 'files', section: 'Videos', ui: { control: 'nameTemplate', kind: 'video', mode: 'converted', when: [['convertedVideoBehaviour', 'sameFolder'], ['manualConvertedVideoBehaviour', 'sameFolder']] } },
  { id: 'files.videos.convertedSpecificFolderNameTemplateVideo', keys: ['convertedSpecificFolderNameTemplateVideo'], title: 'Path template for converted videos saved in a specific folder', subtitle: '', keywords: ['mp4', 'mov', 'destination', 'output directory', 'subfolder', 'pattern', 'where', 'placeholder', 'token', 'location'], tab: 'files', section: 'Videos', ui: { control: 'pathTemplate', kind: 'video', mode: 'converted', when: [['convertedVideoBehaviour', 'specificFolder'], ['manualConvertedVideoBehaviour', 'specificFolder']] } },

  // files › Audio
  { id: 'files.audio.optimisedAudioBehaviour', keys: ['optimisedAudioBehaviour'], title: 'Optimised file placement', subtitle: 'Where the smaller file is saved, and whether it replaces the original', keywords: ['placement', 'where', 'save', 'saved', 'replace', 'original', 'in place', 'copy', 'same folder', 'specific folder', 'overwrite', 'output'], tab: 'files', section: 'Audio', ui: { control: 'select', labels: [['temporary', 'Temporary folder'], ['inPlace', 'In place (replace original)'], ['sameFolder', 'Same folder as original'], ['specificFolder', 'Specific folder']] } },
  { id: 'files.audio.sameFolderNameTemplateAudio', keys: ['sameFolderNameTemplateAudio'], title: 'Name template for optimised audio saved in the same folder', subtitle: '', keywords: ['filename', 'rename', 'pattern', '%f', 'variables', 'placeholder', 'same folder', 'placement', 'copy', 'beside', 'next to'], tab: 'files', section: 'Audio', ui: { control: 'nameTemplate', kind: 'audio', mode: 'optimised', when: [['optimisedAudioBehaviour', 'sameFolder']] } },
  { id: 'files.audio.specificFolderNameTemplateAudio', keys: ['specificFolderNameTemplateAudio'], title: 'Path template for optimised audio saved in a specific folder', subtitle: '', keywords: ['filename', 'rename', 'pattern', '%p', '%f', 'variables', 'placeholder', 'specific folder', 'placement', 'destination', 'output'], tab: 'files', section: 'Audio', ui: { control: 'pathTemplate', kind: 'audio', mode: 'optimised', when: [['optimisedAudioBehaviour', 'specificFolder']] } },
  { id: 'files.audio.convertedAudioBehaviour', keys: ['convertedAudioBehaviour'], title: 'Auto-conversion behaviour for compatible formats', subtitle: 'Formats that many apps cannot open well are converted to a widely supported one automatically before optimising.', keywords: ['wav', 'aiff', 'flac', 'aac', 'mp3', 'convert', 'conversion', 'replace', 'original', 'in place', 'copy', 'keep', 'beside', 'automatic', 'compatibility'], tab: 'files', section: 'Audio', ui: { control: 'select', labels: [['temporary', 'Temporary folder'], ['inPlace', 'In place (replace original)'], ['sameFolder', 'Same folder as original'], ['specificFolder', 'Specific folder']] } },
  { id: 'files.audio.manualConvertedAudioBehaviour', keys: ['manualConvertedAudioBehaviour'], title: 'Manual conversion behaviour', subtitle: 'When you pick a new format by clicking the file extension on a floating result, or via the submenu Convert to... in the right-click menu.', keywords: ['convert to', 'manual', 'right click', 'extension', 'click', 'replace', 'original', 'in place', 'copy'], tab: 'files', section: 'Audio', ui: { control: 'select', labels: [['temporary', 'Temporary folder'], ['inPlace', 'In place (replace original)'], ['sameFolder', 'Same folder as original'], ['specificFolder', 'Specific folder']] } },
  { id: 'files.audio.convertedSameFolderNameTemplateAudio', keys: ['convertedSameFolderNameTemplateAudio'], title: 'Name template for converted audio saved in the same folder', subtitle: '', keywords: ['filename', 'rename', 'pattern', '%f', 'conversion', 'wav', 'mp3', 'aac', 'variables', 'placeholder', 'same folder', 'beside'], tab: 'files', section: 'Audio', ui: { control: 'nameTemplate', kind: 'audio', mode: 'converted', when: [['convertedAudioBehaviour', 'sameFolder'], ['manualConvertedAudioBehaviour', 'sameFolder']] } },
  { id: 'files.audio.convertedSpecificFolderNameTemplateAudio', keys: ['convertedSpecificFolderNameTemplateAudio'], title: 'Path template for converted audio saved in a specific folder', subtitle: '', keywords: ['filename', 'rename', 'pattern', '%p', '%f', 'conversion', 'wav', 'mp3', 'variables', 'placeholder', 'specific folder', 'destination', 'output'], tab: 'files', section: 'Audio', ui: { control: 'pathTemplate', kind: 'audio', mode: 'converted', when: [['convertedAudioBehaviour', 'specificFolder'], ['manualConvertedAudioBehaviour', 'specificFolder']] } },

  // files › PDF
  { id: 'files.pdf.optimisedPDFBehaviour', keys: ['optimisedPDFBehaviour'], title: 'Optimised file placement', subtitle: 'Where the smaller file is saved, and whether it replaces the original', keywords: ['placement', 'where', 'save', 'saved', 'replace', 'original', 'in place', 'copy', 'same folder', 'specific folder', 'overwrite', 'output'], tab: 'files', section: 'PDF', ui: { control: 'select', labels: [['temporary', 'Temporary folder'], ['inPlace', 'In place (replace original)'], ['sameFolder', 'Same folder as original'], ['specificFolder', 'Specific folder']] } },
  { id: 'files.pdf.sameFolderNameTemplatePDF', keys: ['sameFolderNameTemplatePDF'], title: 'Name template for optimised PDFs saved in the same folder', subtitle: '', keywords: ['filename', 'rename', 'pattern', 'suffix', 'optimised', 'tokens', 'next to', 'beside', 'overwrite', 'copy'], tab: 'files', section: 'PDF', ui: { control: 'nameTemplate', kind: 'pdf', mode: 'optimised', when: [['optimisedPDFBehaviour', 'sameFolder']] } },
  { id: 'files.pdf.specificFolderNameTemplatePDF', keys: ['specificFolderNameTemplatePDF'], title: 'Path template for optimised PDFs saved in a specific folder', subtitle: '', keywords: ['path', 'filename', 'rename', 'pattern', 'destination', 'output', 'tokens', 'where do they go', 'subfolder'], tab: 'files', section: 'PDF', ui: { control: 'pathTemplate', kind: 'pdf', mode: 'optimised', when: [['optimisedPDFBehaviour', 'specificFolder']] } },

  // video › Watch paths
  { id: 'video.watchpaths.videoDirs', keys: ['videoDirs'], title: 'Watch paths', subtitle: 'Optimise videos as they appear in these folders', keywords: ['directory', 'desktop', 'downloads', 'monitor', 'automatic', 'add', 'clopignore', 'ignore rules', 'not picking up', 'nothing happens', 'unwatched'], tab: 'video', section: 'Watch paths', ui: { control: 'dirs', kind: 'video' } },
  { id: 'video.watchpaths.enableAutomaticVideoOptimisations', keys: ['enableAutomaticVideoOptimisations'], title: 'Enable video auto-optimiser', subtitle: '', keywords: ['watch', 'folders', 'background', 'monitor', 'stopped working', 'disabled', 'paused', 'desktop', 'nothing happens', 'turn off'], tab: 'video', section: 'Watch paths' },

  // video › Optimisation rules
  { id: 'video.optimisationrules.videoCompression', keys: ['videoCompression'], title: 'Compression', subtitle: '', keywords: ['encoder', 'hardware', 'software', 'adaptive', 'visually lossless', 'quality', 'crf', 'bitrate', 'factor', 'auto', 'slower', 'cpu', 'battery', 'smaller size', 'better quality'], tab: 'video', section: 'Optimisation rules', ui: { control: 'compression', kind: 'video' } },
  { id: 'video.optimisationrules.videoEncoder', keys: ['videoEncoder'], title: 'Encoder', subtitle: 'Which encoder compresses videos; Automatic picks a hardware encoder when one is available', keywords: ['h264', 'h265', 'hevc', 'x264', 'x265', 'nvenc', 'nvidia', 'qsv', 'intel', 'amd', 'amf', 'gpu', 'hardware', 'software', 'codec'], tab: 'video', section: 'Optimisation rules', ui: { control: 'select', labels: [['auto', 'Automatic'], ['libx264', 'H.264 (software)'], ['libx265', 'H.265 / HEVC (software)'], ['h264_nvenc', 'H.264 (NVIDIA)'], ['hevc_nvenc', 'H.265 / HEVC (NVIDIA)'], ['h264_qsv', 'H.264 (Intel Quick Sync)'], ['hevc_qsv', 'H.265 / HEVC (Intel Quick Sync)'], ['h264_amf', 'H.264 (AMD)'], ['hevc_amf', 'H.265 / HEVC (AMD)']] } },
  { id: 'video.optimisationrules.adaptiveVideoSize', keys: ['adaptiveVideoSize'], title: 'Adaptive size', subtitle: 'Pick the amount of compression for each video from its contents', keywords: ['adaptive', 'automatic', 'per file', 'smart'], tab: 'video', section: 'Optimisation rules' },
  { id: 'video.optimisationrules.removeAudioFromVideos', keys: ['removeAudioFromVideos'], title: 'Remove audio on optimised videos', subtitle: '', keywords: ['mute', 'silent', 'sound', 'audio track', 'strip'], tab: 'video', section: 'Optimisation rules' },
  { id: 'video.optimisationrules.capVideoFPS', keys: ['capVideoFPS', 'targetVideoFPS'], title: 'Cap frames per second', subtitle: '', keywords: ['fps', 'frame rate', 'frames per second', '30fps', '60fps', 'smooth', 'slow', 'half', 'quarter', '1/2 of source', '1/4 of source', 'choppy', 'screen recording', 'stuttering'], tab: 'video', section: 'Optimisation rules', ui: { control: 'fpsCap' } },
  { id: 'video.optimisationrules.minVideoFPS', keys: ['minVideoFPS'], title: 'but no less than', subtitle: '', keywords: ['fps', 'minimum', 'floor', '10fps', '24fps', '30fps', '60fps', '1/2 of source', '1/4 of source', 'fraction', 'frame rate', 'too slow', 'choppy', 'stuttering'], tab: 'video', section: 'Optimisation rules', ui: { control: 'minFps', when: [['capVideoFPS', true]] } },
  { id: 'video.optimisationrules.playbackSpeedFrameBehaviour', keys: ['playbackSpeedFrameBehaviour'], title: 'Playback speed change', subtitle: 'Whether changing speed drops frames or re-times them', keywords: [], tab: 'video', section: 'Optimisation rules', ui: { control: 'select', labels: [['keepFrames', 'Keep frames (smoother, higher fps)'], ['dropFrames', 'Drop frames (smaller file)']] } },

  // video › Watched file filters
  { id: 'video.watchedfilefilters.minVideoSizeKB', keys: ['minVideoSizeKB', 'maxVideoSizeMB'], title: 'File size', subtitle: 'Only optimises files between the set sizes', keywords: ['mb', 'kb', 'gb', 'skipped', 'ignored', 'too big', 'too large', 'too small', 'threshold', 'limit', 'range', 'untouched'], tab: 'video', section: 'Watched file filters', ui: { control: 'sizeRange', kind: 'video' } },
  { id: 'video.watchedfilefilters.minVideoResolution', keys: ['minVideoResolution', 'maxVideoResolution'], title: 'Resolution', subtitle: 'Only optimises files with width and height between the set values', keywords: ['px', 'pixels', '4k', '1080p', 'tiny', 'thumbnail', 'upscaled', 'skipped', 'ignored', 'threshold', 'limit', 'range', 'dimensions'], tab: 'video', section: 'Watched file filters', ui: { control: 'resolutionRange', kind: 'video' } },
  { id: 'video.watchedfilefilters.maxVideoFileCount', keys: ['maxVideoFileCount'], title: 'File count', subtitle: 'Skips optimisation when more than this many files are copied or moved at once', keywords: ['batch', 'bulk', 'drag', 'import', 'multiple', 'dozens', 'threshold', 'limit', 'nothing happens', 'ignored'], tab: 'video', section: 'Watched file filters', ui: { control: 'number', unit: 'files' } },
  { id: 'video.watchedfilefilters.videoFormatsToSkip', keys: ['videoFormatsToSkip'], title: 'Ignore videos with extension', subtitle: '', keywords: ['mkv', 'm4v', 'avi', 'webm', 'mov', 'mp4', 'mpeg', 'skip', 'exclude', 'deny list', 'format', 'untouched', 'left alone'], tab: 'video', section: 'Watched file filters', ui: { control: 'formats' } },

  // video › Compatibility
  { id: 'video.compatibility.formatsToConvertToMP4', keys: ['formatsToConvertToMP4'], title: 'Convert to mp4', subtitle: '', keywords: ['mov', 'webm', 'mkv', 'avi', 'mpeg', 'm4v', 'quicktime', 'container', 'remux', 'incompatible', 'cannot open', 'unsupported', 'automatic'], tab: 'video', section: 'Compatibility', ui: { control: 'formats' } },
  { id: 'video.compatibility.convertAudioToAAC', keys: ['convertAudioToAAC'], title: 'Convert audio to AAC', subtitle: 'Re-encode a video\'s audio track to AAC for compatibility', keywords: [], tab: 'video', section: 'Compatibility' },

  // audio › Watch paths
  { id: 'audio.watchpaths.audioDirs', keys: ['audioDirs'], title: 'Watch paths', subtitle: 'Optimise audio files as they appear in these folders', keywords: ['folder', 'directory', 'watched', 'monitor', 'add folder', 'incoming', 'music', 'downloads', 'automatic', 'clopignore', 'ignore rules', 'path list'], tab: 'audio', section: 'Watch paths', ui: { control: 'dirs', kind: 'audio' } },
  { id: 'audio.watchpaths.enableAutomaticAudioOptimisations', keys: ['enableAutomaticAudioOptimisations'], title: 'Enable audio auto-optimiser', subtitle: '', keywords: ['watch', 'watcher', 'folder', 'automatic', 'background', 'turn on', 'turn off', 'disable', 'stop', 'not optimising', 'nothing happens'], tab: 'audio', section: 'Watch paths' },

  // audio › Optimisation rules
  { id: 'audio.optimisationrules.audioFormat', keys: ['audioFormat'], title: 'Output format', subtitle: 'The format optimised audio files are saved in', keywords: ['aac', 'm4a', 'mp3', 'opus', 'wav', 'flac', 'aiff', 'codec', 'convert', 'same as input'], tab: 'audio', section: 'Optimisation rules', ui: { pending: 'the format follows the Convert to AAC and MP3 lists', control: 'select', labels: [['sameAsInput', 'Same as input'], ['aac', 'AAC (M4A)'], ['mp3', 'MP3'], ['opus', 'Opus'], ['wav', 'WAV'], ['flac', 'FLAC'], ['aiff', 'AIFF']] } },
  { id: 'audio.optimisationrules.audioCompression', keys: ['audioCompression'], title: 'Compression', subtitle: 'WAV, AIFF and FLAC are lossless, so the compression factor does not apply to them.', keywords: ['quality', 'bitrate', 'kbps', 'percent', 'slider', 'smaller', 'file size', 'vbr', 'variable bitrate', 'aac', 'mp3', 'lossy', 'aggressive'], tab: 'audio', section: 'Optimisation rules', ui: { control: 'compression', kind: 'audio' } },
  { id: 'audio.optimisationrules.audioCoverArt', keys: ['audioCoverArt'], title: 'Cover art', subtitle: 'Cover art is kept only for formats that can store it (AAC, MP3, FLAC); it is dropped for others.', keywords: ['artwork', 'thumbnail', 'picture', 'embedded', 'id3', 'm4a', 'strip', 'remove', 'metadata', 'tag', 'album'], tab: 'audio', section: 'Optimisation rules', ui: { control: 'select', labels: [['optimise', 'Optimise'], ['remove', 'Remove'], ['keep', 'Keep']] } },

  // audio › Watched file filters
  { id: 'audio.watchedfilefilters.minAudioSizeKB', keys: ['minAudioSizeKB', 'maxAudioSizeMB'], title: 'File size', subtitle: '', keywords: ['skip', 'skipped', 'ignore', 'threshold', 'too big', 'too small', 'limit', 'range', 'mb', 'kb', 'large', 'small', 'podcast', 'untouched'], tab: 'audio', section: 'Watched file filters', ui: { control: 'sizeRange', kind: 'audio' } },
  { id: 'audio.watchedfilefilters.maxAudioFileCount', keys: ['maxAudioFileCount'], title: 'File count', subtitle: 'Skips optimisation when more than this many files are copied or moved at once', keywords: ['batch', 'bulk', 'many', 'at once', 'limit', 'skip', 'copied', 'moved', 'album', 'import', 'nothing happens', 'too many'], tab: 'audio', section: 'Watched file filters', ui: { control: 'number', unit: 'files' } },
  { id: 'audio.watchedfilefilters.audioFormatsToSkip', keys: ['audioFormatsToSkip'], title: 'Ignore audio with extension', subtitle: 'Audio files with these extensions are left alone', keywords: ['skip', 'exclude', 'deny list', 'format', 'untouched', 'left alone', 'mp3', 'flac', 'wav'], tab: 'audio', section: 'Watched file filters', ui: { control: 'formats' } },

  // audio › Compatibility
  { id: 'audio.compatibility.formatsToConvertToAAC', keys: ['formatsToConvertToAAC'], title: 'Convert to AAC (M4A)', subtitle: '', keywords: ['m4a', 'flac', 'aiff', 'wav', 'lossless', 'target', 'output', 'pills', 'toggle', 're-encode', 'exclusive'], tab: 'audio', section: 'Compatibility', ui: { control: 'formats' } },
  { id: 'audio.compatibility.formatsToConvertToMP3', keys: ['formatsToConvertToMP3'], title: 'Convert to MP3', subtitle: '', keywords: ['wav', 'flac', 'aiff', 'lossless', 'target', 'output', 'pills', 'toggle', 're-encode', 'exclusive'], tab: 'audio', section: 'Compatibility', ui: { control: 'formats' } },
  { id: 'audio.compatibility.formatsToConvertToOutputAudio', keys: ['formatsToConvertToOutputAudio'], title: 'Convert to the output format', subtitle: 'Audio in these formats is converted to the output format chosen above before optimisation', keywords: ['convert', 're-encode', 'wav', 'aiff', 'flac', 'target', 'output', 'lossless'], tab: 'audio', section: 'Compatibility', ui: { control: 'formats' } },

  // images › Watch paths
  { id: 'images.watchpaths.imageDirs', keys: ['imageDirs'], title: 'Watch paths', subtitle: 'Optimise images as they appear in these folders', keywords: ['directories', 'desktop', 'downloads', 'screenshots', 'monitor', 'automatic', 'clopignore', 'ignore rules', 'per-folder', 'add', 'remove'], tab: 'images', section: 'Watch paths', ui: { control: 'dirs', kind: 'image' } },
  { id: 'images.watchpaths.enableAutomaticImageOptimisations', keys: ['enableAutomaticImageOptimisations'], title: 'Enable image auto-optimiser', subtitle: '', keywords: ['watch', 'folder', 'background', 'screenshots', 'stopped working', 'nothing happens', 'turn off', 'pause', 'monitor', 'checkbox'], tab: 'images', section: 'Watch paths' },
  { id: 'images.watchpaths.dirsHideFloatingResult', keys: ['dirsHideFloatingResult'], title: 'Show floating results', subtitle: 'Show the floating result when files in a watched folder are optimised: untick a folder to optimise it quietly', keywords: ['watched', 'silent', 'quiet', 'hide', 'no popup', 'background', 'checkbox', 'column', 'notification', 'per directory'], tab: 'images', section: 'Watch paths', ui: { control: 'embedded', within: 'images.watchpaths.imageDirs' } },

  // images › File name handling
  { id: 'images.filenamehandling.copyImageFilePath', keys: ['copyImageFilePath'], title: 'Copy image paths', subtitle: 'When copying optimised image data, also put the path of the image file on the clipboard', keywords: [], tab: 'images', section: 'File name handling' },
  { id: 'images.filenamehandling.useCustomNameTemplateForClipboardImages', keys: ['useCustomNameTemplateForClipboardImages'], title: 'Use a name template for clipboard images', subtitle: '', keywords: [], tab: 'images', section: 'File name handling' },
  { id: 'images.main.customNameTemplateForClipboardImages', keys: ['customNameTemplateForClipboardImages'], title: 'Name template for clipboard images', subtitle: 'Pattern for naming images saved from the clipboard', keywords: [], tab: 'images', section: 'File name handling', ui: { control: 'nameTemplate', kind: 'image', mode: 'clipboard', when: [['useCustomNameTemplateForClipboardImages', true]] } },

  // images › Optimisation rules
  { id: 'images.optimisationrules.imageCompression', keys: ['imageCompression'], title: 'Compression', subtitle: '', keywords: ['quality', 'factor', 'percent', 'slider', 'adaptive', 'lossy', 'aggressive', 'smaller', 'blurry', 'artifacts', 'entropy', 'jpeg', 'png', 'file size'], tab: 'images', section: 'Optimisation rules', ui: { control: 'compression', kind: 'image' } },
  { id: 'images.optimisationrules.defaultImageFormat', keys: ['defaultImageFormat'], title: 'Default format', subtitle: 'The format new image results are saved in; Keep original format leaves the format alone', keywords: ['png', 'jpeg', 'jpg', 'webp', 'avif', 'gif', 'convert', 'format', 'output'], tab: 'images', section: 'Optimisation rules', ui: { control: 'select', labels: [['auto', 'Keep original format'], ['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP'], ['avif', 'AVIF'], ['gif', 'GIF']] } },
  { id: 'images.optimisationrules.gifFrameDropBehaviour', keys: ['gifFrameDropBehaviour'], title: 'GIF frame dropping', subtitle: 'Compression factors above 80% drop every 4th, 3rd or 2nd frame of animated GIFs. The animation can either play faster with the remaining frames, or keep its duration by showing each frame longer', keywords: ['gif', 'animation', 'frames', 'drop', 'choppy', 'smooth'], tab: 'images', section: 'Optimisation rules', ui: { control: 'select', labels: [['playFaster', 'Play faster (shorter GIF)'], ['keepDuration', 'Keep duration (slower playback)']] } },
  { id: 'images.optimisationrules.convertHDRToSDR', keys: ['convertHDRToSDR'], title: 'Convert HDR to SDR', subtitle: '', keywords: ['hdr', 'sdr', 'gain map', 'xdr', 'highlights', 'brightness', 'tone mapping', 'file size'], tab: 'images', section: 'Optimisation rules' },

  // images › Watched file filters
  { id: 'images.watchedfilefilters.minImageSizeKB', keys: ['minImageSizeKB', 'maxImageSizeMB'], title: 'File size', subtitle: '', keywords: ['skip', 'limit', 'range', 'kb', 'mb', 'bytes', 'megabytes', 'too small', 'too large', 'threshold', 'ignore', 'not optimised'], tab: 'images', section: 'Watched file filters', ui: { control: 'sizeRange', kind: 'image' } },
  { id: 'images.watchedfilefilters.minImageResolution', keys: ['minImageResolution', 'maxImageResolution'], title: 'Resolution', subtitle: '', keywords: ['pixels', 'px', 'width', 'height', 'dimensions', 'skip', 'limit', 'range', 'icons', 'thumbnails', 'huge', 'ignore'], tab: 'images', section: 'Watched file filters', ui: { control: 'resolutionRange', kind: 'image' } },
  { id: 'images.watchedfilefilters.maxImageFileCount', keys: ['maxImageFileCount'], title: 'File count', subtitle: 'Skips optimisation when more than this many files are copied or moved at once', keywords: ['batch', 'bulk', 'how many', 'at once', 'copied at once', 'moved at once', 'limit', 'threshold', 'skip', 'mass copy'], tab: 'images', section: 'Watched file filters', ui: { control: 'number', unit: 'files' } },
  { id: 'images.watchedfilefilters.imageFormatsToSkip', keys: ['imageFormatsToSkip'], title: 'Ignore images with extension', subtitle: '', keywords: ['tiff', 'psd', 'raw', 'skip', 'exclude', 'never optimise', 'leave alone', 'format', 'blacklist', 'deny list'], tab: 'images', section: 'Watched file filters', ui: { control: 'formats' } },

  // images › Compatibility
  { id: 'images.compatibility.formatsToConvertToJPEG', keys: ['formatsToConvertToJPEG'], title: 'Convert to jpeg', subtitle: '', keywords: ['webp', 'avif', 'heic', 'bmp', 'jxl', 'tiff', 'compatibility', 'cannot open', 'unsupported', 'automatic', 'before optimisation'], tab: 'images', section: 'Compatibility', ui: { control: 'formats' } },
  { id: 'images.compatibility.formatsToConvertToPNG', keys: ['formatsToConvertToPNG'], title: 'Convert to png', subtitle: '', keywords: ['tiff', 'bmp', 'webp', 'avif', 'heic', 'jxl', 'transparency', 'alpha', 'lossless', 'compatibility', 'unsupported', 'cannot open'], tab: 'images', section: 'Compatibility', ui: { control: 'formats' } },

  // pdf › Watch paths
  { id: 'pdf.watchpaths.pdfDirs', keys: ['pdfDirs'], title: 'Watch paths', subtitle: 'Optimise PDFs as they appear in these folders', keywords: ['directories', 'monitor', 'downloads', 'desktop', 'clopignore', 'ignore rules', 'drop', 'incoming'], tab: 'pdf', section: 'Watch paths', ui: { control: 'dirs', kind: 'pdf' } },
  { id: 'pdf.watchpaths.enableAutomaticPDFOptimisations', keys: ['enableAutomaticPDFOptimisations'], title: 'Enable PDF auto-optimiser', subtitle: '', keywords: ['watch', 'folder', 'background', 'monitor', 'turn off', 'disable', 'stop', 'incoming', 'downloads', 'not optimising'], tab: 'pdf', section: 'Watch paths' },

  // pdf › Optimisation rules
  { id: 'pdf.optimisationrules.pdfDPI', keys: ['pdfDPI'], title: 'Compression', subtitle: 'Clop automatically picks a per-PDF DPI from the source image density and downscales images above it', keywords: ['resolution', 'quality', 'adaptive', 'scanned', 'lossless', '150', '300', 'blurry', 'ghostscript', 'shrink', 'smaller', 'file size', 'text quality', 'pixelated'], tab: 'pdf', section: 'Optimisation rules', ui: { control: 'pdfDpi' } },

  // pdf › Watched file filters
  { id: 'pdf.watchedfilefilters.minPDFSizeKB', keys: ['minPDFSizeKB', 'maxPDFSizeMB'], title: 'File size', subtitle: '', keywords: ['skip', 'too big', 'too small', 'ignored', 'limit', 'minimum', 'maximum', 'mb', 'kb', 'range', 'large', 'huge', 'not optimised'], tab: 'pdf', section: 'Watched file filters', ui: { control: 'sizeRange', kind: 'pdf' } },
  { id: 'pdf.watchedfilefilters.maxPDFFileCount', keys: ['maxPDFFileCount'], title: 'File count', subtitle: 'Skips optimisation when more than this many files are copied or moved at once', keywords: ['batch', 'bulk', 'threshold', 'ignored', 'watched folder', 'nothing happened', 'limit', 'multiple files'], tab: 'pdf', section: 'Watched file filters', ui: { control: 'number', unit: 'files' } },

  // dropzone › Drop zone
  { id: 'dropzone.dropzone.enableDragAndDrop', keys: ['enableDragAndDrop'], title: 'Enable drop zone', subtitle: 'Allows dragging files, paths and URLs to a global drop zone for optimisation', keywords: ['drop zone', 'drag', 'drop'], tab: 'dropzone', section: 'Drop zone' },
  { id: 'dropzone.dropzone.keepDropZoneVisible', keys: ['keepDropZoneVisible'], title: 'Keep drop zone visible', subtitle: 'Leave the drop zone on screen without dragging', keywords: ['pinned', 'pin', 'always visible', 'show', 'sticky'], tab: 'dropzone', section: 'Drop zone' },
  { id: 'dropzone.dropzone.onlyShowDropZoneOnOption', keys: ['onlyShowDropZoneOnOption'], title: 'Require pressing Alt to show drop zone', subtitle: 'Hide the drop zone by default to avoid distractions while dragging files, show it by holding Alt', keywords: ['alt', 'option', 'modifier', 'hold', 'distraction', 'hide'], tab: 'dropzone', section: 'Drop zone', ui: { pending: 'the drop zone does not read it' } },
  { id: 'dropzone.dropzone.autoCopyToClipboard', keys: ['autoCopyToClipboard'], title: 'Auto Copy optimised files to clipboard', subtitle: 'Copy files resulting from drop zone or file watch optimisation so they can be pasted right after optimisation ends', keywords: [], tab: 'dropzone', section: 'Drop zone' },

  // dropzone › Batch mode
  { id: 'dropzone.batchmode.useBatchModeForFolders', keys: ['useBatchModeForFolders'], title: 'Use batch mode for large drops', subtitle: 'Dropping many files at once (or a folder with many files) opens a single batch window that optimises them all efficiently. Originals are backed up first and can be restored.', keywords: [], tab: 'dropzone', section: 'Batch mode' },
  { id: 'dropzone.batchmode.batchModeFileCountThreshold', keys: ['batchModeFileCountThreshold'], title: 'Batch mode file threshold', subtitle: 'Drops with more files than this use batch mode', keywords: [], tab: 'dropzone', section: 'Batch mode', ui: { control: 'number', unit: 'files', when: [['useBatchModeForFolders', true]] } },

  // dropzone › Automation
  { id: 'dropzone.automation.dropZoneAutomation', keys: [], title: 'Drop zone automation', subtitle: 'Run actions on files dropped here: convert, crop, copy, rename and more', keywords: ['pipeline', 'pipelines', 'automation', 'drop', 'actions'], tab: 'dropzone', section: 'Automation', ui: { control: 'sourceAutomation', source: 'dropZone' } },

  // presetZones › Showing preset zones
  { id: 'presetZones.showingpresetzones.onlyShowPresetZonesOnControlTapped', keys: ['onlyShowPresetZonesOnControlTapped'], title: 'Show preset zones by holding or tapping Control', subtitle: 'Hold reveals them while the key is down; tap leaves them up', keywords: [], tab: 'presetZones', section: 'Showing preset zones' },

  // presetZones › Preset zones
  { id: 'presetZones.presetzones.presetZones', keys: ['presetZones'], title: 'Preset zones', subtitle: 'Click a zone to assign or create a pipeline. Drag files onto a zone to run its actions.', keywords: ['drop target', 'quadrant', 'corner', 'control key', 'image', 'video', 'audio', 'pdf', 'automation'], tab: 'presetZones', section: 'Preset zones', ui: { control: 'presetZones' } },

  // floating › main
  { id: 'floating.main.enableFloatingResults', keys: ['enableFloatingResults'], title: 'Show floating results', subtitle: 'Disabling this will make Clop run in an UI-less mode, but keep optimising files in the background. Drop zone can be disabled separately in the Drop zone tab', keywords: [], tab: 'floating', section: '', ui: { pending: 'floating results use fixed layout and timings' } },
  { id: 'floating.main.floatingResultActions', keys: ['floatingResultActions'], title: 'Action buttons', subtitle: '', keywords: ['floating result', 'grid', 'icons', 'share', 'preview', 'customise', 'reorder', 'remove', 'add', 'toolbar', 'send securely', 'aggressive', 'downscale'], tab: 'floating', section: '', ui: { control: 'actions', layout: 'floating' } },
  { id: 'floating.main.compactResultActions', keys: ['compactResultActions'], title: 'Side actions', subtitle: '', keywords: ['compact result', 'icons', 'buttons', 'row', 'customise', 'add', 'remove', 'preview', 'share', 'crop', 'show in explorer', 'save as'], tab: 'floating', section: '', ui: { control: 'actions', layout: 'compact' } },

  // floating › Layout
  { id: 'floating.layout.floatingResultsCorner', keys: ['floatingResultsCorner'], title: 'Position on screen', subtitle: 'Which corner floating results appear in', keywords: [], tab: 'floating', section: 'Layout', ui: { control: 'select', labels: [['bottomRight', 'Bottom right'], ['bottomLeft', 'Bottom left'], ['topRight', 'Top right'], ['topLeft', 'Top left']] } },
  { id: 'floating.layout.floatingResultsAlwaysOnTop', keys: ['floatingResultsAlwaysOnTop'], title: 'Keep results above other windows', subtitle: 'Floating results stay on top of the windows you work in', keywords: ['always on top', 'topmost', 'pin', 'float', 'overlay', 'z-order'], tab: 'floating', section: 'Layout' },
  { id: 'floating.layout.followCursorScreen', keys: ['followCursorScreen'], title: 'Follow the cursor across screens', subtitle: 'When the cursor stays on another screen for a couple of seconds, move the results to that screen', keywords: [], tab: 'floating', section: 'Layout', ui: { pending: 'floating results use fixed layout and timings' } },
  { id: 'floating.layout.hideFloatingResultTooltips', keys: ['hideFloatingResultTooltips'], title: 'Hide button tooltips', subtitle: 'Don\'t show the action name labels that pop up while hovering result buttons', keywords: [], tab: 'floating', section: 'Layout' },
  { id: 'floating.layout.alwaysShowCompactResults', keys: ['alwaysShowCompactResults'], title: 'Always use compact layout', subtitle: 'By default, the layout switches to compact automatically when there are more than 5 results on the screen', keywords: [], tab: 'floating', section: 'Layout' },

  // floating › Full layout
  { id: 'floating.fulllayout.formatPickerStyle', keys: ['formatPickerStyle'], title: 'Change format by', subtitle: 'How the format control on a floating result behaves', keywords: [], tab: 'floating', section: 'Full layout', ui: { control: 'select', labels: [['bar', 'Format bar'], ['extensionHover', 'Extension chip']] } },
  { id: 'floating.fulllayout.showCopyClearButtons', keys: ['showCopyClearButtons'], title: 'Show Copy all and Clear all buttons', subtitle: '', keywords: [], tab: 'floating', section: 'Full layout' },
  { id: 'floating.fulllayout.dismissFloatingResultOnDrop', keys: ['dismissFloatingResultOnDrop'], title: 'Dismiss result on drag and drop outside', subtitle: '', keywords: [], tab: 'floating', section: 'Full layout' },
  { id: 'floating.fulllayout.dismissFloatingResultOnUpload', keys: ['dismissFloatingResultOnUpload'], title: 'Dismiss result on upload', subtitle: '', keywords: [], tab: 'floating', section: 'Full layout', ui: { pending: 'Clop for Windows has no upload' } },
  { id: 'floating.fulllayout.autoHideFloatingResults', keys: ['autoHideFloatingResults'], title: 'Auto hide floating results', subtitle: '', keywords: [], tab: 'floating', section: 'Full layout', ui: { pending: 'floating results use fixed layout and timings' } },
  { id: 'floating.fulllayout.autoHideFloatingResultsAfter', keys: ['autoHideFloatingResultsAfter'], title: 'Auto hide file results after', subtitle: 'Seconds before a file result disappears', keywords: [], tab: 'floating', section: 'Full layout', ui: { pending: 'floating results use fixed layout and timings', control: 'number', unit: 'seconds', when: [['autoHideFloatingResults', true]] } },
  { id: 'floating.fulllayout.autoHideClipboardResultAfter', keys: ['autoHideClipboardResultAfter'], title: 'Auto hide clipboard results after', subtitle: 'Seconds before a clipboard result disappears', keywords: [], tab: 'floating', section: 'Full layout', ui: { pending: 'floating results use fixed layout and timings', control: 'number', unit: 'seconds', when: [['autoHideFloatingResults', true]] } },

  // floating › Compact layout
  { id: 'floating.compactlayout.showCompactImages', keys: ['showCompactImages'], title: 'Show images in compact results', subtitle: '', keywords: [], tab: 'floating', section: 'Compact layout' },
  { id: 'floating.compactlayout.dismissCompactResultOnDrop', keys: ['dismissCompactResultOnDrop'], title: 'Dismiss compact result on drag and drop outside', subtitle: '', keywords: [], tab: 'floating', section: 'Compact layout' },
  { id: 'floating.compactlayout.dismissCompactResultOnUpload', keys: ['dismissCompactResultOnUpload'], title: 'Dismiss compact result on upload', subtitle: '', keywords: [], tab: 'floating', section: 'Compact layout', ui: { pending: 'Clop for Windows has no upload' } },
  { id: 'floating.compactlayout.autoClearAllCompactResultsAfter', keys: ['autoClearAllCompactResultsAfter'], title: 'Auto clear all compact results after', subtitle: 'Seconds before every compact result is cleared', keywords: [], tab: 'floating', section: 'Compact layout', ui: { control: 'number', unit: 'seconds' } },

  // keys › Trigger keys
  { id: 'keys.triggerkeys.keyComboModifiers', keys: ['keyComboModifiers'], title: 'Trigger keys', subtitle: '', keywords: ['modifier', 'modifiers', 'hotkey', 'shortcut', 'control', 'ctrl', 'shift', 'alt', 'windows', 'win', 'hold', 'combo', 'global', 'record'], tab: 'keys', section: 'Trigger keys', ui: { control: 'modifiers' } },

  // keys › Action keys
  { id: 'keys.actionkeys.enabledKeys', keys: ['enabledKeys'], title: 'Action keys', subtitle: '', keywords: ['hotkey', 'shortcut', 'downscale', 'preview', 'rename', 'restore original', 'pause', 'escape', 'dismiss', 'clear all', 'bring back', 'speed up', 'aggressive', 'optimise aggressively', 'optimise clipboard', 'stop', 'paste'], tab: 'keys', section: 'Action keys', ui: { control: 'actionKeys' } },

  // keys › Resize keys
  { id: 'keys.resizekeys.quickResizeKeys', keys: ['quickResizeKeys'], title: 'Resize keys', subtitle: '', keywords: ['downscale', 'percent', 'percentage', '10%', '20%', '90%', 'tens', 'number row', 'hotkey', 'shortcut', 'scale', 'shrink', 'smaller', 'trigger', 'hold', 'quick'], tab: 'keys', section: 'Resize keys', ui: { control: 'resizeKeys' } },

  // pipelines › Saved pipelines
  { id: 'pipelines.savedpipelines.savedPipelines', keys: ['savedPipelines'], title: 'Saved pipelines', subtitle: 'Reusable pipelines available in automation, preset zones and right-click menus', keywords: ['pipeline', 'pipelines', 'steps', 'actions', 'automation', 'editor', 'create', 'workflow', 'macro'], tab: 'pipelines', section: 'Saved pipelines', ui: { control: 'pipelines' } },

  // automation › Automation
  { id: 'automation.automation.pipelinesToRunOnImage', keys: ['pipelinesToRunOnImage'], title: 'Image automation', subtitle: 'Actions run on image files after optimisation, by clipboard and watched folder', keywords: ['pipeline', 'pipelines', 'automation', 'watched folder', 'clipboard', 'actions', 'image'], tab: 'automation', section: 'Automation', ui: { control: 'automation', kind: 'image' } },
  { id: 'automation.automation.pipelinesToRunOnVideo', keys: ['pipelinesToRunOnVideo'], title: 'Video automation', subtitle: 'Actions run on video files after optimisation, by clipboard and watched folder', keywords: ['pipeline', 'pipelines', 'automation', 'watched folder', 'clipboard', 'actions', 'video'], tab: 'automation', section: 'Automation', ui: { control: 'automation', kind: 'video' } },
  { id: 'automation.automation.pipelinesToRunOnAudio', keys: ['pipelinesToRunOnAudio'], title: 'Audio automation', subtitle: 'Actions run on audio files after optimisation, by clipboard and watched folder', keywords: ['pipeline', 'pipelines', 'automation', 'watched folder', 'clipboard', 'actions', 'audio'], tab: 'automation', section: 'Automation', ui: { control: 'automation', kind: 'audio' } },
  { id: 'automation.automation.pipelinesToRunOnPdf', keys: ['pipelinesToRunOnPdf'], title: 'PDF automation', subtitle: 'Actions run on PDF files after optimisation, by clipboard and watched folder', keywords: ['pipeline', 'pipelines', 'automation', 'watched folder', 'clipboard', 'actions', 'pdf'], tab: 'automation', section: 'Automation', ui: { control: 'automation', kind: 'pdf' } },

  // mcp › main
  { id: 'mcp.main.mcpEnabled', keys: ['mcpEnabled'], title: 'Accept changes from agents', subtitle: 'Optimising files, changing settings, saving pipelines. Reading settings and pipelines stays allowed either way', keywords: ['mcp', 'agent', 'ai', 'claude', 'cursor', 'llm', 'automation'], tab: 'mcp', section: '', ui: { control: 'mcpToggle' } },
  { id: 'mcp.main.mcpAllowScriptSteps', keys: ['mcpAllowScriptSteps'], title: 'Allow agents to write script steps', subtitle: 'A script step runs arbitrary code. Off means Clop refuses a pipeline from an agent that contains one, and names the step. Scripts you write yourself are unaffected', keywords: ['mcp', 'agent', 'script', 'shell', 'code', 'pipeline', 'dangerous'], tab: 'mcp', section: '', ui: { control: 'mcpToggle', when: [['mcpEnabled', true]] } },
  { id: 'mcp.main.install', keys: [], title: 'Install in agents', subtitle: 'Add Clop\'s MCP server to the agents on this PC, or copy the command to install it by hand', keywords: ['mcp', 'agent', 'install', 'claude', 'cursor', 'vscode', 'codex', 'server', 'command', 'config'], tab: 'mcp', section: '', ui: { control: 'mcpInstall' } },

  // updates › main
  { id: 'updates.main.updates', keys: [], title: 'Version and updates', subtitle: 'The version of Clop you are running and where new releases are published', keywords: ['update', 'updates', 'upgrade', 'release', 'releases', 'version', 'changelog', 'license', 'licence', 'free', 'open source', 'gpl'], tab: 'updates', section: '', ui: { control: 'updates' } },
  { id: 'updates.main.checkForUpdates', keys: ['checkForUpdates'], title: 'Check for updates', subtitle: 'Ask GitHub Releases for a new version when Clop starts and once a day. This is the only time Clop contacts the internet by itself', keywords: ['update', 'updates', 'upgrade', 'release', 'automatic', 'network', 'privacy', 'check'], tab: 'updates', section: '' },
  { id: 'updates.main.betaUpdates', keys: ['betaUpdates'], title: 'Include beta versions', subtitle: 'Offer prereleases too. They are tested less and can be unstable', keywords: ['beta', 'prerelease', 'pre-release', 'preview', 'channel', 'update', 'unstable'], tab: 'updates', section: '', ui: { when: [['checkForUpdates', true]] } },

  // about › main
  { id: 'about.main.about', keys: [], title: 'About Clop', subtitle: 'Version, source code and where to get help', keywords: ['about', 'version', 'credits', 'source', 'github', 'website', 'contact', 'low tech', 'lowtech', 'licence', 'license', 'gpl'], tab: 'about', section: '', ui: { control: 'about' } },
];

export const SETTING_ENTRIES = rows as SettingEntry[];

/**
 * Settings the window has no row for, and why. Every other key of the schema that macOS does not mark unsupported has an entry, so the
 * search finds it; the tests hold the two lists to that.
 */
export const HIDDEN_KEYS: Partial<Record<SettingKey, string>> = {
  finishedOnboarding: 'State of the first-run card, not a choice.',
  cliInstalled: 'Changed by the tray menu item that installs or removes the command-line tool.',
  lastAutoIncrementingNumber: 'The counter behind the %i name template token; the app advances it.',
  builtinPipelinesSeededVersion: 'Bookkeeping for the built-in pipelines.',
  shortcutConflictsSeen: 'Which shortcut conflicts were already announced; the app keeps it.',
  savedCropSizes: 'Edited in the crop window.',
  useAggressiveOptimisationMP4: 'Legacy flag, superseded by the compression setting of each type.',
  useAggressiveOptimisationJPEG: 'Legacy flag, superseded by the compression setting of each type.',
  useAggressiveOptimisationPNG: 'Legacy flag, superseded by the compression setting of each type.',
  useAggressiveOptimisationGIF: 'Legacy flag, superseded by the compression setting of each type.',
  adaptiveImageSize: 'Legacy flag, superseded by the adaptive tier of the image compression.',
  audioBitrate: 'Legacy bitrate, superseded by the audio compression setting.',
};

const byId = new Map(SETTING_ENTRIES.map(entry => [entry.id, entry]));
export const entryById = (id: string) => byId.get(id);
/** The row a `clop://settings/…` link names: by id, or by the name of a setting it writes. */
export const entryForRow = (row: string): SettingEntry | undefined => {
  const wanted = row.toLowerCase();
  return SETTING_ENTRIES.find(entry => entry.id.toLowerCase() === wanted) ?? SETTING_ENTRIES.find(entry => entry.keys.some(key => key.toLowerCase() === wanted));
};
/** The row to scroll to for `entry`: the row it is drawn inside, when it has no control of its own. */
export const hostRow = (entry: SettingEntry) => (entry.ui?.within ? entryById(entry.ui.within) : undefined) ?? entry;

export interface SettingsTarget { tab: SettingsTab; row?: string }
/** Where `clop://settings/<tab>/<row>` opens: a row the index knows opens on the tab the index puts it on, whatever tab the link names, so a copied link survives a row moving. */
export function settingsTarget(tab?: SettingsTab, row?: string): SettingsTarget {
  const entry = row ? entryForRow(row) : undefined;
  return { tab: entry?.tab ?? tab ?? 'general', ...(entry ? { row: entry.id } : {}) };
}

/** The text the window shows on a row, or over a section, that does nothing yet. */
export const PENDING_NOTE = 'Not used by Clop for Windows yet';
