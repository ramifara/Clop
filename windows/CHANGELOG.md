# Changelog

Clop for Windows versions. Numbering is described in the README under [Versions](README.md#versions).

## 1.0.0-beta.1 (not yet released)

The first version with the macOS app's features, Phases 0–6 of the [parity plan](https://plans.ramifara.app/plans/clop-windows-parity). A beta, because the parts that only run on Windows (installer entries, Explorer verbs, updates) have not yet been tried on real PCs beyond CI.

Media
- Images, videos, PDFs and audio, with the macOS tools and arguments: jpegoptim, pngquant, gifsicle, gifski, ffmpeg, Ghostscript, exiftool, libheif and libjxl, bundled with their licences.
- HEIC, JPEG XL, BMP, SVG and TIFF in; crop, smart crop, watermark, strip EXIF and fit under a size.
- Video: hardware encoders where present, remove audio, speed, FPS cap, HDR to SDR, WebM and GIF.
- PDF: compress, crop and uncrop to paper sizes, render and extract pages.
- Audio: bitrate, speed, conversion, loudness and cover art.
- Long paths past 260 characters.

Automation
- The clipboard takes videos, PDFs, audio and copied file paths as well as images.
- Watched folders, with backups, pause, revert, bring back and stop all. Copies from chosen apps can be ignored.
- Dropped and opened files are placed by the placement settings, as on macOS: in place with a backup by default, and Restore puts the original back.
- Pipelines in the macOS format, with the built-in library, the editor and preset zones.
- A batch window with whole-batch revert.

Windows and tools
- Result cards with right-click menus and per-type actions, and a compact list.
- Crop and compare windows.
- The settings window with all sixteen tabs and search.
- The full tray menu and configurable global shortcuts.
- The `clop` command and `clop://` links.
- An MCP server for agents, which installs itself into the supported agent apps.
- Explorer right-click entries and Send To.
- Update checks through GitHub Releases, with a beta channel.
- A debug dump, hang detection and a first-run card.
- A native ARM64 build for Windows 11 on ARM (`-arm64-` installer and portable app). HEIC, JPEG XL, pngquant and sharp run natively; ffmpeg, jpegoptim, Ghostscript, gifsicle, gifski and ExifTool run under x64 emulation.

Settings
- Every macOS setting key is read and written under its macOS name. Settings from 0.1.x carry over.
- Rows that nothing on Windows reads yet say so in the settings window.

Security
- Agents need MCP turned on before they can change anything, and script steps need their own permission.
- Agents can only use paths on this PC's own drives.
- Every file that is replaced is kept in the backups.

## 0.1.1 (2026-10-09)

- The drop target no longer appears during unrelated mouse gestures: text selection, text drags, moving or resizing windows and empty folder space stay quiet.
- Explorer drags have to begin on a supported image file.
- Accessibility checks run in the background, so they cannot block mouse input.

## 0.1.0 (2026-10-09)

First Windows preview: copying an image optimises it and shows a result card in the screen corner, with format switching, downscaling, copy, save and restore. Drag an image onto the corner target to optimise it.
