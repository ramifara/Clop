// The words the MCP server says (ClopCLI/MCPToolTable.swift): the instructions sent at `initialize`, and the questions
// and fallback texts of the three elicitations. Kept word for word; `mcp-table.test.ts` reads the instructions back
// out of the Swift.

/** Sent once at `initialize`. An ambiguity in the user's words has to be caught by the agent, before the call. */
export const INSTRUCTIONS = `Clop does exactly what a tool's arguments say, so settle ambiguous wording with the user before calling a tool, as choices in your own question UI when you have one. Ask every open question in one go, and skip any the user already answered.

- "Smaller" is compression (same pixel size, lower quality: compression 5 to 100 on the file tools, optimise(compression: N) in a pipeline), resolution (fewer pixels: a downscale factor, 0.5 is half the width and height), or both. Ask which, and how much.
- "2x", "3x" or "N times" on a video or audio file is playback speed. Clop has no upscaling step, so it never means a larger frame and there is nothing to ask there.
- A video speed-up either keeps every frame (smoother, the frame rate rises with the speed) or drops frames back to the source rate (smaller file). In a pipeline the answer goes into the step: changeSpeed(factor: 2.0, frames: keep) or frames: drop. On clop_optimise it is playbackSpeedFrames: keep or drop. Left out, it follows the playbackSpeedFrameBehaviour setting, which applies to every video.
- "Silent" or "mute" is removeAudio, and needs no question.
- Attaching a pipeline to a folder makes Clop process every matching file that lands there from then on. Say so before attaching one.

Some tools ask the user themselves, through an elicitation form, when their arguments leave a gap. When that question goes unanswered, the tool returns the options as text: ask in your own chat, then call again with the answer.`;

/** "Make it smaller": compression, resolution or both. `compression` stays optional so picking a target is enough. */
export const SMALLER_SCHEMA = {
  type: 'object',
  properties: {
    target: {
      type: 'string', title: 'Make smaller by', description: 'Compression keeps the pixel size, resolution keeps the quality',
      oneOf: [{ const: 'compression', title: 'Compressing it' }, { const: 'resolution', title: 'Reducing the resolution' }, { const: 'both', title: 'Both' }],
      default: 'compression',
    },
    compression: { type: 'integer', title: 'Compression', description: "5 is the best quality, 100 the smallest file. Leave empty for Clop's compression setting.", minimum: 5, maximum: 100 },
  },
  required: ['target'],
};

export const SMALLER_OPTIONS_TEXT = `Clop can make a file smaller in two ways, and the request did not say which.
  compression: keeps the pixel size and lowers the quality. Pass smallerBy=compression, and compression as 5 to 100 (5 is the best quality, 100 the smallest file; left out, Clop's compression setting applies).
  resolution: keeps the quality and shrinks the pixels. Pass smallerBy=resolution, and downscaleFactor as 0 to 1 (0.5 is half the width and height).
  both: compress and downscale in one pass. Pass smallerBy=both.
Ask the user which they want, then call clop_optimise again with that argument.`;

export const FACTOR_SCHEMA = {
  type: 'object',
  properties: { factor: { type: 'number', title: 'Downscale to', description: 'A fraction of the current size. 0.5 is half the width and height.', minimum: 0.05, maximum: 0.95, default: 0.5 } },
  required: ['factor'],
};

export const FACTOR_OPTIONS_TEXT = `Downscaling needs a number and the request did not carry one. The factor is a fraction of the current size: 0.5 is half the width and height, 0.75 is a quarter off, 0.25 is a quarter of the size. For audio the same factor applies to the bitrate.
Ask the user how much smaller they want it, then call clop_downscale again with factor.`;

/** The option labels are the setting's own, and `current` is that setting, so taking the default changes nothing. */
export const framesSchema = (current: string) => ({
  type: 'object',
  properties: { frames: { type: 'string', title: 'Frames', oneOf: [{ const: 'keep', title: 'Keep frames (smoother, higher fps)' }, { const: 'drop', title: 'Drop frames (smaller file)' }], default: current } },
  required: ['frames'],
});

/** `pipeline` says where the answer goes: into the DSL step, or into clop_optimise's argument. */
export function framesOptionsText(tool: string, current: string, pipeline: boolean) {
  const [keep, drop] = pipeline ? ['Write frames: keep into the changeSpeed step.', 'Write frames: drop.'] : ['Pass playbackSpeedFrames: keep.', 'Pass playbackSpeedFrames: drop.'];
  return `This speeds up video and does not say what happens to the frames. A speed-up leaves more frames per second than the source had, and the request did not say which way to go.
  keep: every frame stays, so motion is smoother and the frame rate rises with the speed (2x of a 30 fps video plays at 60 fps). ${keep}
  drop: frames are dropped back to the source frame rate, so the file is smaller. ${drop}
Leaving it out follows Clop's playbackSpeedFrameBehaviour setting, which is ${current} now.
Ask the user which they want, then call ${tool} again with the answer.`;
}

/** Declined, cancelled and dismissed all end the same way: one line on what happened, then the full options. */
export const CANCELLED_PREFIX = `The question was not answered. Some clients cannot show one at all, a non-interactive session for instance, so ask the user directly instead.
`;
export const DECLINED_PREFIX = 'The user declined to answer, so ask them directly instead.\n';
