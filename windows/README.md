# Clop for Windows

A Windows port of Clop's automatic image and clipboard workflow. This is an independent fork of [Clop by the Lowtech Guys](https://github.com/FuzzyIdeas/Clop), under the same GPLv3 license.

## The experience

Run Clop once. It stays in the system tray. There is no workbench, file browser, onboarding dashboard or sample-image screen.

Copy an image or screenshot in another app. Clop automatically optimises it, puts the result back on the clipboard and shows a small thumbnail card in the bottom-right corner. You can keep working in the original app. The card does not steal focus.

The result uses the geometry and interaction model in the original `FloatingResult.swift`:

- A 196 × 148 thumbnail with the image filling its background.
- Size reduction and resolution over the bottom of the thumbnail.
- An 18-pixel format bar beneath it, with the current format preselected. Click PNG, JPG, WebP, AVIF or GIF to convert in place.
- Six small actions revealed on hover: downscale, restore, compression, aggressive optimisation, copy and save.
- Downscaling opens a slider over the same thumbnail. Choose 100%, 75%, 50%, 25% or 10%, or use the slider. No separate editing window opens.
- Dimensions, compare and Show in Explorer live in the corner menu. Drag the thumbnail to another app.

While dragging, a transient 196 × 148 `Drop to optimise` target appears in the corner, matching `DropZone.swift`. Drop an image onto it to optimise. Releasing the drag elsewhere dismisses the target without changing the file. Dragged image URLs from browsers can also be downloaded and optimised after an explicit drop.

The helper checks the object under the pointer at the original mouse press. In Explorer, the press must hit a selected supported image file; it also recognises image files on the desktop. Other apps can expose image objects through Windows accessibility. A known unsupported image suffix is rejected. Text selection, text drags, title bars, resize handles and empty folder space stay quiet, even with an image selected or on the clipboard. Releasing the mouse or pressing Escape dismisses the target.

Apps that do not expose their image objects through Windows accessibility cannot reveal the target automatically. Copying their image still uses the automatic clipboard workflow. The tray's `Keep drop target visible` also provides a target for an explicit drop. The exact payload of an arbitrary app's drag is only available after a drop.

Clipboard cards disappear after ten seconds and file cards after thirty, as in the original defaults. Hovering pauses dismissal. The tray's `Show latest results` or `Ctrl+Shift+Space` brings recent cards back. Up to three cards stack vertically. The tray also provides clipboard controls, optional pinning, settings and access to originals.

Settings stay closed unless requested from the tray. Choose a screen corner, default format, clipboard behaviour or starting with Windows. The current cursor's screen receives automatic popups.

## Install

Download the [Windows x64 installer](https://github.com/ramifara/Clop/releases/download/windows-v0.1.1/Clop-Windows-0.1.1-x64-Setup.exe) or [portable executable](https://github.com/ramifara/Clop/releases/download/windows-v0.1.1/Clop-Windows-0.1.1-x64-Portable.exe). Quit the previous version from its tray menu before upgrading. Windows 10 and Windows 11 are supported. The builds are unsigned. No Node.js, PowerShell module or development setup is required to use them.

## Image and clipboard details

Supported formats are PNG, JPEG, WebP, GIF, AVIF, HEIC, JPEG XL, BMP, SVG and single-page TIFF. TIFF and SVG become PNG (an SVG is rasterised at its document size); HEIC and BMP become JPEG, or PNG when they have transparent pixels, as macOS converts them by default. JPEG XL stays JPEG XL. HEIC and JPEG XL are read and written with libheif's `heif-dec`/`heif-enc` and libjxl's `djxl`/`cjxl`, BMP is read with ffmpeg. HDR photos (PQ or HLG, as iPhones, Android phones and HDR10 exports store them) are tone-mapped to SDR: light up to about three quarters of the HDR reference white (203 nits) keeps its brightness, and brighter light rolls off so the brightest pixel lands on white, which puts the reference white itself a little below white. Windows Clop writes no HDR and no gain maps, so in Lossless mode an HDR photo is kept as it is unless you scale, crop, watermark or convert it, which writes it as SDR. Animated GIF and WebP retain their frames and timing. Their format bar disables still-image targets. The tray app does not process video, audio or PDF yet and does not include an AI upscaler.

Every resize and format switch starts from the saved original. Restoring recovers its exact bytes. Source files are never overwritten. If a same-format, same-resolution optimisation would increase file size, Clop keeps the original bytes.

The Windows helper writes an encoded PNG, a Windows bitmap and a file-drop list together. File-aware apps receive optimised files; image-aware apps receive an image. Apps that only accept bitmap data may re-encode it themselves. Animation survives file paste and drag; bitmap paste uses the first frame. Copying something else during automatic processing prevents the old image from overwriting the new clipboard contents. Own writes do not trigger another optimisation.

Clop waits for the clipboard to settle before optimising, so an app that writes several times in quick succession costs one optimisation. Some editors, such as Snipping Tool with automatic copying, rewrite the clipboard after every brush stroke. When an app keeps writing images while it stays in front, Clop treats it as an editing session: it keeps only the latest version and optimises it once you switch to another app to paste. Snipping Tool starts in this mode. Copying text, switching apps or pausing for 30 seconds ends a session, so a normal copy, switch and paste is never delayed. `Ctrl+Shift+C` optimises the clipboard immediately at any time.

Images go through the same tools with the same arguments as on macOS: jpegoptim for JPEG, pngquant for PNG, gifsicle for GIF and ffmpeg for animated WebP. sharp only decodes, scales and converts, and encodes still WebP and AVIF at the macOS conversion quality; heif-enc writes HEIC at that quality and cjxl writes JPEG XL at the quality and effort macOS gives its JPEG XL encoder. The factor of the `imageCompression` setting sets each tool's arguments. Balanced uses the setting as it is (factor 30 by default). Smaller uses the macOS aggressive factor 64, or the setting itself when that is already 50 or more. From factor 80 GIFs lose every fourth frame, from 90 every third and from 98 every second; `gifFrameDropBehaviour` chooses whether they play faster or keep their duration. With the adaptive tier, Clop also tries PNG for a flat JPEG and JPEG for an opaque PNG, and keeps the other format when it is over 100 KB smaller. A downscaled PNG that would grow is requantized to fewer colours, or the original is kept. Balanced and Smaller compression may discard detail.

Lossless mode is Windows-only, because Clop on macOS has no lossless image tier. It changes no pixels: JPEG gets jpegoptim's lossless pass and GIF gifsicle's `-O3` without lossy compression; PNG, WebP, AVIF, HEIC and JPEG XL are re-encoded losslessly. Resizing a JPEG in Lossless mode produces PNG. A lossless HEIC keeps a 10- or 12-bit source's depth; a source deeper than 12 bits becomes PNG, since the HEVC encoder stops at 12. GIF holds only 256 colours, so in Lossless mode only an unedited GIF stays GIF; anything else that would become GIF is saved as PNG, or as WebP for an animation. JPEG conversion uses white behind transparent pixels.

`core/media/image-ops.ts` holds the image operations that pipelines and the CLI call, ported from macOS: crop to a crop size (a relative rectangle; an exact size filled around the centre, or with smart crop around sharp's attention region; a long edge; or an aspect ratio; GIFs and animations always keep the centre), watermark with another image in a corner or the centre at a scale and opacity (animations through ffmpeg, frame by frame), strip metadata, convert, and fit under a byte limit: the aggressive factor 64 first, then a binary search up to factor 100 for the gentlest factor that fits, then downscaling at factor 100.

With `stripMetadata` on (the default), results lose camera, location and author metadata but keep the original's resolution (EXIF and PNG `pHYs`, so the DPI survives conversion and scaling), orientation and, with `preserveColorMetadata`, their own colour profile. With it off, every tag of the original is copied, except the colour description, which always describes the result's pixels, and the orientation of re-encoded results, whose pixels are already upright.

Originals and results live in the working directory (see below) and are deleted after the `workdirCleanupInterval` setting, three days by default. The app remembers up to 40 images during its session and automatically retires the oldest entries. Its local cache starts fresh on restart. Input limits are 128 MB, 60 million pixels across all frames, 250 animation frames and 20 files per drop.

## Video engine

`core/media/video.ts` processes video with ffmpeg and ffprobe using the macOS arguments. The tray app does not send videos to it yet. It optimises, scales, crops, changes speed, caps the frame rate, removes audio and converts to HEVC, AV1 or VP9 WebM, all in one ffmpeg pass. It also makes GIFs through gifski, at 960 pixels wide and 15 fps by default. Progress comes from ffmpeg's `-progress` output.

The `videoCompression` tier picks the encoder. `fast` uses a hardware encoder when one works and libx264 at the `veryfast` preset otherwise. `smaller` and custom factors use libx264 at the CRF and preset the factor maps to, and `lossless` uses CRF 17. `adaptive` chooses between them per file, as Apple Silicon Macs do, and aggressive mode uses `veryslow` at CRF 28. With `videoEncoder` set to `auto`, Clop tries NVIDIA NVENC, Intel Quick Sync, AMD AMF and Media Foundation in that order. Each candidate must encode a test frame, and the first that works is used for the rest of the session. Naming an encoder forces it, falling back to libx264 or libx265 when it does not work. Naming an HEVC encoder makes every tier encode HEVC. Hardware encoders take the software CRF as their constant-quality level.

Plain optimisations that come out larger keep the original; removing audio or asking for SDR always produces a new file. Failed ffmpeg and gifski runs are retried up to three times, as on macOS. Speed changes re-time the audio with `atempo`, which macOS leaves at its original length. HDR video (PQ or HLG) is tone-mapped to SDR when the result is H.264. HEVC, AV1 and VP9 conversions keep HDR unless SDR is requested. With `stripMetadata` on, results lose their title, location and other container metadata.

## PDF engine

`core/media/pdf.ts` holds the PDF engine. The app does not use it yet. Ghostscript compresses with the argument sets from `PDF.swift`. Below 300 DPI it downsamples and re-encodes images as JPEG, with lower JPEG quality at 100, 72 and 48 DPI. At 300 DPI it passes JPEGs through untouched. The `pdfDPI` setting is 0 (adaptive) or a fixed DPI from 48 to 300. Adaptive mode estimates each image's DPI from its pixel size over its page's size, as macOS does. That estimate assumes each image fills its page. Images that read abnormally low are dropped as outliers. Clop then picks the highest stop (300, 250, 200, 150, 100, 72, 48) with more than three images at or above it, and 300 when there are no images. Aggressive mode goes one stop lower. An explicit DPI from a pipeline or the CLI is used as given. PDFs over 150 pages are split into 100-page chunks, and the chunks are merged afterwards. No more than four Ghostscript processes run at once across all PDF jobs. A failed Ghostscript run is retried, up to three tries for a whole PDF and two per chunk. As on macOS, the merge keeps pages but drops document outlines and links that point into another chunk. A result that is not smaller keeps the original. Encrypted PDFs are refused.

Cropping to an aspect ratio or a paper size (`core/data/paperSizes.ts`, the macOS table) changes only each page's CropBox. The MediaBox keeps the full page, so uncropping restores it. Extending grows the MediaBox instead and keeps all content. Page boxes are edited with [`@cantoo/pdf-lib`](https://github.com/cantoo-scribe/pdf-lib), a maintained fork of pdf-lib. Pages render through Ghostscript (`png16m`, or JPEG at quality 90) at 144 DPI within the CropBox. PNG pages come out on an opaque white background. macOS leaves the background of PNG pages transparent. They can then go through the image optimiser, and are named `<name>-page<n>.png` or `.jpg`.

## Audio engine

`core/media/audio.ts` processes audio with ffmpeg using the macOS arguments. The tray app does not send audio to it yet. It optimises, lowers the bitrate, changes speed, converts between AAC (M4A), MP3, Opus (OGG), FLAC, WAV and AIFF, normalises loudness and handles cover art. Progress comes from ffmpeg's `-progress` output.

The factor of the `audioCompression` setting picks the bitrate: 256 down to 48 kbps for AAC, 320 to 64 for MP3 and 160 to 32 for Opus, in steps of 16. The default factor 35 gives 192 kbps. The bitrate is capped at the input's and snapped down to a standard bitrate, so a file is never re-encoded at a higher one, and aggressive mode goes one step below the input. MP3 uses LAME's VBR quality levels. AAC uses ffmpeg's own encoder instead of Apple's, so sizes differ slightly from macOS. WAV and AIFF become 16-bit at no more than 48 kHz, and aggressive WAV becomes IMA ADPCM. Formats listed in `formatsToConvertToAAC` (AIFF and FLAC by default) and `formatsToConvertToMP3` (WAV) are converted; other files keep their format. A result in the same format that is not smaller keeps the original, and so does lowering the bitrate to a target that is not below the input's.

Speed changes chain `atempo` filters, so any factor works. As on macOS they drop the cover art and re-encode with ffmpeg's default encoder for the file type. Loudness normalisation uses single-pass `loudnorm` with a true peak of -1.5 dB and resamples back to the input's rate.

The `audioCoverArt` setting chooses what happens to artwork in M4A, MP3 and FLAC files. `optimise` (the default) recompresses JPEG art with jpegoptim at quality 68 and PNG art with pngquant, and keeps photographic PNG art as JPEG when that is smaller. `keep` copies the art untouched and `remove` drops it. Opus, WAV and AIFF results never carry art. Optimised art can also be cropped to a square (landscape art only, or always) and capped at a long edge. Art can be extracted as it is, or downscaled and re-embedded without re-encoding the audio.

## Working directory, placement and names

The working directory is `%APPDATA%\Clop for Windows\work` unless the `workdir` setting says otherwise (an absolute path; `~` and `$HOME` mean your profile folder; an empty or relative value is refused and Clop uses the default folder). A new `workdir` applies the next time Clop starts. It holds three folders:

- `backups`: the original of every file Clop replaces in place, named `<name>-<hash>.<ext>`. Restoring copies it back byte for byte and keeps the original modification time.
- `batch-backups`: batch-mode backups. Nothing here is ever deleted automatically, because it can be the only copy of a file.
- `temp`: the running session's originals and results (`session-*`) and other scratch files.

Clop only uses a folder that is empty, that it made before (it leaves a `.clop-workdir` file there) or that holds nothing but its own three folders, and it refuses a path with a link (symlink or junction) in it. Otherwise it reports the problem and uses the default folder. Every 10 minutes Clop deletes files in `backups` and `temp` that have not changed for longer than `workdirCleanupInterval` (10 minutes to 1 month, or never) and removes the folders that empty out. The running session's folder is kept until the next start. The older `%APPDATA%\Clop for Windows\images` folder is not migrated. It ages out with the same interval and disappears once empty. `core/workdir.ts` also provides `forceClean()`, which empties `backups` and `temp` but not `batch-backups` or the running session.

`core/placement.ts` ports `FilePlacement.swift`. For each file type and kind (optimised, automatic conversion, manual conversion) the `optimised*Behaviour`, `converted*Behaviour` and `manualConverted*Behaviour` settings choose one of four modes:

- `temporary`: the result stays in the working directory and the original is untouched.
- `inPlace`: the original moves into `backups` and the result takes its place, with the result's extension. If the backup cannot be made, nothing is replaced.
- `sameFolder`: the result is written next to the original under `sameFolderNameTemplate*` (default `%f-optimised`).
- `specificFolder`: the result goes to the path made by `specificFolderNameTemplate*` (default `%P/optimised/%f`), creating folders as needed.

If another file already sits at the destination, it is copied into `backups` first and the result reports it as `replaced`. Folders that come from `%P` or `%F` keep their names exactly; only the literal parts of a template and the file name are made safe.

A file that already sits at its templated location is left there, so templates never stack (`a-optimised-optimised.png`). Copies go through a temporary file in the destination folder and replace the target in one rename, retrying while Defender or a preview handler holds the file. There are no copy-on-write clones on Windows; every backup is a full copy.

Name templates (`core/template.ts`) use `%y` year, `%m` month, `%n` month name, `%d` day, `%w` weekday (1 is Sunday), `%H` hour, `%M` minutes, `%S` seconds, `%p` AM or PM, `%r` five random letters, `%i` auto-incrementing number (`lastAutoIncrementingNumber`), `%f` file name, `%e` extension, `%P` folder and `%F` full path. `~`, `$HOME` and a leading `%USERPROFILE%` mean your profile folder. As on macOS, file names replace the characters `/ : { } < > * | $ # & ^ ; ' "`, the backtick and control characters with `_`. Windows adds `\` and `?`, a trailing dot or space, and reserved device names such as `CON` and `NUL`, which get a `_`. As on macOS, `%p` reads AM from 12:00 to 12:59.

Optimised files are remembered in `%APPDATA%\Clop for Windows\optimised.json`, keyed by path with the file's size and modification time. A file counts as optimised only while both still match, so editing it or saving it through a temporary file clears the mark. Entries older than 30 days or whose file no longer exists are dropped when the app starts, and the list holds at most 50,000 files. On NTFS Clop also writes a `clop.optimisation.status` alternate data stream as a hint. Zip, FAT, OneDrive sync and many editors lose it, so nothing relies on it.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+C` | Optimise current clipboard |
| `Ctrl+Shift+A` | Optimise clipboard more aggressively |
| `Ctrl+Shift+Space` | Bring back recent corner cards |
| `1` through `9` | Resize selected image to 10% through 90% |
| `-` | Reduce selected image by another 10% of original width |
| `C` | Copy selected image |
| `R` | Restore selected image |
| `Escape` | Hide corner cards |

Single-letter shortcuts operate while a card has keyboard focus and no text field is active. Global shortcut conflicts appear as a small notification; tray commands remain available.

## Development and verification

The Windows app uses Electron, TypeScript, React and Sharp, with a small STA helper using built-in Windows PowerShell 5.1 and .NET Framework. It captures mouse-press coordinates, hit-tests UI Automation file items in Explorer and MSAA image objects in other apps, handles drag-end events and watches clipboard sequence numbers. A background MTA thread checks accessibility objects, leaving the mouse hook's message pump responsive. Completed checks carry a gesture generation so releasing or cancelling a drag discards a late answer. The mouse hook queues coordinates without doing COM work or reading clipboard data. The renderer is sandboxed, has no Node.js access and receives a narrow preload API. External navigation is blocked.

Use Node.js 24 or newer. From `windows/`:

```sh
npm ci
node scripts/fetch-tools.mjs
npm run desktop
npm test
npm run build
npm run dist:win
```

`scripts/fetch-tools.mjs` downloads the command-line tools pinned by version and sha256 in `scripts/tools.json`, verifies each download and copies the needed files into `.tools/win32-x64/bin`. Packages already present at the pinned hash are skipped. Only an x64 set exists; on ARM64 Windows the x64 tools run under emulation, so the script and the app use the x64 set there too. The installer ships that folder as `resources/bin`. On Linux and macOS the script does nothing unless you pass `--platform win32`; development there uses `ffmpeg`, `gs`, `gifsicle`, `gifski`, `jpegoptim`, `pngquant`, `exiftool`, `heif-dec`, `heif-enc`, `cjxl` and `djxl` from `PATH`. `CLOP_TOOLS_DIR` overrides both. Tests that need a missing tool are skipped locally and fail in CI.

Settings are stored in `settings.json` in the app's data folder (`%APPDATA%\Clop for Windows`). `core/settings/schema.ts` defines every key with its type, default and description. The store uses the same key names as `Clop/Settings.swift`, but a few values use Windows encodings, such as shortcut keys, encoder names and app paths; the schema notes each one. Folder defaults are stored relative to the user profile (`~/Desktop`) and expanded when used. Keys for features that exist only on macOS stay in the schema but are marked unsupported. `node scripts/extract-mac-settings.mjs` prints the macOS key names, and a test checks the schema covers them all. Settings saved by earlier Windows versions are converted to the new keys at the next launch.

`core/data/` holds the macOS app's default crop sizes and aspect ratios and its iPhone and iPad screen sizes. Tests compare each table with the Swift source it comes from.

The packaging command runs on Windows, fetches the tools and produces NSIS and portable executables in `release/`. CI runs every bundled tool with only the bundle and Windows on `PATH`, checks that the bundle carries every DLL its programs import, tests image processing, compiles the Windows helper, checks native clipboard formats and launches the packaged app. An external clipboard write must produce a corner result automatically. CI checks the 196 × 166 card, selected format, resize, restore and clipboard loop protection, and saves an actual Windows screenshot. Real mouse gestures in a separate native app and Explorer verify image drags, release/Escape and suppression of text selection, text drags, unsupported images, empty space, window movement and resizing.

`npm run dev` serves a development-only corner-card preview on loopback port 5274. Its background is a neutral canvas so the transparent cards can be inspected in a browser. Paste an image to inspect a card. There are no browse or sample controls. A browser cannot demonstrate system-wide clipboard watching or native Windows drag detection; those are exercised by the packaged-app test. Preview data stays under `.preview-data/` and can be removed after shutdown.

The desktop app does not upload images or send analytics. Downloading an image URL only occurs when that URL is explicitly dropped onto the target. Managed machines may block the Windows helper; Clop reports the failure, and save and drag operations remain available.

API references: [Windows accessibility hit testing](https://learn.microsoft.com/en-us/windows/win32/api/oleacc/nf-oleacc-accessibleobjectfrompoint), [Windows object roles](https://learn.microsoft.com/en-us/windows/win32/winauto/object-roles), [Windows drag events](https://learn.microsoft.com/en-us/windows/win32/winauto/event-constants), [Electron clipboard](https://www.electronjs.org/docs/latest/api/clipboard), [Electron file paths](https://www.electronjs.org/docs/latest/api/web-utils), [Sharp output](https://sharp.pixelplumbing.com/api-output/) and [Sharp resizing](https://sharp.pixelplumbing.com/api-resize/).

## Bundled tools and licences

The Windows build ships these programs unmodified, as separate executables in `resources/bin`:

| Tool | Source |
| --- | --- |
| FFmpeg and FFprobe, sharing the libav* DLLs | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) GPL shared build |
| Ghostscript (`gswin64c.exe`, `lib`, `Resource`) | [Artifex](https://github.com/ArtifexSoftware/ghostpdl-downloads) |
| gifsicle | [eternallybored.org](https://eternallybored.org/misc/gifsicle/) |
| gifski | [ImageOptim/gifski](https://github.com/ImageOptim/gifski) |
| jpegoptim | [tjko/jpegoptim](https://github.com/tjko/jpegoptim) |
| pngquant | [MSYS2](https://packages.msys2.org/base/mingw-w64-pngquant) |
| ExifTool, with its Strawberry Perl runtime | [exiftool.org](https://exiftool.org) |
| libheif `heif-dec` and `heif-enc` | [MSYS2](https://packages.msys2.org/base/mingw-w64-libheif) |
| libjxl `cjxl` and `djxl` | [libjxl/libjxl](https://github.com/libjxl/libjxl) |
| DLLs used by libheif and pngquant (libde265, x265, x264, aom, dav1d, libpng, zlib and others) | MSYS2 |
| Microsoft Visual C++ runtime, for Ghostscript and gifski | [conda-forge](https://anaconda.org/conda-forge/vc14_runtime) |

In the installed app, `resources\bin\THIRD_PARTY_NOTICES.txt` lists every bundled package with its version, licence, homepage, exact download address and the address of its corresponding source code. Their licence texts and notices are in `resources\bin\licenses\<package>`. `fetch-tools.mjs` produces both from `scripts/tools.json`. Ghostscript and gifski are AGPLv3; they run as separate programs, and section 13 of GPLv3 permits combining GPLv3 and AGPLv3 work.

### Refreshing pinned tools

To update a tool, change its entry in `scripts/tools.json`: the version, the URL, the sha256 of the download, the archive paths in `files` and `licenses`, and the `sources` addresses for that exact version. Where an archive has no licence text, `licenseTexts` pins one by URL and sha256. Then run `node scripts/fetch-tools.mjs --platform win32`, which refuses a download whose hash differs. repo.msys2.org removes old package versions, so the MSYS2 entries eventually stop downloading. Regenerate them with `npx tsx scripts/resolve-msys2.ts libheif:heif-dec,heif-enc pngquant:pngquant`. It reads the current MSYS2 package database, follows the tools' DLL imports to every package they load and prints their entries with sha256, licence files and MSYS2 source package addresses; replace the `msys2-*` entries with its output. BtbN keeps its month-end FFmpeg builds for about two years; pick a newer month-end `autobuild-*` release when the pinned one disappears. CI checks that each tool reports its pinned version, that the bundle carries every DLL its programs import, and that every package has licence texts and a notice with its source address.

## Attribution

The original macOS source, interaction model and hat icon are by the Lowtech Guys and Clop contributors. The Windows implementation is GPLv3, as is this repository. Dependency licenses remain with their respective authors.
