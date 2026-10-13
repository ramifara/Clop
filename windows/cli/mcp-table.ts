import * as tools from './mcp-tools';
import type { Handler } from './mcp-tools';

// The 23 tools `clop mcp serve` offers (ClopCLI/MCPToolTable.swift): names, descriptions and input schemas word for
// word, so an agent reads the same thing on both systems. Only what is not true on Windows is reworded: there is no
// Clop Pro, and debug logs need no administrator. `mcp-table.test.ts` compares this table with the Swift.

export interface Tool { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, object>; required?: string[] }; handler: Handler }

/** macOS adds "and the whole MCP server needs Clop Pro"; Clop for Windows has no licence. */
export const GATE = "Refused until the user allows agent changes in Clop Settings, MCP. Clop's own words come back verbatim when it refuses.";

const none = { type: 'object' as const, properties: {} };
const string = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const boolean = (description?: string) => ({ type: 'boolean', ...(description ? { description } : {}) });
const paths = { type: 'array', items: { type: 'string' } };

export const TOOLS: Tool[] = [
  // --- the switch
  {
    name: 'clop_start_server',
    description: 'Ask the user to allow changes through MCP, launching Clop if it is not running. Clop puts an alert on screen and this waits for the answer, so call it once, in response to something the user asked for, and tell them to expect it. Clop refuses every mutating tool until they allow it; reading works either way, and the choice sticks across launches until it is stopped.',
    inputSchema: none, handler: tools.startServer,
  },
  { name: 'clop_stop_server', description: 'Stop allowing changes through MCP. Reading stays available.', inputSchema: none, handler: tools.stopServer },
  {
    name: 'clop_status',
    description: "Clop's version, whether agent changes are allowed, whether script steps are allowed, and where the server lives. Read this first when a tool has been refused.",
    inputSchema: none, handler: tools.status,
  },
  // --- settings
  {
    name: 'clop_settings_schema',
    description: "Every user-facing Clop setting: its key, current value, type, allowed values, and the same title, subtitle and keywords the Settings window shows. Pass a plain-language query to narrow it with Clop's own settings search, which is how a question like 'stop replacing the original' or 'why is the mov not becoming an mp4' finds the control that answers it. Call this before clop_settings_set: the value a set takes is the string form this shows, and a row with type 'none' hosts no key and can only be pointed at.",
    inputSchema: { type: 'object', properties: { query: string("plain-language filter, e.g. 'replace the original', 'pdf quality'") } },
    handler: tools.settingsSchema,
  },
  {
    name: 'clop_settings_get', description: 'Read one setting by its key. Keys come from clop_settings_schema.',
    inputSchema: { type: 'object', properties: { key: string() }, required: ['key'] }, handler: tools.settingsGet,
  },
  {
    name: 'clop_settings_set',
    description: `Change one setting. The value is the string form clop_settings_schema shows: true or false for a bool, a number, or one of the allowed names for an enum. Applies immediately and comes back carrying the new value, so no follow-up read is needed. ${GATE}`,
    inputSchema: { type: 'object', properties: { key: string(), value: string() }, required: ['key', 'value'] }, handler: tools.settingsSet,
  },
  // --- files
  {
    name: 'clop_optimise',
    description: `Optimise images, videos, PDFs and audio in place, or into a copy. Smaller files, same pixels, unless a downscale is asked for. When the request is only 'make this smaller' and carries no compression, factor or crop, Clop asks the user whether to compress, downscale or do both, since those give very different files. Pass smallerBy, compression or downscaleFactor to skip that question; a call with playbackSpeedFactor or removeAudio is never asked it. Placement follows Clop's own setting, which usually rewrites the original, so pass copy when the original must survive. ${GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        paths: { ...paths, description: 'files, folders or URLs' },
        smallerBy: string('compression, resolution or both'),
        compression: string('5 to 100, or adaptive, or auto. Above 75, HDR is converted to SDR'),
        downscaleFactor: { type: 'number', description: '0 to 1, 0.5 is half the width and height' },
        crop: string('WxH, e.g. 1920x1080'),
        pdfDPI: string('adaptive, 300, 250, 200, 150, 100, 72 or 48'),
        playbackSpeedFactor: { type: 'number', description: 'video only, 2 is twice as fast. A speed-up asks the user whether to keep or drop frames unless playbackSpeedFrames says' },
        playbackSpeedFrames: string('keep or drop: what a speed-up does with the frames, for this call alone. keep is smoother, the frame rate rising with the speed; drop goes back to the source frame rate for a smaller file. Omitted on a video speed-up, Clop asks the user'),
        removeAudio: boolean('video only'),
        aggressive: boolean(),
        copy: boolean('keep the original and write a copy'),
        recursive: boolean('walk folders'),
        types: string('comma-separated extensions to include'),
        output: string('output path or template'),
        behaviour: string('temp, inplace, samefolder or specificfolder'),
        skipErrors: boolean(),
      },
      required: ['paths'],
    },
    handler: tools.optimise,
  },
  {
    name: 'clop_downscale',
    description: `Downscale and optimise images, videos and audio by a factor. For audio the factor applies to the bitrate. When no factor is given Clop asks the user for one, since 'a bit smaller' is not a number. ${GATE}`,
    inputSchema: {
      type: 'object',
      properties: { paths, factor: { type: 'number', description: '0 to 1, 0.5 is half the width and height' }, removeAudio: boolean(), aggressive: boolean(), copy: boolean(), recursive: boolean(), types: string(), output: string(), skipErrors: boolean() },
      required: ['paths'],
    },
    handler: tools.downscale,
  },
  {
    name: 'clop_convert',
    description: `Convert files to another format. Images take webp, avif, heic, jxl, jpeg, png or gif; videos take mp4, gif, webm, hevc or av1 (av1 is the MKV video codec, avif is the image format); audio takes mp3, aac, m4a, opus, ogg, flac, wav or aiff. Animated GIF and animated WebP convert into each other with every frame intact; any other image target yields the first frame alone. Where the converted file lands follows Clop's convert placement setting unless convertBehaviour says otherwise. ${GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        paths, kind: string('image, video or audio'), to: string('the target format'), compression: string('5 to 100. Above 75, HDR is converted to SDR'),
        bitrate: { type: 'integer', description: 'audio only, kbps. Beats compression' }, convertBehaviour: string('temp, inplace, samefolder or specificfolder'),
        copy: boolean(), recursive: boolean(), types: string(), output: string(), skipErrors: boolean(),
      },
      required: ['paths', 'kind', 'to'],
    },
    handler: tools.convert,
  },
  {
    name: 'clop_crop',
    description: `Crop and optimise images, videos and PDFs to a size or an aspect ratio. size takes WxH (1920x1080), a ratio (16:9), or a single number with longEdge. smartCrop keeps the interesting part of the frame rather than the centre. ${GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        paths, size: string('WxH, a ratio like 16:9, or a single number with longEdge'), longEdge: boolean('read size as the long edge'), smartCrop: boolean(), removeAudio: boolean(),
        aggressive: boolean(), copy: boolean(), recursive: boolean(), types: string(), output: string(), skipErrors: boolean(),
      },
      required: ['paths', 'size'],
    },
    handler: tools.crop,
  },
  {
    name: 'clop_strip_exif',
    description: `Delete EXIF metadata from images and videos, in place. Location, camera and timestamps go with it, so say what it removes before running it over someone's library. ${GATE}`,
    inputSchema: { type: 'object', properties: { paths, recursive: boolean(), types: string() }, required: ['paths'] },
    handler: tools.stripExif,
  },
  {
    name: 'clop_crop_pdf',
    description: `Crop PDFs to a device screen, a paper size or an aspect ratio, without optimising them. Non-destructive and reversible with clop_uncrop_pdf, since it only moves the crop box. Rewrites the file in place unless output says otherwise. ${GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        paths, forDevice: string('e.g. iPad Air'), paperSize: string('e.g. A4, Letter'), aspectRatio: string('e.g. 1640x2360 or 16:9'), pageLayout: string('portrait, landscape or auto'),
        extend: boolean('extend the page instead of cutting into it'), recursive: boolean(), output: string(),
      },
      required: ['paths'],
    },
    handler: tools.cropPDF,
  },
  {
    name: 'clop_uncrop_pdf', description: `Restore PDFs to their original size by removing the crop box. ${GATE}`,
    inputSchema: { type: 'object', properties: { paths, recursive: boolean(), output: string() }, required: ['paths'] }, handler: tools.uncropPDF,
  },
  // --- pipelines
  {
    name: 'clop_pipeline_prompt',
    description: "Clop's own reference for writing a pipeline: every step, its parameters, the values each one accepts and the caveats. Read this before authoring or editing any pipeline, and reach for a script step only when no built-in step can do the job. Pass compact for the short version.",
    inputSchema: { type: 'object', properties: { task: string('what the pipeline should do, appended as the task'), compact: boolean('the short reference instead of the full one') } },
    handler: tools.pipelinePrompt,
  },
  {
    name: 'clop_pipeline_list',
    description: 'Saved pipelines and folder automations, with the DSL each one runs. An automation carrying only a libraryID is a reference to a saved pipeline, so resolve it against the saved list by id rather than reading it as an empty pipeline.',
    inputSchema: { type: 'object', properties: { all: boolean('also show orphaned automations and broken references') } }, handler: tools.pipelineList,
  },
  { name: 'clop_pipeline_show', description: 'The steps of one saved pipeline, by name.', inputSchema: { type: 'object', properties: { name: string() }, required: ['name'] }, handler: tools.pipelineShow },
  {
    name: 'clop_pipeline_run',
    description: `Run a pipeline over files: a saved pipeline by name, or inline DSL steps as one string. Inline pipelines run exactly the steps written, with no implicit optimise pass, so include an optimise step when one is wanted. Read clop_pipeline_prompt before writing inline steps, and try a draft on one file before a folder. A video speed-up whose changeSpeed step has no frames: keep or drop gets a question to the user first. ${GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        pipeline: string('a saved pipeline name, or inline DSL steps'), paths, recursive: boolean(), types: string(), hideResult: boolean('do not show the floating result'),
        optimiseBehaviour: string(), convertBehaviour: string(), skipErrors: boolean(),
      },
      required: ['pipeline', 'paths'],
    },
    handler: tools.pipelineRun,
  },
  {
    name: 'clop_pipeline_write',
    description: `Ask Clop to save a pipeline to the library, so it can be run by name, attached to a folder or hung on a drop zone. steps is the DSL string: read clop_pipeline_prompt first, and use a built-in step whenever one can do the job, saying which one was tried before reaching for a script. A script step is arbitrary code Clop runs and sits behind its own switch, separate from the MCP switch, so a pipeline carrying one is refused until the user allows script steps and Clop says which step it refused. A video speed-up whose changeSpeed step has no frames: keep or drop gets a question to the user first. ${GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: string(), steps: string('the pipeline DSL, one string'), fileType: string('image, video, pdf or audio. Omit for any type'),
        skipOptimisation: boolean('run only the written steps'), hideResult: boolean(), replace: boolean('replace a pipeline of the same name'),
      },
      required: ['name', 'steps'],
    },
    handler: tools.pipelineWrite,
  },
  { name: 'clop_pipeline_delete', description: `Delete a saved pipeline by name. ${GATE}`, inputSchema: { type: 'object', properties: { name: string() }, required: ['name'] }, handler: tools.pipelineDelete },
  {
    name: 'clop_pipeline_attach',
    description: `Bind a pipeline to a source for one file type: the clipboard, the drop zone, or a folder path. A folder source also starts watching that folder and switches automatic processing on for that type, so every matching file dropped there is processed from then on. Say that to the user before attaching one. A video speed-up whose changeSpeed step has no frames: keep or drop gets a question to the user first. ${GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        pipeline: string('a saved pipeline name or id, or inline DSL steps'), source: string('clipboard, dropZone, or an absolute folder path'), type: string('image, video, pdf or audio'),
        skipOptimisation: boolean(), hideResult: boolean(),
      },
      required: ['pipeline', 'source', 'type'],
    },
    handler: tools.pipelineAttach,
  },
  {
    name: 'clop_pipeline_detach',
    description: `Remove one attached pipeline, by its 0-based index, or all of them for that source and type. clop_pipeline_list shows what is attached where. ${GATE}`,
    inputSchema: {
      type: 'object',
      properties: { source: string('clipboard, dropZone, or an absolute folder path'), type: string('image, video, pdf or audio'), index: { type: 'integer', description: '0-based, from clop_pipeline_list' }, all: boolean() },
      required: ['source', 'type'],
    },
    handler: tools.pipelineDetach,
  },
  {
    name: 'clop_pipeline_preset',
    description: `Add or remove a preset zone on the drop zone: a named target the user drops files on to run one pipeline. Omit type for a zone that takes every file type. A video speed-up whose changeSpeed step has no frames: keep or drop gets a question to the user first. ${GATE}`,
    inputSchema: {
      type: 'object',
      properties: {
        action: string('add or remove. Default add'), name: string("the zone's label"), pipeline: string('a saved pipeline name or id, or inline DSL steps'),
        type: string('image, video, pdf or audio. Omit for all types'), icon: string('SF Symbol name, default wand.and.stars'), skipOptimisation: boolean(), hideResult: boolean(), replace: boolean(),
      },
      required: ['name'],
    },
    handler: tools.pipelinePreset,
  },
  // --- diagnostics
  {
    name: 'clop_debug_logs',
    description: "Turns keeping Clop's debug and info log messages on disk on or off, or reports it, so what happened before anyone started looking can be read later from the log file in Clop's app data folder. Use it when reproducing a problem needs logs from earlier. Turning it on or off is refused until the user allows agent changes in Clop Settings, MCP; status always answers.",
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['on', 'off', 'status'], description: 'on, off or status' } }, required: ['action'] },
    handler: tools.debugLogs,
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));
