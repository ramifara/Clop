import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEP_KINDS, makeStep, parseAspectRatio, referenceTo, stepKind, textName, type Pipeline } from './model';
import {
  PipelineError, canFormat, cleanupPipelineText, displayText, formatByteSize, formatExpiration, formatStep, formatSteps, formatStepsExactly,
  parseByteSize, parseExpiration, parsePipelineText, parseSteps, portablePathsInText, updateFromText,
} from './parser';
import { STEP_TEMPLATES } from './templates';

const one = (text: string) => { const steps = parseSteps(text); assert.equal(steps.length, 1, text); return steps[0]; };
const issues = (text: string, fileType?: Pipeline['fileType']) => parsePipelineText(text, { fileType }).issues.map(issue => `${issue.line}:${issue.column} ${issue.message}`);

test('every step parses from the forms parsePipelineStep reads', () => {
  const cases: [string, object][] = [
    ['optimise', { optimise: { encoder: 'medium', adaptive: false, location: 'inPlace' } }],
    ['optimise()', { optimise: { encoder: 'medium', adaptive: false, location: 'inPlace' } }],
    ['optimise(encoder: aggressive, adaptive: true, compression: 64, dpi: 150, location: sameFolder)', { optimise: { encoder: 'aggressive', adaptive: true, dpi: 150, location: 'sameFolder', compression: { tier: 'custom', factor: 64 } } }],
    ['optimise(encoder: slowHighQuality, compression: ADAPTIVE)', { optimise: { encoder: 'medium', adaptive: false, videoEncoder: 'slowHighQuality', location: 'inPlace', compression: { tier: 'adaptive', factor: 30 } } }],
    ['optimise(compression: auto)', { optimise: { encoder: 'medium', adaptive: false, location: 'inPlace', compression: { tier: 'custom', factor: 0 } } }],
    ['downscale(factor: .5)', { downscale: { factor: 0.5, location: 'inPlace' } }],
    ['lowerBitrate(kbps: 96, location: "%P/low/%f")', { lowerBitrate: { kbps: 96, location: '%P/low/%f' } }],
    ["convert(to: 'webp')", { convert: { to: 'webp', location: 'sameFolder' } }],
    ['crop(aspectRatio: 16:9, smartCrop: true)', { crop: { aspectRatio: '16:9', smartCrop: true, location: 'inPlace' } }],
    ['crop(height: 1080, longEdge: 2000)', { crop: { height: 1080, longEdge: 2000, smartCrop: false, location: 'inPlace' } }],
    ['extractPagesAsImages', { extractPagesAsImages: { format: 'jpeg', quality: 'medium', location: 'sameFolder' } }],
    ['targetSize(size: 10 MB)', { targetSize: { bytes: 10_000_000, location: 'inPlace' } }],
    ['targetSize(size: 1.5MiB)', { targetSize: { bytes: 1_572_864, location: 'inPlace' } }],
    ['stripExif()', { stripExif: {} }],
    ['watermark(image: "~/logo.png", position: center, opacity: 0.3, scale: 0.5)', { watermark: { image: '~/logo.png', position: 'center', opacity: 0.3, scale: 0.5, location: 'inPlace' } }],
    ['copy(to: "~/a, b/")', { copy: { to: '~/a, b/' } }],
    ['move(to: ~/Sorted/)', { move: { to: '~/Sorted/' } }],
    ['rename(to: "%f-small")', { rename: { to: '%f-small' } }],
    ['delete(path: sourceFile)', { delete: { path: 'sourceFile' } }],
    ['if(regex: "\\d{2,4}", types: png  jpeg)', { filterIf: { _0: { types: ['png', 'jpeg'], regex: '\\d{2,4}' } } }],
    ['if(minFileSize: 2mb, minResolution: 640x480, copiedBy: "Safari")', { filterIf: { _0: { minFileSize: 2_000_000, minResolution: 640, copiedBy: 'Safari' } } }],
    ['ifNot(widthLowerThan: 100, dpiGreaterThan: 300)', { filterIfNot: { _0: { widthLowerThan: 100, dpiGreaterThan: 300 } } }],
    ['removeAudio', { removeAudio: {} }],
    ['changeSpeed(factor: 2, frames: KeepFrames)', { changeSpeed: { factor: 2, frames: 'keepFrames' } }],
    ['capFps(fps: 24)', { capFps: { fps: 24 } }],
    ['normalize', { normalize: { lufs: -16 } }],
    ['normalize(lufs: -23)', { normalize: { lufs: -23 } }],
    ['runScript(code: "Get-Item $env:CLOP_INPUT_FILE")', { runScript: { code: 'Get-Item $env:CLOP_INPUT_FILE' } }],
    ['runScript(path: "C:\\Tools\\post.ps1")', { runScript: { path: 'C:\\Tools\\post.ps1' } }],
    ['runShortcut(name: "Make GIF")', { runShortcut: { _0: { name: 'Make GIF', identifier: 'Make GIF' } } }],
    ['copyToClipboard', { copyToClipboard: { format: 'path' } }],
    ['copyToClipboard(format: imageData, relativeTo: "~/blog")', { copyToClipboard: { format: 'imageData', relativeTo: '~/blog' } }],
    ['copyLinkForSending', { copyLinkForSending: {} }],
    ['copyLinkForSending(expiration: never)', { copyLinkForSending: { expiration: 0 } }],
    ['copyLinkForSending(expiration: 1.5h)', { copyLinkForSending: { expiration: 5400 } }],
    ['fork', { fork: {} }],
    ['fork(location: "%P/forks/%f")', { fork: { location: '%P/forks/%f' } }],
    ['shelveWith(app: Yoink)', { shelveWith: { app: 'yoink' } }],
    ['uploadWith(app: dropshare)', { uploadWith: { app: 'dropshare' } }],
    ['openWith(app: Paint)', { openWith: { app: 'Paint' } }],
  ];
  for (const [text, step] of cases) assert.deepEqual(one(text), step, text);
  const covered = new Set(cases.map(([text]) => stepKind(one(text))));
  assert.deepEqual(STEP_KINDS.filter(kind => !covered.has(kind)), []);
});

test('steps are separated by -> and line breaks, with any spacing', () => {
  const text = '  optimise->convert(to: webp)\r\n\n   ->  copyToClipboard  \n';
  assert.deepEqual(parseSteps(text).map(stepKind), ['optimise', 'convert', 'copyToClipboard']);
  assert.deepEqual(parseSteps(''), []);
  assert.equal(cleanupPipelineText('a()->b->(c)'), 'a() ->b-> (c)');
});

test('the canonical text leaves defaults out and parses back to the same steps', () => {
  const texts = [
    'optimise', 'optimise(encoder: fast, compression: auto, location: "~/out/%f")', 'optimise(encoder: lossless, adaptive: true, compression: adaptive, dpi: 72)',
    'downscale(factor: 0.25, location: temporaryFolder)', 'convert(to: png, location: inPlace)', 'crop(aspectRatio: 4:3, longEdge: 512, smartCrop: true)',
    'extractPagesAsImages(format: png, location: "%P/pages")', 'targetSize(size: 240KB)', 'targetSize(size: 1048576)', 'watermark(image: "it\'s.png", opacity: 0.0)',
    'if(types: png jpeg, nameIs: \'say "hi".png\', minFileSize: 2MB, minResolution: 640x640)', 'changeSpeed(factor: 0.5, frames: drop)', 'normalize(lufs: -14.5)',
    'runScript(code: "Write-Host done")', 'copyLinkForSending(expiration: 3d)', 'copyLinkForSending(expiration: 90s)', 'copyLinkForSending(expiration: never)', 'openWith(app: "Paint, Classic")',
  ];
  for (const text of texts) {
    const steps = parseSteps(text);
    assert.equal(formatSteps(steps), text);
    assert.deepEqual(parseSteps(formatSteps(steps)), steps, text);
  }
  assert.equal(formatSteps(parseSteps('optimise() -> crop(width: 1920, height: 1080) -> changeSpeed(factor: 2) -> extractPagesAsImages(format: jpeg, quality: medium)')),
    'optimise -> crop(width: 1920, height: 1080) -> changeSpeed(factor: 2.0) -> extractPagesAsImages');
  // Visually built filters read as `key: value`, which macOS displayString (`size > 100`) does not parse back from.
  assert.equal(formatStep(makeStep('filterIf', { _0: { fileSizeGreaterThan: 100, copiedBy: 'x' } })), 'if(fileSizeGreaterThan: 100, copiedBy: "x")');
});

test('sizes and durations write back exactly', () => {
  for (const bytes of [1, 999, 1000, 240_000, 1_500_000, 1_234_567, 10_000_000, 2_500_000_000, 1_048_576]) assert.equal(parseByteSize(formatByteSize(bytes)), bytes, String(bytes));
  assert.deepEqual([formatByteSize(10_000_000), formatByteSize(1_500_000), formatByteSize(1_048_576)], ['10MB', '1.5MB', '1048576']);
  for (const seconds of [0, 60, 900, 3600, 21600, 86400, 259200, 90, 5400, 0.5]) assert.equal(parseExpiration(formatExpiration(seconds)), seconds, String(seconds));
  assert.deepEqual([formatExpiration(900), formatExpiration(5400), formatExpiration(90)], ['15m', '90m', '90s']);
  assert.equal(parseByteSize('12 kib'), 12_288);
  assert.equal(parseByteSize('lots'), undefined);
  assert.deepEqual(parseAspectRatio('1.91:1'), { width: 191, height: 100 });
  assert.deepEqual(parseAspectRatio('16 : 9'), { width: 16, height: 9 });
  assert.equal(parseAspectRatio('0:1'), undefined);
  assert.equal(parseAspectRatio('wide'), undefined);
});

test('errors name the problem and point at it', () => {
  assert.deepEqual(issues('optimse -> convert(webp)'), ['1:1 Unknown step "optimse"; did you mean optimise?', '1:20 Expected "name: value", found "webp"; write convert(to: webp)']);
  assert.deepEqual(issues('filterIf(regex: x)\nteleport'), ['1:1 Unknown step "filterIf"; did you mean if?', '2:1 Unknown step "teleport"']);
  assert.deepEqual(issues('crop(widht: 5)'), ['1:6 crop has no parameter "widht"; did you mean width?']);
  assert.deepEqual(issues('copy(to: "a", to: "b")'), ['1:15 to is given twice']);
  assert.deepEqual(issues('downscale(factor: 2) -> downscale(factor: half)'), ['1:19 factor must be a number above 0 and at most 1, got 2', '1:43 factor must be a number, got "half"']);
  assert.deepEqual(issues('downscale -> capFps(fps: 0) -> lowerBitrate(kbps: 12.5)'), ['1:1 downscale needs factor', '1:26 fps must be a whole number above 0, got 0', '1:51 kbps must be a whole number, got "12.5"']);
  assert.deepEqual(issues('optimise(encoder: ultra, adaptive: yes, compression: 3)'), ['1:19 encoder must be aggressive, medium, lossless, fast, slowHighQuality or visuallyLossless, got "ultra"', '1:36 adaptive must be true or false, got "yes"', '1:54 compression must be 5 to 100, adaptive or auto, got "3"']);
  assert.deepEqual(issues('watermark(image: "", opacity: 2, position: middle)'), ['1:18 image needs a value']);
  assert.deepEqual(issues('watermark(image: w.png, position: middle)'), ['1:35 position must be bottomRight, bottomLeft, topRight, topLeft or center, got "middle"']);
  assert.deepEqual(issues('watermark(image: "w.png", opacity: 2)'), ['1:36 opacity must be a number from 0 to 1, got 2']);
  assert.deepEqual(issues('crop(smartCrop: true) -> crop(aspectRatio: wide)'), ['1:1 crop needs width, height, longEdge or aspectRatio', '1:44 aspectRatio must look like 16:9 or 1.91:1, got "wide"']);
  // Regexes are ICU syntax on macOS (`(?i)`, `a++`), so they are left to the executor.
  assert.deepEqual(issues('if() -> ifNot(regex: "(?i)screenshot") -> if(fileSizeGreaterThan: -1)'), ['1:1 if needs at least one condition', '1:67 fileSizeGreaterThan must be a whole number of at least 0, got -1']);
  assert.deepEqual(issues('normalize(lufs: 3) -> changeSpeed(factor: 0) -> changeSpeed(factor: 2, frames: half)'), ['1:17 lufs must be a number from -70 to -5, got 3', '1:43 factor must be a number above 0, got 0', '1:80 frames must be keep or drop, got "half"']);
  assert.deepEqual(issues('runScript -> runScript(path: "a", code: "b") -> shelveWith(app: finder) -> copyLinkForSending(expiration: soon)'), ['1:1 runScript needs a path or code', '1:14 runScript takes a path or code, not both', '1:65 app must be yoink, dockside, dropover or atoll, got "finder"', '1:107 expiration must be a duration such as 15m, 1h, 3d or never, got "soon"']);
  assert.deepEqual(issues('optimise (encoder: fast) -> convert(to: webp -> stripExif('), ['1:9 Expected "(" right after optimise', '1:36 convert(…) is missing its closing ")"', '1:58 stripExif(…) is missing its closing ")"']);
  assert.deepEqual(issues('copy(to: "~/a) -> stripExif'), ['1:16 "->" always separates steps, so it cannot appear inside a quoted value']);
  assert.deepEqual(issues('runScript(code: "a -> b") -> stripExif'), ['1:20 "->" always separates steps, so it cannot appear inside a quoted value']);
  assert.deepEqual(issues('rename(to: "x" y) -> copy(to: "x)'), ['1:12 Unexpected text after the closing " quote', '1:31 Unterminated " quote']);
  assert.deepEqual(issues('convert(to: web p) -> targetSize(size: big)'), ['1:13 to must be a format extension such as webp or mp4, got "web p"', '1:40 size must be a size such as 500KB or 10MB, got "big"']);
});

test('a file type rejects steps, parameters and values that do not work on it', () => {
  assert.deepEqual(issues('removeAudio -> extractPagesAsImages -> lowerBitrate(kbps: 96)', 'image'), [
    '1:1 removeAudio does not work on image files; it works on video files',
    '1:16 extractPagesAsImages does not work on image files; it works on PDF files',
    '1:40 lowerBitrate does not work on image files; it works on audio files',
  ]);
  assert.deepEqual(issues('optimise(encoder: fast, dpi: 100, adaptive: true) -> convert(to: mp4) -> copyToClipboard(format: imageData)', 'image'), [
    '1:30 dpi only works on PDF files', '1:19 encoder fast is a video encoder; image pipelines take aggressive, medium or lossless',
    '1:66 Clop cannot convert image files to mp4; use webp, avif, heic, jxl, jpeg, jpg, png or gif',
  ]);
  assert.deepEqual(issues('copyToClipboard(format: imageData) -> changeSpeed(factor: 2, frames: drop) -> ifNot(widthGreaterThan: 5) -> optimise(adaptive: true)', 'audio'), [
    '1:25 format imageData only works on image files; use path or markdown', '1:70 frames only works on video files', '1:103 widthGreaterThan only works on image files', '1:128 adaptive only works on image files',
  ]);
  assert.deepEqual(issues('optimise(encoder: fast) -> convert(to: gif) -> if(dpiLowerThan: 100)', 'video'), ['1:65 dpiLowerThan only works on image or PDF files']);
  assert.deepEqual(issues('convert(to: webp) -> stripExif', 'pdf'), ['1:1 convert does not work on PDF files; it works on image, video or audio files', '1:22 stripExif does not work on PDF files; it works on image or video files']);
  // Without a file type, anything that parses is fine: any-type library pipelines and the steps a pipeline skips at run time.
  assert.deepEqual(issues('removeAudio -> optimise(encoder: fast, dpi: 100) -> convert(to: tiff)'), []);
  // Every step and every built-in's text name is listed in the editor catalogue.
  assert.deepEqual(STEP_TEMPLATES.map(template => template.name).sort(), STEP_KINDS.map(textName).sort());
});

test('a parse result keeps the good steps for a preview, and parseSteps throws every issue', () => {
  const { steps, issues: found } = parsePipelineText('stripExif -> teleport -> removeAudio');
  assert.deepEqual(steps, [{ stripExif: {} }, { removeAudio: {} }]);
  assert.deepEqual(found, [{ message: 'Unknown step "teleport"', step: 1, offset: 13, length: 8, line: 1, column: 14 }]);
  assert.throws(() => parseSteps('teleport\nwarp'), (error: unknown) => error instanceof PipelineError && error.issues.length === 2 && error.message === 'Line 1, column 1: Unknown step "teleport"\nLine 2, column 1: Unknown step "warp"');
});

test('absolute home paths are stored portable, on Windows and macOS', () => {
  assert.equal(portablePathsInText('copy(to: "C:\\Users\\Rami\\Pictures\\x") -> move(to: "c:/users/rami/Desktop/") -> copy(to: "C:\\Users\\Ramiro\\y")', 'C:\\Users\\Rami'),
    'copy(to: "~\\Pictures\\x") -> move(to: "~/Desktop/") -> copy(to: "C:\\Users\\Ramiro\\y")');
  assert.equal(portablePathsInText('move(to: "/Users/alin/Desktop/") -> move(to: "/Users/Alin/x/")', '/Users/alin'), 'move(to: "~/Desktop/") -> move(to: "/Users/Alin/x/")');
  assert.deepEqual(parseSteps('copy(to: "C:\\Users\\Rami\\Backup\\%f")', { home: 'C:\\Users\\Rami' }), [{ copy: { to: '~\\Backup\\%f' } }]);
  const pipeline: Pipeline = { id: 'p', steps: [], skipOptimisation: false, hideResult: false, fileType: 'image' };
  const updated = updateFromText(pipeline, 'stripExif->copy(to: "C:\\Users\\Rami\\Out\\")', { home: 'C:\\Users\\Rami' });
  assert.deepEqual(updated, { ...pipeline, steps: [{ stripExif: {} }, { copy: { to: '~\\Out\\' } }], rawText: 'stripExif->copy(to: "~\\Out\\")' });
  assert.throws(() => updateFromText(pipeline, 'removeAudio'), /removeAudio does not work on image files/);
});

test('display text is the written text, the steps, or the referenced pipeline', () => {
  const saved: Pipeline = { id: 'lib', steps: [{ stripExif: {} }], name: 'Clean', skipOptimisation: false, hideResult: false };
  assert.equal(displayText({ ...saved, rawText: 'stripExif()' }), 'stripExif()');
  assert.equal(displayText(saved), 'stripExif');
  const reference = referenceTo(saved);
  assert.deepEqual({ ...reference, id: '' }, { id: '', steps: [], skipOptimisation: false, hideResult: false, libraryID: 'lib' });
  assert.equal(displayText(reference, [saved]), 'Clean');
  assert.equal(displayText(reference, []), '');
});

test('a quote opens a value only as its first character, as on macOS', () => {
  assert.deepEqual(one("rename(to: Rami's copy)"), { rename: { to: "Rami's copy" } });
  assert.deepEqual(one("watermark(image: ~/Rami's.png, position: center)"), { watermark: { image: "~/Rami's.png", position: 'center', opacity: 1, scale: 0.15, location: 'inPlace' } });
  // macOS trims quote characters off the ends of a value.
  assert.deepEqual(one("rename(to: Ramis')"), { rename: { to: 'Ramis' } });
  assert.deepEqual(parsePipelineText("move(to: ~/Rami's Files/) -> stripExif -> teleport").steps, [{ move: { to: "~/Rami's Files/" } }, { stripExif: {} }]);
  assert.deepEqual(issues("move(to: ~/Rami's Files/) -> stripExif -> teleport"), ['1:43 Unknown step "teleport"']);
  assert.equal(formatStep(one("rename(to: Rami's copy)")), `rename(to: "Rami's copy")`);
  // After a value cut by "->", parsing resumes with the next step: past the rest of the value, or right away when it never closes.
  assert.deepEqual(issues('copy(to: "~/a) -> stripExif -> teleport'), ['1:16 "->" always separates steps, so it cannot appear inside a quoted value', '1:32 Unknown step "teleport"']);
  assert.deepEqual(issues('runScript(code: "a -> b") -> stripExif -> teleport'), ['1:20 "->" always separates steps, so it cannot appear inside a quoted value', '1:43 Unknown step "teleport"']);
  assert.deepEqual(parsePipelineText('runScript(code: "a -> b") -> stripExif -> teleport').steps, [{ stripExif: {} }]);
});

test('removeAudio is written bare, the only way macOS reads it', () => {
  assert.deepEqual(issues('removeAudio()'), ['1:12 removeAudio takes no parameters; write it without parentheses']);
  assert.deepEqual(issues('stripExif() -> normalize() -> copyToClipboard() -> fork() -> copyLinkForSending()'), []);
});

test('canFormat tells which steps have exact text, and formatStepsExactly refuses the rest', () => {
  const exact = parseSteps('if(regex: "^IMG_(\\d+)", types: png jpeg) -> optimise(encoder: fast, compression: auto) -> rename(to: "Rami\'s") -> runShortcut(name: "Make GIF")');
  assert.ok(exact.every(canFormat));
  assert.equal(formatStepsExactly(exact), formatSteps(exact));
  assert.ok(canFormat(makeStep('filterIf', { _0: { regex: `["']x` } })), 'both quotes, written bare');
  const inexact = [
    makeStep('runScript', { code: 'a -> b' }),
    makeStep('runScript', { code: 'line one\nline two' }),
    makeStep('filterIf', { _0: { nameIs: `it's "a", b` } }),
    makeStep('runShortcut', { _0: { name: 'Make GIF', identifier: '0B6D3C1E-7A2F-4E8B-9D5C-3F1A2B4C6D8E' } }),
    makeStep('normalize', { lufs: -3 }),
    makeStep('convert', { to: 'webp', location: '' }),
    makeStep('optimise', { preset: 'web' } as never),
  ];
  assert.deepEqual(inexact.map(canFormat), inexact.map(() => false));
  assert.throws(() => formatStepsExactly([{ stripExif: {} }, inexact[0]]), (error: unknown) => error instanceof PipelineError && error.message === 'Step 2: runScript cannot be written as text without changing it; edit it as JSON');
});
