import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson } from './dist/storage/files.js';

import { workspaceDiffArgs as args } from './dist/workspace/git.js';

export class MissingDiff extends Error {}
const exec = promisify(execFile);

const gitOptions = {
  encoding: /** @type {const} */ ('utf8'),
  windowsHide: true,
  timeout: 10000,
  maxBuffer: 2 * 1024 * 1024,
};
function diffError(error) {
  const oversized = error.code === 'ENOBUFS' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  const detail = oversized
    ? '单份 diff 超过 2 MiB'
    : error.stderr?.trim().split(/\r?\n/)[0] || error.code || error.message;
  return new MissingDiff('无法读取 Git 工作树的 Git diff：' + detail);
}

export function trackedDiff(cwd) {
  const diff = (staged) =>
    execFileSync('git', args(staged), {
      cwd,
      ...gitOptions,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    return { staged: diff(true), unstaged: diff(false) };
  } catch (error) {
    throw diffError(error);
  }
}

/** @param {string} cwd @param {AbortSignal} [signal] */
export async function inspectTrackedDiff(cwd, signal = undefined) {
  // Preflight runs on the DSH request handler. Avoid blocking other sessions on Git I/O.
  const diff = async (staged) =>
    (await exec('git', args(staged), { cwd, signal, ...gitOptions })).stdout;
  try {
    return { staged: await diff(true), unstaged: await diff(false) };
  } catch (error) {
    throw diffError(error);
  }
}

export function baselineSource(diff) {
  return {
    id: 'git-diff',
    kind: 'diff',
    label: '本轮启动时的 Git diff',
    text: JSON.stringify(diff, null, 2),
  };
}

export async function stepDiff(cwd, directory, executionId, retry) {
  // Resume reuses this execution's input; an explicit retry starts a new attempt.
  const file = join(directory, 'git-input-' + executionId + '.json');
  if (!retry && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const diff = await inspectTrackedDiff(cwd);
  atomicJson(file, diff);
  return diff;
}
