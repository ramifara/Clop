// The pipeline DSL reference that `clop pipeline prompt` prints and the MCP tool `clop_pipeline_prompt` returns: a copy of
// `compactPipelinePromptContext` and `pipelinePromptContext` (ClopCLI/main.swift). Only what works differently on Windows
// is reworded: scripts run in PowerShell, Shortcuts and the shelf apps are macOS-only, and share links need an upload target.
// Keep it in step with templates.ts and the parser.

/** The short variant (~1.7k tokens) for small-context models. */
export const COMPACT_PIPELINE_REFERENCE = `# Clop pipeline DSL (compact)

You write Clop pipelines that transform image/video/pdf/audio files. Reply with ONE line, nothing
else (add a one-line note only if a caveat matters). That line is one of:
- a bare pipeline string (\`crop(longEdge: 1600) -> convert(to: webp)\`) for a one-off on named files;
- \`clop pipeline attach '<steps>' --source <source> --type <type>\` to run automatically on a source;
- \`clop pipeline add [--file-type <type>] <name> '<steps>'\` to save a reusable named pipeline.

Choosing the output:
- Request names a folder ("photos in Downloads", "PDFs in ~/Reports"): attach with \`--source <folder>\`
  (\`~\` is fine). The folder starts being watched, so new files of that type run the pipeline.
- "when I copy", "clipboard": \`--source clipboard\`. "dropped on Clop": \`--source dropZone\`.
- "save a pipeline", "preset": \`clop pipeline add\` (or \`clop pipeline preset add\`).
- otherwise: a bare pipeline string.
With \`--type\`/\`--file-type\` the pipeline is ALREADY scoped to that broad type, so don't restate it
with \`if(types: <t>)\` (redundant). But \`types:\` also takes specific formats, so still use it to
NARROW further (e.g. \`if(types: jpeg webp)\` under \`--type image\`) or to split MIXED-type runs.

Syntax: steps joined by \`->\`, left to right. \`name(key: value, ...)\`; no-param steps can be bare.
Quote strings/paths/regex; bare values fine for enums/numbers. A step that doesn't fit the input type
is skipped. Inline \`run\` does EXACTLY your steps (no implicit optimise; add \`optimise\` for smaller files).
A saved/attached pipeline optimises first unless "skip optimisation" is set. Default location is
\`inPlace\`, except \`convert\`/\`extractPagesAsImages\` default to \`sameFolder\`.

Ambiguous words: "smaller" is compression, resolution (downscale) or both; "Nx" on video/audio is
changeSpeed (there is no upscaling); a video speed-up keeps or drops frames. Ask the user when you can.
When you can't: compression for "smaller", and leave \`frames\` out.

## Steps ([types]; defaults in (), value sets after :)
- optimise(encoder, compression, adaptive, dpi, location) [all]. encoder img/pdf/audio: medium|aggressive|lossless;
  video: fast|slowHighQuality|visuallyLossless. compression [img,video,audio]: 5 (best quality)..100
  (smallest), or adaptive. adaptive (img, may change ext). dpi (pdf): 300|150|72|48.
- downscale(factor 0..1, location) [image,video,audio] (for audio this lowers the bitrate).
- lowerBitrate(kbps) [audio]: 192|160|128|96|64 (never upscales; snaps to allowed).
- convert(to, location) [image,video,audio] (sameFolder). img: webp|avif|heic|jxl|jpeg|png|gif;
  video: mp4|hevc|x265|av1|webm|gif (AV1 video = \`av1\`, NOT the \`avif\` image format);
  audio: m4a|mp3|ogg|flac|wav|aiff. No-op if already that format.
- crop(width, height, longEdge, aspectRatio, smartCrop, location) [image,video]. Give >=1 of
  width/height/longEdge/aspectRatio; missing side keeps aspect; longEdge = longest side;
  aspectRatio = shape like 16:9 (no resize); smartCrop keeps the most interesting area.
- extractPagesAsImages(format jpeg|png, quality low|medium|high, location) [pdf] (sameFolder).
- targetSize(size) [all]: iteratively compress under a limit, e.g. 500KB, 10MB, 25MB. No trailing \`optimise\`.
- stripExif [image,video]. watermark(image, position bottomRight|bottomLeft|topRight|topLeft|center,
  opacity 0..1, scale 0.15, location) [image,video].
- removeAudio [video]. changeSpeed(factor, frames) [video,audio]; frames [video]: keep (every frame, the fps
  rises with the speed) | drop (back to the source fps, smaller file), omitted follows the app setting.
  capFps(fps) [video]. normalize(lufs -16) [audio].
- copy(to) / move(to) / rename(to) / delete(path)  (delete(path: "sourceFile") removes the input file).
- runScript(path | code): inline \`code\` is one line of PowerShell, no \`->\`; a script file gets the file as its first
  argument, and both see $env:CLOP_INPUT_FILE; bundled ffmpeg, gs, gifski etc. are in $env:CLOP_BIN; a path it prints
  replaces the file. runShortcut(name) [image,video,pdf] runs a macOS Shortcut; on Windows use runScript.
- copyToClipboard(format path|imageData|markdown, relativeTo). copyLinkForSending(expiration 1m|15m|1h|6h|1d|3d|never).
  fork(location) surfaces a second card. shelveWith(app yoink|dockside|dropover|atoll). uploadWith(app dropshare). openWith(app).

## Filters (if / ifNot gate the rest of the pipeline; no else, no branch)
\`if(...)\` continues only when every key holds (AND); \`ifNot(...)\` inverts; a failed filter silently
stops the file. Keys: regex (filename, capture groups -> $1..), types (e.g. \`jpeg png webp\`),
nameContains, nameIs, fileSizeGreaterThan/fileSizeLowerThan (bytes), minFileSize (\`2mb\`),
widthGreaterThan/widthLowerThan, heightGreaterThan/heightLowerThan, minResolution (\`640x480\`),
dpiGreaterThan/dpiLowerThan, copiedBy (clipboard source app/bundle id).
Mixed types: filters don't branch, so \`if(types: image) -> ... -> if(types: video) -> ...\` is broken
(the 2nd gate never passes). "Do X to all, Y to one type" = narrow at the end:
\`optimise -> if(types: image) -> convert(to: webp)\`. "Different output per type" = TWO commands, one
per \`--type\` (no \`--type image,video\`): attach \`convert(to: webp)\` --type image, AND \`convert(to: mp4)\` --type video.

## location & path tokens
location: inPlace | sameFolder | temporaryFolder | a path template. Tokens (usable in location,
copy/move/rename \`to\`, watermark \`image\`): %f name, %e ext, %P parent, %F full path, %y year,
%m month, %n month name, %d day, %w weekday, %H hour, %M min, %S sec, %p AM/PM, %r 5 random letters,
%i counter. $1.. = regex capture groups. ~ = home. No extension in a template -> it's appended.

## Avoid double encoding
crop/downscale/convert already re-encode AND compress, so don't add a trailing \`optimise\`. Consecutive
inPlace steps batch into one pass; a non-inPlace location ends the batch and starts a new encode (this
is how multi-output pipelines are built).

## Commands
- run now:  \`clop pipeline run '<steps>' file...\`
- save:     \`clop pipeline add [--file-type t] [--skip-optimisation] [--hide-result] <name> '<steps>'\`
- automate: \`clop pipeline attach '<steps>' --source <clipboard|dropZone|folder> --type <t>\`
            (a folder source is auto-watched; remove with \`clop pipeline detach --source <s> --type <t> --all\`)
- preset:   \`clop pipeline preset add '<name>' '<steps>' [--type t] [--icon <sf-symbol>]\`

## Examples
- \`optimise -> convert(to: webp)\`
- \`targetSize(size: 10MB)\`
- \`changeSpeed(factor: 2.0) -> removeAudio -> optimise(encoder: fast)\`
- \`clop pipeline attach 'crop(longEdge: 1600) -> convert(to: webp, location: "~/Sync/Optimised/") -> copyToClipboard(format: markdown)' --source ~/Downloads --type image\`
- \`clop pipeline attach 'convert(to: webp)' --source clipboard --type image\`
- \`clop pipeline add --file-type image 'Web ready' 'convert(to: webp)'\``;

/** The full reference (~5.3k tokens). */
export const PIPELINE_REFERENCE = `# Clop pipeline DSL

You write Clop pipelines: ordered sequences of steps that transform image, video, PDF and
audio files. Translate the request into ONE line and reply with just that line (plus a one-line
note only if a caveat matters), nothing else. That line is one of:

- a bare pipeline string like \`crop(longEdge: 1600) -> convert(to: webp)\`, for a one-off the user
  runs now on specific files (they will wrap it in \`clop pipeline run\`);
- a full \`clop pipeline attach '<steps>' --source <source> --type <type>\` command, when the
  request is to run automatically on a source (a folder, the clipboard, the drop zone);
- a full \`clop pipeline add [--file-type <type>] <name> '<steps>'\` command, when the request is
  to save a reusable named pipeline to the library.

## Choosing what to output

- The request names a folder ("every photo in Downloads", "all PDFs in ~/Reports", "whenever I
  save a video to ~/Movies"): attach to that folder with \`--source <that folder path>\`. \`~\` is
  fine; the folder starts being watched, so every new file of that type added to it runs the pipeline.
- "whenever I copy ...", "from the clipboard", "anything I paste": use \`--source clipboard\`.
  "dropped on Clop", "the drop zone": use \`--source dropZone\`.
- "save a pipeline called X", "make a preset I can reuse": use \`clop pipeline add\` (or
  \`clop pipeline preset add\` for a drop-zone preset zone).
- Anything else (a one-off on specific files the user names): a bare pipeline string.

Prefer ONE command. A single \`attach\` with inline steps both starts watching the folder and runs
the pipeline; you don't need a separate \`add\` first unless the user explicitly wants it saved by name.

## Settle ambiguous wording first

A pipeline does exactly what its steps say, so a guess becomes a folder full of wrong files. When
you can ask the user, ask these as choices, all at once, skipping any the request already answers.
When you can't ask, use the fallback and leave the rest as written.

- "Smaller": compression (\`optimise(compression: N)\`, same pixel size), resolution
  (\`downscale(factor: F)\`, fewer pixels), or both. Ask which, and how much. Fallback: compression.
- "2x", "3x", "N times" on video or audio: \`changeSpeed(factor: N)\`. Clop has no upscaling step, so
  it never means a larger frame. Nothing to ask.
- A video speed-up: keep every frame (\`frames: keep\`, smoother, the frame rate rises with the speed)
  or drop frames back to the source rate (\`frames: drop\`, smaller file). Fallback: leave \`frames\`
  out, which follows the app's setting.
- "Silent", "mute": \`removeAudio\`. Nothing to ask.

## File-type filtering (IMPORTANT)

When you emit \`attach --type <t>\` or \`add --file-type <t>\`, the pipeline is ALREADY scoped to that
broad type (image/video/pdf/audio), so do NOT restate the SAME broad type with \`if(types: <t>)\`:
\`if(types: image)\` under \`--type image\` is redundant noise, and a step that doesn't apply to the
input type is skipped on its own anyway. You SHOULD still use \`if(types: ...)\` when you need to
narrow FURTHER, because \`types:\` also takes specific formats/extensions: e.g. \`if(types: jpeg png
webp)\` to act only on those image formats even under \`--type image\`. And use it to discriminate
between types in a MIXED-type run (an all-types drop-zone preset, or a bare \`clop pipeline run\`
over a folder of mixed files).

## Syntax

- Steps are separated by \`->\`, evaluated left to right: \`crop(width: 1600) -> convert(to: webp)\`.
- Each step is \`name(key: value, key: value)\`. No-parameter steps can be bare: \`removeAudio\`,
  \`stripExif\`, \`normalize\`, \`copyToClipboard\`, \`copyLinkForSending\`.
- Quote string, path and regex values: \`move(to: "~/Pictures/%y/")\`, \`if(regex: "^IMG_")\`.
  Bare values are fine for enums/numbers: \`convert(to: webp)\`, \`downscale(factor: 0.5)\`.
- File types: \`image\`, \`video\`, \`pdf\`, \`audio\`. Each step lists the types it applies to;
  a step that doesn't apply to the input is skipped.

## Execution model (IMPORTANT)

- An inline pipeline (\`clop pipeline run '...'\`) runs EXACTLY the steps you write, with NO
  implicit optimisation pass. If you want compression, add an explicit \`optimise\` step.
- A saved pipeline honours its "skip optimisation" flag: when off, files are optimised first,
  then your steps run.
- Most processing steps default to \`location: inPlace\` (replace the original). \`convert\` and
  \`extractPagesAsImages\` default to \`location: sameFolder\`.

## Steps

### Processing

- \`optimise(encoder, compression, adaptive, dpi, location)\`: compress in place. [image, video, pdf, audio]
  - \`encoder\`: images/pdf/audio use \`medium\` (default), \`aggressive\`, \`lossless\`;
    video uses \`fast\` (hardware H.264), \`slowHighQuality\` (software, smaller), \`visuallyLossless\`.
  - \`compression\`: how hard to compress, \`5\` (best quality) to \`100\` (smallest file), or \`adaptive\`
    to let Clop pick per file. [image, video, audio] This is the same scale as the app's
    compression setting, scoped to this pipeline instead of changing it globally. A plain
    "smaller" can also mean \`downscale\`, see "Settle ambiguous wording first".
  - \`adaptive\`: \`true\`/\`false\` (images only; may change the extension, e.g. PNG↔JPEG).
  - \`dpi\`: PDF only, overrides encoder. 300 = no downsampling, 150 = screen reading, 72 = screen, 48 = smallest.
- \`downscale(factor, location)\`: scale down, keeps aspect ratio. [image, video, audio]
  - \`factor\`: 0.0–1.0 (0.5 = half, 0.75 = 75%). For audio this lowers the bitrate.
- \`lowerBitrate(kbps, location)\`: set audio bitrate. Never upscales, snaps to allowed bitrates. [audio]
  - \`kbps\`: e.g. 192, 160, 128, 96, 64.
- \`convert(to, location)\`: change format, then re-encode and compress to that format during the same pass. [image, video, audio] (default location: sameFolder)
  - \`to\`: image → webp, avif, heic, jxl, jpeg, png, gif; video → mp4 (H.264), hevc (H.265 hardware),
    x265 (software, smaller), av1, webm, gif; audio → m4a, mp3, ogg, flac, wav, aiff.
    Watch the AV1 collision: the AV1 *video* codec is \`av1\`; \`avif\` is the still-*image* format.
  - Converting to the format the file is already in is an idempotent no-op: it does NO work and the
    file is passed through unchanged (jpg/jpeg and tif/tiff count as the same format). So \`convert\`
    only re-encodes when the input isn't already that format.
  - Animated GIF and animated WebP keep every frame through \`convert\`, \`optimise\` and \`crop\`.
    Converting either to a still format (jpeg, png, heic, avif, jxl) still yields the first frame alone.
- \`crop(width, height, longEdge, aspectRatio, smartCrop, location)\`: resize to exact pixels, or
  crop to a shape. [image, video]
  - Provide at least one of \`width\`/\`height\`/\`longEdge\`/\`aspectRatio\`. \`width\`/\`height\` in px (the
    missing one is computed, aspect kept). \`longEdge\` sets the longest side instead of width/height.
  - \`aspectRatio\` crops to a shape instead of a pixel size, e.g. \`16:9\`, \`4:3\`, \`1:1\`, \`1.91:1\`.
    It trims to the ratio at the source's own resolution and does not resize, so it composes with a
    pixel crop step. A ratio wider than tall forces landscape output (and taller than wide,
    portrait), matching \`clop crop 16:9\`. It wins over width/height/longEdge if both are given.
  - \`smartCrop: true\` picks the most interesting region instead of the centre. Applies to any crop.
  - A file already at the requested size or shape is left untouched instead of re-encoded.
- \`extractPagesAsImages(format, quality, location)\`: render PDF pages to images. [pdf]
  - \`format\`: jpeg (default), png. \`quality\`: low (1x/72dpi), medium (2x/144dpi, default), high (3x/216dpi).
- \`targetSize(size, location)\`: compress iteratively until the file fits under a limit. [image, video, pdf, audio]
  Never follow it with \`optimise\`: it already compresses to fit, so a trailing \`optimise\` is wasteful double encoding.
  - \`size\`: \`500KB\`, \`10MB\`, \`25MB\` (kb/mb/gb or kib/mib/gib, or raw bytes). Handy limits:
    Discord/GitHub 10MB, WhatsApp 16MB, Gmail 25MB.
- \`stripExif\`: remove EXIF and GPS metadata (privacy before sharing). [image, video]
- \`watermark(image, position, opacity, scale, location)\`: overlay a watermark image. [image, video]
  - \`image\`: path (quote it; PNG with transparency works best). \`position\`: bottomRight (default),
    bottomLeft, topRight, topLeft, center. \`opacity\`: 0.0–1.0 (default 1.0). \`scale\`: width fraction (default 0.15).

### Media-specific

- \`removeAudio\`: strip the audio track. [video]
- \`changeSpeed(factor, frames)\`: playback speed multiplier (2.0 = 2x, 0.5 = half). [video, audio]
  - \`frames\` [video]: \`keep\` keeps every frame, so the frame rate rises with the speed (2x of 30 fps
    plays at 60 fps); \`drop\` drops frames back to the source rate for a smaller file. Omitted, it
    follows the app's playbackSpeedFrameBehaviour setting.
- \`capFps(fps)\`: cap the frame rate (60, 30, 24, …). [video]
- \`normalize(lufs)\`: normalise loudness. \`lufs\` default -16 (-14 Spotify/YouTube, -16 Apple Podcasts, -23 EBU). [audio]

### Filters (if / ifNot: gate the rest of the pipeline, no branching)

- \`if(...)\` and \`ifNot(...)\` are filters, NOT branches. There is no \`else\`, no nested block and
  no \`;\` separator: a step is one \`if(...)\` and the rest of the pipeline that follows it.
- \`if(...)\` continues only when the condition holds; when it fails the file silently stops here
  (no error, no result). \`ifNot(...)\` inverts the WHOLE condition: it stops the file when the
  condition holds and continues only when it does not.
- Multiple condition keys inside one \`if\`/\`ifNot\` combine with AND; every key must hold. To OR
  conditions, use two separate pipelines.
- Condition keys:
  - \`regex\`: pattern matched against the filename (smart case; capture groups become $1, $2). Quote it.
  - \`types\`: space-separated types/extensions, e.g. \`types: jpeg png webp\`.
  - \`nameContains\`: case-insensitive substring. \`nameIs\`: exact filename.
  - \`fileSizeGreaterThan\` / \`fileSizeLowerThan\`: raw bytes. \`minFileSize\`: human size (\`100kb\`, \`2mb\`).
  - \`widthGreaterThan\` / \`widthLowerThan\` / \`heightGreaterThan\` / \`heightLowerThan\`: pixels (images).
  - \`minResolution\`: \`WxH\`, e.g. \`640x480\` (images).
  - \`dpiGreaterThan\` / \`dpiLowerThan\`: DPI (images & PDFs).
  - \`copiedBy\`: app name or bundle id substring (clipboard source only), e.g. \`copiedBy: "safari"\`.

### Mixed file types (filters do NOT branch, so handle each type separately)

Because a filter only gates the steps AFTER it and there is no \`else\`, you cannot give two file
types different treatment in one linear pipeline. Chaining gates like
\`if(types: image) -> convert(to: webp) -> if(types: video) -> convert(to: mp4)\` is broken: a video
fails the first gate and stops, an image that passes is no longer a video at the second gate, so the
second half never runs.

- "Do X to everything, then ALSO do Y to only one type": one pipeline works, narrow at the END.
  e.g. optimise all, only images go on to webp: \`optimise -> if(types: image) -> convert(to: webp)\`.
- "Give each type a DIFFERENT output": emit TWO commands, one per \`--type\` (a \`--type\`/\`--file-type\`
  can only be a single type). e.g. for a folder of images and videos:
    clop pipeline attach 'convert(to: webp)' --source <folder> --type image
    clop pipeline attach 'convert(to: mp4)'  --source <folder> --type video
  (Output both lines; do not invent \`--type image,video\`.)

### File operations (template tokens supported, see below)

- \`copy(to)\`: copy to a path/template. \`move(to)\`: move. \`rename(to)\`: new name.
- \`delete(path)\`: delete a path; \`delete(path: "sourceFile")\` removes the input file.

### Actions

- \`runScript(path)\` or \`runScript(code)\`: run a script file/executable, or inline PowerShell code. A script
  file gets the file as its first argument; both see it in $env:CLOP_INPUT_FILE. If the script prints a file path to
  stdout, that file replaces the one the pipeline carries forward. e.g. \`runScript(code: "Copy-Item $env:CLOP_INPUT_FILE D:\\Backup")\`.
  Clop's bundled binaries (ffmpeg, gswin64c, gifski, exiftool, pngquant…) are in $env:CLOP_BIN, e.g.
  \`runScript(code: "& $env:CLOP_BIN\\gswin64c.exe -q -sDEVICE=txtwrite -o ($env:CLOP_INPUT_FILE + '.txt') $env:CLOP_INPUT_FILE")\`
  writes a PDF's text next to it. Inline \`code\` must be one line and must NOT contain \`->\` (the step separator),
  newlines or double quotes; chain commands with \`;\`.
- \`runShortcut(name)\`: run a macOS Shortcut by its name. Kept so pipelines from a Mac load; on Windows use \`runScript\`. [image, video, pdf]
- \`copyToClipboard(format, relativeTo)\`: \`format\`: path (default), imageData (images), markdown.
  \`relativeTo\`: a base path that makes the copied path/link relative (e.g. \`~/Projects/blog\`).
- \`copyLinkForSending(expiration)\`: send the file securely and copy the share link. \`expiration\`
  auto-stops the link (and closes the room) after \`1m\`/\`15m\`/\`1h\`/\`6h\`/\`1d\`/\`3d\` or \`never\`; omit it to
  use the default from Settings. On Windows a share link needs an upload target set in Settings.
- \`fork(location)\`: surface the result-so-far as a SECOND card, then keep processing the main line
  into the first card. The forked card never changes the file the pipeline carries forward, so the
  result path is preserved for later steps (e.g. \`optimise -> fork -> convert(to: webp)\` yields both
  the optimised original AND the webp). [image, video, audio, pdf]
  - Omit \`location\`: the forked file stays in a temp folder and is draggable (drag it out to save).
    Clop copies it only if a LATER step would clobber it (an in-place / move / rename / delete that
    would overwrite the same file); otherwise the forked card just points at the file in place.
  - Give a \`location\` (e.g. \`sameFolder\`, or a path template): the forked file is persisted there,
    using the same location rules as every other step, without disturbing the main line.
- \`shelveWith(app)\`: yoink, dockside, dropover, atoll. \`uploadWith(app)\`: dropshare. These are macOS apps.
  \`openWith(app)\`: an app name or .exe path, e.g. Paint.

## location parameter & path templates

- \`location\` values: \`inPlace\` (replace original), \`sameFolder\` (next to original),
  \`temporaryFolder\`, or a path template. With \`convert\`+\`inPlace\` the original is trashed and replaced.
- Path/template tokens (usable in \`location\`, copy/move/rename/delete \`to\`/\`path\`, watermark \`image\`):
  \`%f\` filename (no extension), \`%e\` extension, \`%P\` parent folder, \`%F\` full path,
  \`%y\` year, \`%m\` month (01–12), \`%n\` month name, \`%d\` day, \`%w\` weekday, \`%H\` hour, \`%M\` minute,
  \`%S\` second, \`%p\` AM/PM, \`%r\` 5 random letters, \`%i\` auto-incrementing number.
- \`$1\`, \`$2\`, … are capture groups from a preceding \`if(regex: ...)\`. \`~\` expands to home.
  When a template has no extension, the output extension is appended automatically.

## Caveats

- Inline = no implicit optimise; add \`optimise\` yourself when you want smaller files.
- Audio bitrate is never increased; \`lowerBitrate\` snaps to the format's allowed bitrates.
- Filters are not branches: a failed \`if\` (or a matched \`ifNot\`) silently stops the file at that
  point; the remaining steps simply don't run. There is no \`else\` and no way to resume.
- Keep steps appropriate to the file type. Only gate with \`if(types: ...)\` when the pipeline runs
  over MIXED types; a pipeline attached/added with a fixed \`--type\`/\`--file-type\` is already scoped,
  so type gating there is redundant.

## Avoiding double encoding

Every \`crop\`, \`downscale\` and \`convert\` re-encodes the file during its own pass; they are not just
geometry/format changes. Each step already compresses to the configured quality on its own, so a
trailing \`optimise\` is not needed to get a small file.

- A trailing \`optimise\` is not double compression. When a later step optimises, the earlier
  crop/downscale/convert deliberately keeps its output at maximum quality and lets that step do the
  single lossy encode. So \`crop(width: 1600) -> convert(to: jpeg)\` and
  \`crop(width: 1600) -> convert(to: jpeg) -> optimise\` both cost exactly one lossy encode and land
  at the same quality. Write whichever reads better; add \`optimise\` when you want to spell out the
  encoder or DPI.
- Consecutive in-place processing steps are compiled into ONE ffmpeg/vips pass, so they encode only
  once. A step with a non-\`inPlace\` \`location\` ends that batch and starts a fresh encode (this is how
  multi-output pipelines are built). \`targetSize\`, \`stripExif\`, \`watermark\`, \`capFps\`, \`normalize\`
  and any GIF conversion never batch; they always run as their own pass.
- What DOES cost quality is stacking two encoding passes that both compress, i.e. steps split
  across separate passes by a non-\`inPlace\` \`location\`. Keep steps \`inPlace\` when you want them
  compiled into one pass.
- For a SAVED pipeline whose steps already encode the file (any \`convert\`/\`downscale\`/\`crop\`), turn
  on "Skip optimisation" so Clop doesn't optimise the original before running your steps. Inline
  \`clop pipeline run\` never adds an implicit optimise, so there's nothing to skip there.

## Running and saving

- Test now: \`clop pipeline run '<steps>' file1 [file2 ...]\`
  Flags: \`--show-result\` show the floating result thumbnail (default hidden), \`--hide-result\`,
  \`--async\`, \`-r\` recurse into folders, \`-s\` skip errors, \`-j\` JSON output,
  \`--types image,video,…\`, \`-n\` no progress.
- Save to the library (runnable by name and shown in the app's Settings → Automation):
  \`clop pipeline add [--file-type image|video|pdf|audio] [--skip-optimisation] [--hide-result] [--force] <name> '<steps>'\`
- Inspect: \`clop pipeline list\`, \`clop pipeline show <name>\`. Remove: \`clop pipeline delete <name>\`.
- In the app, saved pipelines appear as presets in Settings → Automation and can be assigned to run
  automatically per watched folder or input source.

## Automations and preset zones

### attach: run a pipeline automatically on a source

\`clop pipeline attach '<pipeline>' --source <source> --type <type>\`

Attaches a pipeline to a source so it runs automatically on every file of that type coming from
that source. The pipeline argument is either a saved pipeline's name or id (attached as a
reference so it tracks library edits) or inline steps (validated and stored verbatim).

- \`--source\`: \`clipboard\`, \`dropZone\`, or a folder path (\`~\` is expanded, e.g. \`~/Downloads\`).
- \`--type\`: \`image\`, \`video\`, \`pdf\`, or \`audio\`.
- \`--skip-optimisation\`: skip the implicit optimise pass before the pipeline runs (inline only).
- \`--hide-result\`: suppress the floating result thumbnail (inline only).
- A source can hold several attached pipelines for the same type; each \`attach\` appends one.
- Attaching to a FOLDER also starts watching it: the folder is added to Clop's watched folders for
  that type and automatic processing for that type is enabled, so the pipeline fires on its own.
  No \`if(types: <type>)\` step is needed: the attachment is already scoped to \`--type\`.

Examples:
  # Auto-convert every clipboard image to WebP (inline)
  clop pipeline attach 'convert(to: webp)' --source clipboard --type image

  # Run a saved pipeline on every video dropped into the drop zone (reference by name)
  clop pipeline attach 'Social clip' --source dropZone --type video

  # Watermark and move every image saved into a watched folder (inline)
  clop pipeline attach 'watermark(image: "~/logo.png") -> move(to: "~/Watermarked/")' \\
    --source ~/Desktop --type image

### detach: remove attached pipeline(s) from a source

\`clop pipeline detach --source <source> --type <type> (--all | --index <n>)\`

- \`--all\`: remove every pipeline attached to that source/type pair.
- \`--index <n>\`: remove only the pipeline at 0-based position \`n\` (use \`clop pipeline list\` to check order).
- When the last automation for a FOLDER/type is removed, Clop also stops watching that folder for
  that type (the reverse of what \`attach\` set up).

Examples:
  clop pipeline detach --source clipboard --type image --all
  clop pipeline detach --source ~/Downloads --type video --index 1

### preset: manage drop zone preset zones

Preset zones appear when you hold Ctrl or Alt while dragging a file onto the Clop drop zone; dropping onto one
immediately runs its pipeline on that file.

Add a preset zone:
  \`clop pipeline preset add '<name>' '<pipeline>' [--type <type>] [--icon <sf-symbol>] [--skip-optimisation] [--hide-result] [--force]\`

  The pipeline argument is either a saved pipeline's name or id (attached as a reference) or
  inline steps (stored verbatim). Same auto-detection as \`attach\`.

  - \`--type\`: restrict the zone to one file type; omit for an all-types zone.
  - \`--icon\`: SF Symbol name for the zone icon (default: \`wand.and.stars\`).
  - \`--force\`: replace an existing zone with the same id.

Remove a preset zone:
  \`clop pipeline preset remove '<name>' [--type <type>]\`
  Omit \`--type\` to target the all-types zone with that name.

Examples:
  # All-types "Optimise" zone (inline)
  clop pipeline preset add 'Optimise' 'optimise' --icon 'bolt.fill'

  # Image-only "Web ready" zone (inline)
  clop pipeline preset add 'Web ready' 'optimise -> convert(to: webp)' --type image --icon 'globe'

  # Video zone that references a saved library pipeline (by name)
  clop pipeline preset add 'Social clip' 'Social clip' --type video

  # Remove the image-only zone
  clop pipeline preset remove 'Web ready' --type image

## Examples

- Image for the web:            \`optimise -> convert(to: webp)\`
- Just convert (no separate optimise step): \`convert(to: avif)\`  (no-op if the file is already AVIF)
- Sort screenshots:             \`if(regex: "^(screen ?shot|cleanshot)") -> optimise() -> move(to: "~/Pictures/Screenshots/%y/%m/")\`
- Fit under Discord's 10MB:      \`targetSize(size: 10MB)\`
- Video to 1080p MP4:           \`crop(width: 1920) -> optimise(encoder: slowHighQuality)\`
- Video to GIF:                 \`crop(longEdge: 800) -> convert(to: gif)\`
- 2× silent screencast:         \`changeSpeed(factor: 2.0, frames: drop) -> removeAudio -> optimise(encoder: fast)\`
- Audio to 128k MP3:            \`convert(to: mp3) -> lowerBitrate(kbps: 128)\`
- PDF pages to JPEGs:           \`extractPagesAsImages(format: jpeg, quality: high)\`
- Watermark then optimise:      \`watermark(image: "%P/logo.png", position: bottomRight) -> optimise\`

### As full commands (when the request names a folder / source)

- Every photo in Downloads to WebP at max 1600px, into a Sync folder, copy a markdown link:
  \`clop pipeline attach 'crop(longEdge: 1600) -> convert(to: webp, location: "~/Sync/Optimised/") -> copyToClipboard(format: markdown)' --source ~/Downloads --type image\`
  (no \`if(types: image)\` needed: \`--type image\` already scopes it.)
- Auto-convert every clipboard image to WebP:
  \`clop pipeline attach 'convert(to: webp)' --source clipboard --type image\`
- Compress every video saved to ~/Movies for sharing:
  \`clop pipeline attach 'targetSize(size: 25MB)' --source ~/Movies --type video\`
- Save a reusable "Web ready" image pipeline to the library:
  \`clop pipeline add --file-type image 'Web ready' 'convert(to: webp)'\``;

/** `pipelinePromptContext(task:compact:)`: the reference, with the user's request appended when there is one. */
export function pipelinePrompt(task?: string, compact = false): string {
  const out = compact ? COMPACT_PIPELINE_REFERENCE : PIPELINE_REFERENCE;
  if (!task) return out;
  return `${out}\n\n---\n\n## Task\n\n${task}\n\nReturn ONE line: a bare pipeline string, or a full \`clop pipeline add\`/\`attach\` command if the request is to save or automate it.\n`;
}
