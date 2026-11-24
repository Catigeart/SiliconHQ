import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';

export const readonlyCodex = 'sihq-codex-readonly';

async function codexCommand(ctx, signal) {
  let command;
  // DSH launches a standalone CLI outside the Codex Desktop registered app.
  // Keep the CLI's read-only restricted-token sandbox for its child commands.
  /** @type {Record<string, string> | undefined} */
  let env =
    process.platform === 'win32' && process.env.CODEX_WINDOWS_REGISTERED_CORE === '1'
      ? { CODEX_WINDOWS_REGISTERED_CORE: '0' }
      : undefined;
  if (process.platform === 'win32') {
    try {
      command = [await ctx.subprocess.resolveExecutable('codex.exe', undefined, signal)];
    } catch {
      signal.throwIfAborted();
      const shim = await ctx.subprocess.resolveExecutable('codex', undefined, signal);
      const js = join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (!existsSync(js)) throw new Error('DSH 找不到可直接运行的 Codex CLI，请检查 PATH');
      command = [process.execPath, js];
      env = { ...env, ELECTRON_RUN_AS_NODE: '1' };
    }
  } else {
    command = [await ctx.subprocess.resolveExecutable('codex', undefined, signal)];
  }
  signal.throwIfAborted();
  return { command, env };
}

// A JS launcher can spawn a second console even when its own window is hidden.
function windowsCatalogExecutable(command) {
  if (command.length === 1) return command[0];
  const launcher = command[1];
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (!arch) throw new Error('当前 Windows 架构无法读取 Codex 模型目录');
  let packageDir = dirname(dirname(launcher));
  try {
    packageDir = dirname(
      createRequire(launcher).resolve('@openai/codex-win32-' + process.arch + '/package.json'),
    );
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    // Older distributions keep vendor in the launcher package itself.
  }
  const vendor = join(packageDir, 'vendor', arch + '-pc-windows-msvc');
  for (const folder of ['bin', 'codex']) {
    const binary = join(vendor, folder, 'codex.exe');
    if (existsSync(binary)) return binary;
  }
  throw new Error('找不到此 Codex 安装中的 codex.exe，无法读取模型目录');
}

async function readCodexCatalog(ctx, launch, signal) {
  const args = ['debug', 'models', '--bundled'];
  const { command, env } = launch;
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)(windowsCatalogExecutable(command), args, {
      windowsHide: true,
      signal,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  }
  const child = ctx.subprocess.spawn({
    argv: [...command, ...args],
    env,
    signal,
    cwd: process.cwd(),
    graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  });
  child.stderr.resume();
  let body = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    body += chunk;
  });
  const [exit] = await Promise.all([child.done, finished(child.stdout)]);
  if (exit.exitCode !== 0) throw new Error('当前 Codex CLI 无法列出内置模型');
  return body;
}

export async function codexModelCatalog(ctx, productProfile) {
  const signal = AbortSignal.timeout(8000);
  let launch;
  if (productProfile) {
    const root = createRequire(join(productProfile, 'package.json'));
    const entry = root.resolve('@deepseek-ai/dsh-subagent-codex');
    const manifest = createRequire(entry).resolve('@openai/codex/package.json');
    const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin.codex;
    launch = {
      command: [process.execPath, join(dirname(manifest), bin)],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  } else launch = await codexCommand(ctx, signal);
  const body = await readCodexCatalog(ctx, launch, signal);
  return JSON.parse(body)
    .models.filter((m) => m.visibility !== 'hide')
    .map((m) => ({
      id: m.slug,
      name: m.display_name || m.slug,
      efforts: (m.supported_reasoning_levels ?? []).map((e) => ({ id: e.effort, name: e.effort })),
    }));
}
// The official "codex" backend has no per-activation sandbox. This provider
// pins read-only for planning/review and delegates process ownership to DSH.
export function registerReadonlyCodex(ctx) {
  ctx.subagents.registerProvider({
    name: readonlyCodex,
    inheritsParentContext: false,
    capabilities: {
      agentOptions: true,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    },
    async start(request) {
      if (request.prompt.some((block) => block.type !== 'text')) throw new Error('只支持文本输入');
      const { command, env } = await codexCommand(ctx, request.signal);
      const options = request.agentOptions ?? {};
      if (Object.keys(options).some((key) => !['model', 'reasoningEffort'].includes(key)))
        throw new Error('只读 Codex 仅支持 model 和 reasoningEffort');
      const child = ctx.subprocess.spawn({
        argv: [
          ...command,
          'exec',
          '--ephemeral',
          ...(options.model ? ['--model=' + options.model] : []),
          ...(options.reasoningEffort
            ? ['-c', 'model_reasoning_effort=' + JSON.stringify(options.reasoningEffort)]
            : []),
          '--sandbox',
          'read-only',
          '-c',
          'approval_policy="never"',
          '--skip-git-repo-check',
          '--color',
          'never',
          '-',
        ],
        cwd: request.cwd,
        env,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 3000,
        signal: request.signal,
      });
      let answer = '';
      let detail = '';
      let header = '';
      let tooLarge = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (tooLarge) return;
        answer += chunk;
        if (answer.length > 2_000_000) {
          tooLarge = true;
          child.terminate();
        }
      });
      child.stderr.on('data', (chunk) => {
        if (header.length < 4096) header += chunk.slice(0, 4096 - header.length);
        detail = (detail + chunk).slice(-2000);
      });
      child.stdin.on('error', () => {}); // Early exit is reported by the managed process.
      const streamsClosed = Promise.all([finished(child.stdout), finished(child.stderr)]);
      const result = Promise.all([child.done, streamsClosed])
        .then(([exit]) => {
          if (request.signal.aborted) return { stopReason: 'aborted', output: [] };
          if (tooLarge) throw new Error('Codex 报告超过长度限制');
          if (exit.exitCode !== 0 || !answer.trim())
            throw new Error(
              '只读 Codex 未返回报告（' + (exit.exitCode ?? exit.signal) + '）' + detail,
            );
          const model = header.match(/^model:\s*([\w.:/+-]+)\s*$/m)?.[1];
          return {
            stopReason: 'completed',
            output: [{ type: 'text', text: answer.trim() }],
            ...(model && { diagnostic: 'Codex CLI model: ' + model }),
          };
        })
        .catch((error) => ({
          stopReason: 'error',
          output: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        }));
      child.stdin.end(request.prompt.map((block) => block.text).join('\n'));
      return {
        id: randomUUID(),
        result,
        async dispose() {
          child.terminate();
          await child.waitForExit();
        },
      };
    },
  });
}
