import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { lockWorkspace } from '../storage/workspace-lock.js';
import { buildFrozen } from './build.js';
import { command } from './process.js';
import { atomic, manifest, readJson, treeManifest, type State } from './store.js';

export const sanitizerTools = ['memcheck', 'racecheck', 'initcheck', 'synccheck'] as const;
export type SanitizerTool = (typeof sanitizerTools)[number];
export type SanitizerEvidence = {
  status: 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled';
  passed: boolean;
  source: Record<string, string>;
  sizes: number[];
  profile: string;
  policy: 'family-final-v1';
  targetRuntimeVerified: false;
  key?: string;
  error?: string;
  cases: {
    tool: SanitizerTool;
    nb: number;
    status: 'passed' | 'failed' | 'blocked';
    log: string;
    reused: boolean;
    seconds: number;
  }[];
};
export function sanitizerMarkers(nb: number): string[] {
  return [
    [4 * nb, 0, 0],
    [nb + 13, 0, 0],
    [17, 0, 0],
    ...(nb === 32
      ? [
          [45, 0, 1],
          [45, 1, 0],
          [45, 1, 1],
        ]
      : []),
  ].map(([n, u, d]) => `SANITIZE,${nb},${n},${u},${d},DONE`);
}
export function classifySanitizer(
  log: string,
  tool: SanitizerTool,
  nb: number,
  commandFailed = false,
): 'passed' | 'failed' | 'blocked' {
  // Environment failures take precedence over a misleading "0 errors" summary.
  if (
    /Failed to initialize|Device not supported|driver.*(?:insufficient|incompatible)|permission denied|No CUDA-capable|No attachable process|launch timed out|out of memory/i.test(
      log,
    )
  )
    return 'blocked';
  if (/sanitizer workload produced non-finite output/i.test(log)) return 'failed';
  if (
    /ERROR SUMMARY:\s*[1-9]\d*\s+errors|RACECHECK SUMMARY:.*(?:[1-9]\d* errors|[1-9]\d* warnings)/i.test(
      log,
    )
  )
    return 'failed';
  const clean =
    tool === 'racecheck'
      ? /RACECHECK SUMMARY: 0 hazards displayed \(0 errors, 0 warnings\)/.test(log)
      : /ERROR SUMMARY: 0 errors/.test(log);
  const rows = log.split(/\r?\n/).filter((line) => line.startsWith('SANITIZE,'));
  if (commandFailed || !clean || JSON.stringify(rows) !== JSON.stringify(sanitizerMarkers(nb)))
    return 'blocked';
  return 'passed';
}
function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function executable(): string {
  const paths = [
    ...(process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, 'compute-sanitizer')),
    '/usr/local/cuda/bin/compute-sanitizer',
  ];
  const found = paths.find((path) => existsSync(path));
  if (!found) throw new Error('compute-sanitizer 未安装');
  return found;
}

export async function sanitize(
  s: State,
  root: string,
  source: string,
  dest: string,
  signal: AbortSignal,
): Promise<SanitizerEvidence> {
  mkdirSync(dest, { recursive: true });
  const file = join(dest, 'evidence.json');
  const result: SanitizerEvidence = {
    status: 'running',
    passed: false,
    source: manifest(source),
    sizes: s.sizes,
    profile: s.profile,
    policy: 'family-final-v1',
    targetRuntimeVerified: false,
    cases: [],
  };
  const trusted = join(root, 'trusted'),
    trustedHash = readJson(join(root, 'trusted-manifest.json'));
  const gpuLock = join(root, '..', 'gpu-lock');
  mkdirSync(gpuLock, { recursive: true });
  const unlock = lockWorkspace(gpuLock);
  try {
    if (!same(treeManifest(trusted), trustedHash)) throw new Error('固定测试源码被修改');
    const tool = executable(),
      version = join(dest, 'version.log'),
      environment = join(dest, 'environment.log');
    writeFileSync(version, '');
    writeFileSync(environment, '');
    await command([tool, '--version'], dest, version, signal);
    await command(
      ['nvidia-smi', '--query-gpu=uuid,name,driver_version', '--format=csv,noheader'],
      dest,
      environment,
      signal,
    );
    const binary = await buildFrozen(source, trusted, dest, join(dest, 'build.log'), signal);
    const binaryHash = hash(readFileSync(binary));
    result.key = hash(
      JSON.stringify({
        source: result.source,
        trustedHash,
        binaryHash,
        sizes: s.sizes,
        policy: result.policy,
        profile: s.profile,
        visible: process.env.CUDA_VISIBLE_DEVICES ?? '',
        deviceOrder: process.env.CUDA_DEVICE_ORDER ?? '',
        recipe: hash(readFileSync(new URL('./sanitizer.js', import.meta.url))),
        version: readFileSync(version, 'utf8'),
        environment: readFileSync(environment, 'utf8'),
      }),
    );
    const integrity = () => {
      if (
        !same(manifest(source), result.source) ||
        !same(treeManifest(trusted), trustedHash) ||
        hash(readFileSync(binary)) !== binaryHash
      )
        throw new Error('sanitizer 执行期间源码、固定测试或二进制被修改');
    };
    const cache = join(root, 'sanitizer-cache', result.key);
    mkdirSync(cache, { recursive: true });
    for (const toolName of sanitizerTools)
      for (const nb of s.sizes) {
        signal.throwIfAborted();
        integrity();
        const cacheFile = join(cache, `${toolName}-${nb}.json`);
        let old;
        try {
          old = existsSync(cacheFile) ? readJson(cacheFile) : null;
        } catch {
          old = null;
        }
        if (
          old?.status === 'passed' &&
          existsSync(old.log) &&
          hash(readFileSync(old.log)) === old.logHash &&
          classifySanitizer(readFileSync(old.log, 'utf8'), toolName, nb) === 'passed'
        ) {
          result.cases.push({
            tool: toolName,
            nb,
            status: 'passed',
            log: old.log,
            reused: true,
            seconds: 0,
          });
          atomic(file, result);
          continue;
        }
        const log = join(dest, `${toolName}-${nb}.log`);
        writeFileSync(log, '');
        const started = Date.now();
        let failure: unknown;
        try {
          await command(
            [tool, '--tool', toolName, '--error-exitcode', '9', binary, 'sanitize', String(nb)],
            dest,
            log,
            signal,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          failure = error;
        }
        const output = readFileSync(log, 'utf8'),
          status = classifySanitizer(output, toolName, nb, Boolean(failure));
        integrity();
        const record = {
          tool: toolName,
          nb,
          status,
          log,
          reused: false,
          seconds: (Date.now() - started) / 1000,
        };
        result.cases.push(record);
        if (status === 'passed') atomic(cacheFile, { ...record, logHash: hash(output) });
        else {
          result.status = status;
          result.error = `${toolName} nb=${nb} ${status}；日志 ${log}${failure ? '；' + String(failure) : ''}`;
          return result;
        }
        atomic(file, result);
      }
    if (
      !same(manifest(source), result.source) ||
      !same(treeManifest(trusted), trustedHash) ||
      hash(readFileSync(binary)) !== binaryHash
    )
      throw new Error('sanitizer 执行期间源码、固定测试或二进制被修改');
    result.status = 'passed';
    result.passed = true;
    return result;
  } catch (error) {
    result.status = signal.aborted ? 'cancelled' : 'blocked';
    result.error = String(error);
    throw error;
  } finally {
    atomic(file, result);
    unlock();
  }
}
