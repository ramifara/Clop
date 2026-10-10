import type { CompressionQuality } from '../settings/schema';
import {
  FILE_TYPES, FILTER_FIELDS, STEP_FIELDS, isStepKind, makeStep, newPipelineId, stepProblems, textName,
  type ClopFileType, type Field, type FilterCondition, type Pipeline, type PipelineStep, type PresetZone, type StepKind,
} from './model';
import { PipelineError, describeIssue, parseSteps } from './parser';

// JSON in the shape Swift's Codable gives `Pipeline`, `PipelineStep` and `PresetZone`, so pipelines move between macOS
// and Windows unchanged. Decoding follows the Swift decoders: missing values take their defaults, a pipeline without an
// id gets a new one, and `rawText` is parsed only when `steps` is empty or unreadable. Unlike macOS, a pipeline whose
// steps cannot be read from either is rejected rather than kept with no steps.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (message: string, step?: number): never => { throw new PipelineError([{ message, step }]); };
const json = (text: string) => { try { return JSON.parse(text) as unknown; } catch (error) { return fail(`Not valid JSON: ${(error as Error).message}`); } };
const TIERS: Record<CompressionQuality['tier'], true> = { adaptive: true, lossless: true, fast: true, smaller: true, custom: true };

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
    // The tolerant CompressionQuality decoder: an unknown tier is custom, a missing factor 50, the factor clamped to 0–100.
    case 'compression': {
      if (!isRecord(value)) return wrong('an object with tier and factor');
      const tier = typeof value.tier === 'string' && Object.hasOwn(TIERS, value.tier) ? value.tier as CompressionQuality['tier'] : 'custom';
      return { tier, factor: Number.isInteger(value.factor) ? Math.max(0, Math.min(100, value.factor as number)) : 50 } satisfies CompressionQuality;
    }
    case 'filter': {
      if (!isRecord(value)) return wrong('an object of conditions');
      const condition: Record<string, unknown> = {};
      for (const filterField of FILTER_FIELDS) {
        const item = value[filterField.key];
        if (filterField.key === 'types' && item !== undefined && item !== null) condition.types = Array.isArray(item) && item.every(type => typeof type === 'string') ? [...item] : fail(`${where}: types must be a list of strings`, step);
        else condition[filterField.key] = decodeValue(item, filterField, where, step);
      }
      return condition as FilterCondition;
    }
    case 'shortcut': {
      if (!isRecord(value)) return wrong('an object with name and identifier');
      const name = decodeValue(value.name, { key: 'name', type: 'string', required: true }, where, step) as string;
      return { name, identifier: decodeValue(value.identifier, { key: 'identifier', type: 'string', default: name }, where, step) as string };
    }
  }
}

/** A `PipelineStep` from its Codable JSON. */
export function decodeStep(value: unknown, step?: number): PipelineStep {
  if (!isRecord(value)) return fail('A step must be an object such as {"optimise":{}}', step);
  const kinds = Object.keys(value).filter(isStepKind);
  if (kinds.length !== 1) return fail(kinds.length ? `A step holds one case, found ${kinds.join(', ')}` : `Unknown step ${Object.keys(value).map(key => `"${key}"`).join(', ') || '{}'}`, step);
  const kind = kinds[0], body = value[kind];
  if (!isRecord(body)) return fail(`${kind} must hold an object`, step);
  const params = Object.fromEntries(STEP_FIELDS[kind].map(field => [field.key, decodeValue(body[field.key], field, textName(kind), step)]));
  const decoded = makeStep(kind as StepKind, params);
  const problems = stepProblems(decoded);
  const name = textName(kind);
  return problems.length ? fail(problems.map(({ message }) => message.startsWith(`${name} `) ? message : `${name}: ${message}`).join('; '), step) : decoded;
}

/** A `Pipeline` from its Codable JSON, as an object or as the JSON string macOS keeps in its defaults. */
export function decodePipeline(value: unknown): Pipeline {
  const object = typeof value === 'string' ? json(value) : value;
  if (!isRecord(object)) return fail('A pipeline must be a JSON object');
  const optional = (key: string) => decodeValue(object[key], { key, type: 'string' }, 'pipeline') as string | undefined;
  const flag = (key: string) => decodeValue(object[key], { key, type: 'bool', default: false }, 'pipeline') as boolean;
  const id = optional('id') ?? newPipelineId(), name = optional('name'), rawText = optional('rawText');
  let steps: PipelineStep[] = [], stepsError: unknown;
  try {
    if (object.steps !== undefined && object.steps !== null && !Array.isArray(object.steps)) fail('steps must be a list');
    steps = ((object.steps ?? []) as unknown[]).map(decodeStep);
  } catch (error) { stepsError = error; }
  if (!steps.length && rawText?.trim()) {
    try { steps = parseSteps(rawText); } catch (error) {
      const issues = [stepsError, error].flatMap(e => e instanceof PipelineError ? e.issues : e ? [{ message: String(e) }] : []);
      throw new PipelineError(issues.map(issue => ({ message: `${name ?? id}: ${describeIssue(issue)}` })));
    }
  } else if (stepsError) throw stepsError;
  const fileType = decodeValue(object.fileType, { key: 'fileType', type: FILE_TYPES }, 'pipeline') as ClopFileType | undefined;
  const pipeline: Pipeline = { id, steps, name, rawText, skipOptimisation: flag('skipOptimisation'), hideResult: flag('hideResult'), libraryID: optional('libraryID'), fileType, icon: optional('icon'), details: optional('details') };
  return withoutUndefined(pipeline);
}
const withoutUndefined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

/** The Codable JSON object of a pipeline, keys in Swift's order. */
export const encodePipeline = (p: Pipeline): Pipeline => withoutUndefined({
  id: p.id, steps: p.steps.map(step => { const [kind] = Object.keys(step); return makeStep(kind as StepKind, (step as Record<string, object>)[kind]); }),
  name: p.name, rawText: p.rawText, skipOptimisation: p.skipOptimisation, hideResult: p.hideResult, libraryID: p.libraryID, fileType: p.fileType, icon: p.icon, details: p.details,
});

/** `JSONEncoder().encode(_:)` with default options: compact, and `/` escaped as `\/`. */
export const swiftJSON = (value: unknown) => JSON.stringify(value).replaceAll('/', '\\/');
/** The string macOS stores for a pipeline in `savedPipelines` and `pipelinesToRunOn*`. */
export const pipelineToJSON = (pipeline: Pipeline) => swiftJSON(encodePipeline(pipeline));

/** A `PresetZone`. Zones saved before pipelines carry a `shortcut` instead, which becomes a one-step `runShortcut` pipeline. */
export function decodePresetZone(value: unknown): PresetZone {
  const object = typeof value === 'string' ? json(value) : value;
  if (!isRecord(object)) return fail('A preset zone must be a JSON object');
  const required = (key: string) => decodeValue(object[key], { key, type: 'string', required: true }, 'preset zone') as string;
  const type = decodeValue(object.type, { key: 'type', type: FILE_TYPES }, 'preset zone') as ClopFileType | undefined;
  const shortcut = object.pipeline === undefined || object.pipeline === null ? decodeValue(object.shortcut, { key: 'shortcut', type: 'shortcut' }, 'preset zone') : undefined;
  const pipeline = object.pipeline !== undefined && object.pipeline !== null ? decodePipeline(object.pipeline)
    : { id: newPipelineId(), steps: shortcut ? [makeStep('runShortcut', { _0: shortcut as { name: string; identifier: string } })] : [], skipOptimisation: false, hideResult: false };
  return withoutUndefined({ id: required('id'), icon: required('icon'), name: required('name'), type, pipeline });
}
export const encodePresetZone = (zone: PresetZone): PresetZone => withoutUndefined({ id: zone.id, icon: zone.icon, name: zone.name, type: zone.type, pipeline: encodePipeline(zone.pipeline) });
export const presetZoneToJSON = (zone: PresetZone) => swiftJSON(encodePresetZone(zone));

// Settings hold lists of these. Like the Defaults bridges on macOS, an entry that cannot be read is dropped and the
// rest are kept, so one bad pipeline never costs the whole library.
const readable = <T>(decode: (value: unknown) => T) => (value: unknown): T[] | undefined => Array.isArray(value) ? value.flatMap(item => { try { return [decode(item)]; } catch { return []; } }) : undefined;
export const decodePipelines = readable(decodePipeline);
export const decodePresetZones = readable(decodePresetZone);
/** `pipelinesToRunOn*`: pipelines per source, a folder path or `clipboard`. */
export function decodePipelineSources(value: unknown): Record<string, Pipeline[]> | undefined {
  if (!isRecord(value) || !Object.values(value).every(Array.isArray)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([source, pipelines]) => [source, decodePipelines(pipelines)!]));
}
