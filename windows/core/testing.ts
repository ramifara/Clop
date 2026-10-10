import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { hasTool, type ToolName } from './tools';

/** True when every tool is installed. Missing tools skip the test locally and fail it in CI, which must have the whole bundle. */
export function needTools(t: TestContext, ...names: ToolName[]) {
  const missing = names.filter(name => !hasTool(name));
  if (!missing.length) return true;
  if (process.env.CI) assert.fail(`${missing.join(', ')} missing. Run node scripts/fetch-tools.mjs.`);
  t.skip(`${missing.join(', ')} not installed`);
  return false;
}
