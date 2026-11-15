import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { lockWorkspace } from '../storage/workspace-lock.js';
import { diagnosticSchema } from './agent.js';
import { buildFrozen, digest } from './build.js';
import { environmentIdentity, evidenceKey, loadEvidence, saveEvidence } from './evidence-cache.js';
import { csv, ncuArguments, ncuExecutable, ncuSamples, sampling } from './performance.js';
import { command } from './process.js';
import { atomic, manifest, type State } from './store.js';
export const capabilities = {
  codegen: { tool: 'cuobjdump', evidence: 'PTX, SASS, resource usage; static evidence only' },
  kernels: {
    tool: 'ncu',
    evidence:
      'kernel replay; base clocks; each launch, duration and geometry; not aggregate benchmark',
  },
  paired: {
    tool: 'ncu',
    evidence: 'alternating archived binaries; unchanged fixed range sampling',
  },
};
export function diagnosticSource(root: string, target: string) {
  if (!/^(baseline|[1-9][0-9]*)$/.test(target)) throw new Error('无效诊断对象');
  const path =
    target === 'baseline' ? join(root, 'baseline') : join(root, 'experiments', target, 'archived');
  if (!existsSync(path)) throw new Error('诊断只接受 baseline 或已有归档：' + target);
  return path;
}
export function kernelRows(report: string) {
  if (/==ERROR==|==WARNING==/.test(report)) throw new Error('NCU 诊断包含警告或错误');
  let header: string[] = [];
  const rows: any[] = [];
  for (const line of report.split(/\r?\n/)) {
    const row = csv(line);
    if (row.includes('Metric Name') && row.includes('Metric Value')) {
      header = row;
      continue;
    }
    const get = (key: string) => row[header.indexOf(key)];
    if (get('Metric Name') !== 'gpu__time_duration.sum') continue;
    const us = ncuSamples(header.map((v) => JSON.stringify(v)).join(',') + '\n' + line, 1, 1)[0];
    if (!get('Kernel Name')) throw new Error('逐 kernel 报告缺少 kernel 名称');
    rows.push({
      id: get('ID'),
      kernel: get('Kernel Name'),
      grid: get('Grid Size'),
      block: get('Block Size'),
      us,
    });
  }
  if (!rows.length) throw new Error('未采集到逐 kernel 时间');
  return rows;
}
export function codegenSummary(resources: string, sass: string) {
  const rows = new Map<string, any>();
  let arch = '',
    name = '';
  for (const line of resources.split(/\r?\n/)) {
    const a = line.match(/^arch = (sm_\d+)/);
    if (a) arch = a[1]!;
    const f = line.match(/^ Function (.+):$/);
    if (f) name = f[1]!;
    if (name && line.includes('REG:'))
      rows.set(arch + ':' + name, {
        architecture: arch,
        kernel: name,
        ...Object.fromEntries(
          [...line.matchAll(/(REG|STACK|SHARED|LOCAL):(\d+)/g)].map((m) => [
            m[1]!.toLowerCase(),
            Number(m[2]),
          ]),
        ),
      });
  }
  arch = '';
  name = '';
  for (const line of sass.split(/\r?\n/)) {
    const a = line.match(/^arch = (sm_\d+)/);
    if (a) {
      arch = a[1]!;
      name = '';
    }
    const f = line.match(/Function : (.+)/);
    if (f) name = f[1]!.trim();
    const offset = line.match(/^\s*\/\*([0-9a-f]+)\*\//i);
    const row = rows.get(arch + ':' + name);
    if (row && offset)
      row.instructionBytes = Math.max(row.instructionBytes ?? 0, parseInt(offset[1]!, 16) + 16);
  }
  return [...rows.values()];
}
export async function diagnose(
  s: State,
  root: string,
  plan: any,
  dest: string,
  signal: AbortSignal,
) {
  const requests = z.array(diagnosticSchema).min(1).max(3).parse(plan.diagnostics);
  if (plan.task === 'remeasure' && requests.some((r) => r.kind !== 'paired'))
    throw new Error('remeasure 仅接受 paired');
  mkdirSync(dest, { recursive: true });
  const gpu = join(root, '..', 'gpu-lock');
  mkdirSync(gpu, { recursive: true });
  const unlock = lockWorkspace(gpu);
  const report: any = { status: 'running', requests: [], targetRuntimeVerified: false };
  try {
    report.environment = environmentIdentity();
    for (const [index, request] of requests.entries()) {
      const result: any = { ...request, results: [] };
      report.requests.push(result);
      const artifacts = [];
      for (const target of request.targets) {
        const source = diagnosticSource(root, target),
          dir = join(dest, String(index), target);
        mkdirSync(dir, { recursive: true });
        const binary = await buildFrozen(
          source,
          join(root, 'trusted'),
          dir,
          join(dir, 'build.log'),
          signal,
        );
        artifacts.push({
          target,
          source: manifest(source),
          binary,
          hash: digest(readFileSync(binary)),
          dir,
        });
      }
      const toolVersion = join(dest, `${index}-tool-version.log`);
      writeFileSync(toolVersion, '');
      await command(
        [
          request.kind === 'codegen' ? '/usr/local/cuda/bin/cuobjdump' : ncuExecutable(),
          '--version',
        ],
        dest,
        toolVersion,
        signal,
      );
      const cacheKey = evidenceKey({
        kind: request.kind,
        sizes: request.sizes,
        repeats: request.repeats,
        artifacts: artifacts.map((a) => ({ target: a.target, source: a.source, hash: a.hash })),
        environment: report.environment,
        tool: readFileSync(toolVersion, 'utf8'),
        recipe: digest(readFileSync(new URL('./diagnostics.js', import.meta.url))),
      });
      const cached =
        request.kind !== 'paired' && !request.refresh ? loadEvidence(root, cacheKey) : undefined;
      if (cached) {
        Object.assign(result, {
          results: cached.evidence.results,
          reused: true,
          origin: cached.evidence.origin,
        });
        continue;
      }
      if (request.kind === 'paired' && artifacts.length !== 2)
        throw new Error('paired 需要恰好两个目标');
      if (request.kind === 'codegen')
        for (const artifact of artifacts) {
          const logs: Record<string, string> = {};
          for (const kind of ['resource-usage', 'ptx', 'sass']) {
            const log = join(artifact.dir, kind + '.log');
            writeFileSync(log, '');
            await command(
              ['/usr/local/cuda/bin/cuobjdump', '--dump-' + kind, artifact.binary],
              artifact.dir,
              log,
              signal,
            );
            logs[kind] = log;
          }
          const summary = codegenSummary(
            readFileSync(logs['resource-usage']!, 'utf8'),
            readFileSync(logs.sass!, 'utf8'),
          );
          const summaryFile = join(artifact.dir, 'codegen-summary.json');
          atomic(summaryFile, summary);
          logs.summary = summaryFile;
          result.results.push({ ...artifact, logs, summary });
        }
      else
        for (const nb of request.sizes)
          for (let repeat = 0; repeat < request.repeats; repeat++) {
            // Alternate A/B then B/A to reduce systematic ordering drift.
            for (const artifact of repeat % 2 ? [...artifacts].reverse() : artifacts) {
              const prefix = join(artifact.dir, `${nb}-${repeat}`),
                log = prefix + '.log',
                csvFile = prefix + '.csv';
              writeFileSync(log, '');
              writeFileSync(csvFile, '');
              const args =
                request.kind === 'paired'
                  ? ncuArguments(artifact.binary, nb, csvFile)
                  : [
                      '--clock-control',
                      'base',
                      '--cache-control',
                      'all',
                      '--profile-from-start',
                      'off',
                      '--replay-mode',
                      'kernel',
                      '--metrics',
                      'gpu__time_duration.sum',
                      '--csv',
                      '--print-units',
                      'base',
                      '--log-file',
                      csvFile,
                      artifact.binary,
                      'bench-ncu',
                      String(nb),
                      '4',
                      '1',
                      '1',
                    ];
              await command([ncuExecutable(), ...args], artifact.dir, log, signal);
              if (/==ERROR==|==WARNING==/.test(readFileSync(log, 'utf8')))
                throw new Error('NCU 诊断出现警告或错误：' + log);
              const raw = readFileSync(csvFile, 'utf8');
              const policy = sampling(nb);
              result.results.push({
                target: artifact.target,
                source: artifact.source,
                binaryHash: artifact.hash,
                nb,
                repeat,
                log,
                csv: csvFile,
                ...(request.kind === 'paired'
                  ? { samples: ncuSamples(raw, policy.groups, policy.iterations) }
                  : { kernels: kernelRows(raw) }),
              });
            }
          }
      for (const a of artifacts)
        if (
          digest(readFileSync(a.binary)) !== a.hash ||
          JSON.stringify(manifest(diagnosticSource(root, a.target))) !== JSON.stringify(a.source)
        )
          throw new Error('诊断期间产物或源码变化');
      if (request.kind !== 'paired') {
        const logs = result.results.flatMap((r: any) =>
          r.logs ? Object.values(r.logs) : [r.log, r.csv],
        );
        saveEvidence(
          root,
          cacheKey,
          { results: result.results, origin: join(dest, 'evidence.json') },
          logs,
        );
      }
    }
    report.status = 'completed';
    return report;
  } catch (error) {
    report.status = signal.aborted ? 'cancelled' : 'unavailable';
    report.error = String(error);
    if (signal.aborted) throw error;
    return report;
  } finally {
    atomic(join(dest, 'evidence.json'), report);
    unlock();
  }
}
