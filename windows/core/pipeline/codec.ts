import {
  FILE_TYPES, FILTER_FIELDS, STEP_FIELDS, isStepKind, makeStep, newPipelineId, ordered, textName,
  type ClopFileType, type Field, type Pipeline, type PipelineStep, type PresetZone, type StepKind,
} from './model';
import { PipelineError, describeIssue, parseSteps } from './parser';

// JSON in the shape Swift's Codable gives `Pipeline`, `PipelineStep` and `PresetZone`, so pipelines move between macOS
// and Windows unchanged. Decoding checks only what the Swift decoders check: value types, required keys and enum raw
// values. Values Windows cannot run (a range macOS allows, an ICU regex) are kept as written and reported by
// `pipelineProblems`; values a newer macOS added are kept too. `rawText` is parsed only when `steps` is missing or empty.
// An entry that still cannot be read is kept verbatim in settings (`Unreadable`), so a save never loses it.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (message: string, step?: number): never => { throw new PipelineError([{ message, step }]); };
const json = (text: string) => { try { return JSON.parse(text) as unknown; } catch (error) { return fail(`Not valid JSON: ${(error as Error).message}`); } };
const PIPELINE_KEYS = ['id', 'steps', 'name', 'rawText', 'skipOptimisation', 'hideResult', 'libraryID', 'fileType', 'icon', 'details'];
const ZONE_KEYS = ['id', 'icon', 'name', 'type', 'pipeline'];

/** One value as `decode`/`decodeIfPresent` reads it: null is absent, a wrong type throws. */
function decodeValue(value: unknown, { key, type, default: fallback, required }: Field, where: string, step?: number): unknown {
  if (value === undefined || value === null) return required ? fail(`${where} needs ${key}`, step) : fallback;
  const wrong = (expected: string) => fail(`${where}: ${key} must be ${expected}, got ${JSON.stringify(value)}`, step);
  if (Array.isArray(type)) return typeof value === 'string' && type.includes(value) ? value : wrong(`one of ${type.join(', ')}`);
  switch (type) {
    case 'string': return typeof value === 'string' ? value : wrong('a string');
    case 'int': return Number.isInteger(value) ? value : wrong('a whole number');
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? value : wrong('a number');
    case 'bool': return typeof value === 'boolean' ? value : wrong('true or false');
    // The Swift decoder accepts any object here and reads it tolerantly (`effectiveCompression`).
    case 'compression': return isRecord(value) ? ordered(value, ['tier', 'factor']) : wrong('an object with tier and factor');
    case 'filter': {
      if (!isRecord(value)) return wrong('an object of conditions');
      const condition: Record<string, unknown> = { ...value };
      for (const filterField of FILTER_FIELDS) {
        const item = value[filterField.key];
        if (filterField.key === 'types' && item !== undefined && item !== null) condition.types = Array.isArray(item) && item.every(type => typeof type === 'string') ? [...item] : fail(`${where}: types must be a list of strings`, step);
        else condition[filterField.key] = decodeValue(item, filterField, where, step);
      }
      return condition;
    }
    case 'shortcut': {
      if (!isRecord(value)) return wrong('an object with name and identifier');
      const name = decodeValue(value.name, { key: 'name', type: 'string', required: true }, where, step) as string;
      return { ...value, name, identifier: decodeValue(value.identifier, { key: 'identifier', type: 'string', default: name }, where, step) };
    }
  }
}

/** A `PipelineStep` from its Codable JSON. */
export function decodeStep(value: unknown, step?: number): PipelineStep {
  if (!isRecord(value)) return fail('A step must be an object such as {"optimise":{}}', step);
  const kinds = Object.keys(value).filter(isStepKind);
  if (kinds.length !== 1) return fail(kinds.length ? `A step holds one case, found ${kinds.join(', ')}` : `Unknown step ${Object.keys(value).map(key => `"${key}"`).join(', ') || '{}'}`, step);
  const kind = kinds[0] as StepKind, body = value[kind];
  if (!isRecord(body)) return fail(`${kind} must hold an object`, step);
  const params: Record<string, unknown> = { ...body };
  for (const field of STEP_FIELDS[kind]) params[field.key] = decodeValue(body[field.key], field, textName(kind), step);
  return makeStep(kind, params);
}

/** A `Pipeline` from its Codable JSON, as an object or as the JSON string macOS keeps in its defaults. */
export function decodePipeline(value: unknown): Pipeline {
  const object = typeof value === 'string' ? json(value) : value;
  if (!isRecord(object)) return fail('A pipeline must be a JSON object');
  const optional = (key: string) => decodeValue(object[key], { key, type: 'string' }, 'pipeline') as string | undefined;
  const flag = (key: string) => decodeValue(object[key], { key, type: 'bool', default: false }, 'pipeline') as boolean;
  const id = optional('id') ?? newPipelineId(), name = optional('name'), rawText = optional('rawText');
  if (object.steps !== undefined && object.steps !== null && !Array.isArray(object.steps)) fail('pipeline: steps must be a list');
  let steps = ((object.steps ?? []) as unknown[]).map(decodeStep);
  // Text stored by macOS is read as macOS reads it: only its syntax is checked.
  if (!steps.length && rawText?.trim()) {
    try { steps = parseSteps(rawText, { checkValues: false }); } catch (error) {
      throw new PipelineError((error as PipelineError).issues.map(issue => ({ message: `${name ?? id}: ${describeIssue(issue)}` })));
    }
  }
  const fileType = decodeValue(object.fileType, { key: 'fileType', type: FILE_TYPES }, 'pipeline') as ClopFileType | undefined;
  return ordered({ ...object, id, steps, name, rawText, skipOptimisation: flag('skipOptimisation'), hideResult: flag('hideResult'), libraryID: optional('libraryID'), fileType, icon: optional('icon'), details: optional('details') }, PIPELINE_KEYS) as unknown as Pipeline;
}

/** The Codable JSON object of a pipeline, keys in Swift's order. */
export const encodePipeline = (p: Pipeline): Pipeline => ordered({ ...p, steps: p.steps.map(step => { const [kind] = Object.keys(step); return makeStep(kind as StepKind, (step as Record<string, object>)[kind]); }) }, PIPELINE_KEYS) as unknown as Pipeline;

/** `JSONEncoder().encode(_:)` with default options: compact, and `/` escaped as `\/`. */
export const swiftJSON = (value: unknown) => JSON.stringify(value).replaceAll('/', '\\/');
/** The string macOS stores for a pipeline in `savedPipelines` and `pipelinesToRunOn*`. */
export const pipelineToJSON = (pipeline: Pipeline) => swiftJSON(encodePipeline(pipeline));

/** A `PresetZone`. Zones saved before pipelines carry a `shortcut` instead, which becomes a one-step `runShortcut` pipeline, as on macOS. */
export function decodePresetZone(value: unknown): PresetZone {
  const object = typeof value === 'string' ? json(value) : value;
  if (!isRecord(object)) return fail('A preset zone must be a JSON object');
  const required = (key: string) => decodeValue(object[key], { key, type: 'string', required: true }, 'preset zone') as string;
  const type = decodeValue(object.type, { key: 'type', type: FILE_TYPES }, 'preset zone') as ClopFileType | undefined;
  const hasPipeline = object.pipeline !== undefined && object.pipeline !== null;
  const shortcut = hasPipeline ? undefined : decodeValue(object.shortcut, { key: 'shortcut', type: 'shortcut' }, 'preset zone');
  const pipeline: Pipeline = hasPipeline ? decodePipeline(object.pipeline)
    : { id: newPipelineId(), steps: shortcut ? [makeStep('runShortcut', { _0: shortcut as { name: string; identifier: string } })] : [], skipOptimisation: false, hideResult: false };
  const { shortcut: _legacy, ...rest } = object;
  return ordered({ ...rest, id: required('id'), icon: required('icon'), name: required('name'), type, pipeline }, ZONE_KEYS) as unknown as PresetZone;
}
export const encodePresetZone = (zone: PresetZone): PresetZone => ordered({ ...zone, pipeline: encodePipeline(zone.pipeline) }, ZONE_KEYS) as unknown as PresetZone;
export const presetZoneToJSON = (zone: PresetZone) => swiftJSON(encodePresetZone(zone));

/**
 * A settings entry this version cannot read: a step from a newer macOS, a missing required value. It is kept exactly as
 * it was given (object or Defaults string) and written back unchanged, so it still syncs to the Mac. It cannot run here.
 */
export class Unreadable {
  constructor(readonly raw: unknown, readonly reason: string) {}
  toJSON() { return this.raw; }
}
export type Stored<T> = T | Unreadable;
export const isReadable = <T>(entry: Stored<T>): entry is T => !(entry instanceof Unreadable);

const stored = <T>(decode: (value: unknown) => T) => (value: unknown): Stored<T>[] | undefined => !Array.isArray(value) ? undefined : value.map(item => {
  if (item instanceof Unreadable) return item;
  try { return decode(item); } catch (error) { return new Unreadable(structuredClone(item), (error as Error).message); }
});
export const decodePipelines = stored(decodePipeline);
export const decodePresetZones = stored(decodePresetZone);
/** `pipelinesToRunOn*`: pipelines per source, a folder path or `clipboard`. */
export function decodePipelineSources(value: unknown): Record<string, Stored<Pipeline>[]> | undefined {
  if (!isRecord(value) || !Object.values(value).every(Array.isArray)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([source, pipelines]) => [source, decodePipelines(pipelines)!]));
}
/** The string macOS keeps for a settings entry: a readable one encoded, an unreadable one exactly as it came (a Defaults string stays that string). */
export const storedToJSON = <T>(entry: Stored<T>, encode: (value: T) => string) => !isReadable(entry) ? typeof entry.raw === 'string' ? entry.raw : swiftJSON(entry.raw) : encode(entry);
