import { randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { sameProjectDirectory } from './dist/storage/project-path.js';

const toolName = process.platform === 'win32' ? 'pwsh' : 'bash';
const outputLimit = 8192;

export function verifyCommandAvailable(ctx, parent) {
  const tools = ctx.get('tools');
  return typeof tools?.execute === 'function' && !!tools.executable?.(toolName, parent);
}

// Emit single-quoted literals only. PowerShell treats typographic quotes as
// syntax too; represent these uncommon characters by their exact code point.
function psArgument(value) {
  const parts = value
    .split(/([\u2018-\u201b])/u)
    .map((part) =>
      /^[\u2018-\u201b]$/u.test(part)
        ? '[char]' + part.charCodeAt(0)
        : "'" + part.replaceAll("'", "''") + "'",
    );
  return parts.length === 1 ? parts[0] : '(' + parts.join(' + ') + ')';
}

function shellCommand(argv, marker) {
  if (toolName === 'bash') {
    const args = argv.map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
    // A successful exec replaces this shell, including when the program exits 126 or 127.
    return (
      'shopt -s execfail\nexec -- ' + args + " || { printf '%s\\n' '" + marker + "'; exit 125; }"
    );
  }
  // Invoke native applications, never a PowerShell alias, profile function or cmdlet.
  // Batch launchers reparse arguments with cmd.exe. Reject metacharacters for
  // those launchers before starting them; native applications retain arbitrary argv.
  const program = psArgument(argv[0]);
  const lookup = /[\\/:]/u.test(argv[0])
    ? [
        '$sihqExe = (Get-Item -LiteralPath ' + program + ').FullName',
        "if ($sihqExe -notmatch '\\.(?:exe|com|cmd|bat)\\z') { throw 'Expected a native application or batch launcher.' }",
      ]
    : [
        '$sihqName = ' + program,
        "$sihqExe = (Get-Command -Name $sihqName -CommandType Application -All | Where-Object { $_.Name -eq $sihqName -or ($_.Name -replace '\\.[^.]+$') -eq $sihqName } | Select-Object -First 1).Source",
        "if (-not $sihqExe) { throw 'No application with the exact requested name was found.' }",
      ];
  return [
    "$ErrorActionPreference = 'Stop'",
    "$PSNativeCommandArgumentPassing = 'Standard'",
    '$PSNativeCommandUseErrorActionPreference = $false',
    ...lookup,
    '$sihqArgs = @(' + argv.slice(1).map(psArgument).join(', ') + ')',
    "if ($sihqExe -match '\\.(?:cmd|bat)\\z') {",
    '  foreach ($item in (@($sihqExe) + $sihqArgs)) {',
    "    if ($item -notmatch '^[\\p{L}\\p{N}_./:\\\\@+,= -]+$') { throw 'Batch launchers require simple literal arguments. Use a native executable for other arguments.' }",
    '  }',
    '}',
    '& $sihqExe @sihqArgs',
    '$sihqExit = $LASTEXITCODE',
    "if ($sihqExit -ne 0) { Write-Output '" + marker + "' }",
    'exit $sihqExit',
  ].join('\n');
}

function bounded(text) {
  return text.length > outputLimit ? '…\n' + text.slice(-outputLimit) : text;
}

/** @param {any} ctx @param {any} parent @param {AbortSignal} [signal] */
export async function verificationTool(ctx, parent, signal = undefined) {
  if (!parent?.session || !verifyCommandAvailable(ctx, parent))
    throw new Error('当前会话未启用 DSH 的验证命令执行工具 ' + toolName);
  const prompt = ctx.get('systemPrompt');
  // Public assembly tells us whether this scope accepts native calls or exposes
  // run_code. Choose once, before dispatch, so an ambiguous failure can't rerun a check.
  const assembly = await prompt?.assemble({ scope: parent, signal });

  if (assembly && !assembly.tools.some((t) => t.name === toolName)) {
    const runtime = ctx.get('ptcRuntime');
    if (
      !assembly.tools.some((t) => t.name === 'run_code') ||
      runtime?.language !== 'typescript' ||
      runtime.programFormat !== 'function-body'
    ) {
      throw new Error('当前会话没有可用于结构化验证的 DSH shell 工具。');
    }
    return 'run_code';
  }
  return toolName;
}

async function invoke(ctx, parent, args, signal) {
  const name = await verificationTool(ctx, parent, signal);
  const input =
    name === 'run_code'
      ? {
          description: args.description,
          code: 'return await tools.' + toolName + '(' + JSON.stringify(args) + ')',
        }
      : args;
  const tools = ctx.get('tools');
  const id = randomUUID();
  const batch = await tools.execute({
    calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(input) }],
    agent: parent,
    signal,
  });
  const entry = batch.results.find((item) => item.callId === id);
  if (!entry || entry.result.isError !== false)
    throw new Error(entry?.result.error?.message || 'DSH 未返回可核实的工具结果。');
  return name === 'run_code' ? entry.result.value?.result : entry.result.value;
}

export async function stopVerificationJob(ctx, parent, id) {
  const jobs = ctx.get('jobs');
  try {
    if (
      jobs?.kill &&
      jobs.wait &&
      jobs.kill(id, parent.id, 'SiliconHQ verification deadline') !== 'already-finished'
    ) {
      for (;;) {
        const job = await jobs.wait(id, 5000, parent.id);
        if (job.status !== 'running' && job.status !== 'stopping') break;
      }
    }
  } catch (error) {
    // A throwing cancel leaves the producer live. Keep the durable fence and
    // allow the owning session to retry, rather than hiding the provider error.
    if (error.code !== 'JOB_NOT_FOUND') throw error;
  }
  // RC5's pwsh/bash producers await their ShellProcess.done before reporting.
  // A forced registry settlement can precede process close, even after wait().
  const events = parent.session?.snapshotEvents?.() ?? parent.session?.events ?? [];
  const settled = events.find(
    (event) =>
      event.type === 'job/settled' && event.data?.owner === parent.id && event.data.jobId === id,
  )?.data;
  if (
    settled?.kind !== toolName ||
    settled.producerReported !== true ||
    !['producer', 'kill', 'teardown'].includes(settled.cause) ||
    !['completed', 'killed', 'failed'].includes(settled.status)
  )
    throw new Error(
      '等待确认验证命令停止 · ' +
        id +
        '。本会话缺少可确认命令已退出的 shell 结束记录，工作区暂时禁止新的写入。',
    );
}

export async function executeVerification(
  ctx,
  parent,
  cwd,
  verification,
  signal,
  onStopping = (_id) => {},
  waitForStop = async (work, _signal) => {
    await work;
    return true;
  },
) {
  const started = Date.now();
  const { argv, timeoutMs = 120_000 } = verification;
  const report = {
    outcome: 'failed',
    passed: false,
    commandFailed: false,
    summary: '',
    durationMs: 0,
    cwd,
    argv,
    timeoutMs,
    exitCode: /** @type {number|null} */ (null),
    timedOut: false,
    cancelled: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  let timer;
  let timedOut = false;
  try {
    if (
      !isAbsolute(cwd) ||
      !Array.isArray(argv) ||
      !argv[0]?.trim() ||
      argv.some((s) => typeof s !== 'string' || s.includes('\0')) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2_147_483_647
    )
      throw new Error('验证命令、绝对工作目录或超时无效。');
    const marker = 'sihq-verify-' + randomUUID();
    signal.throwIfAborted();
    const deadline = new AbortController();
    timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, timeoutMs);
    const active = AbortSignal.any([signal, deadline.signal]);
    const result = await invoke(
      ctx,
      parent,
      {
        description: '执行工作流验证命令 ' + argv[0],
        // hw reads Git's UTF-8 path list via Python subprocess text mode. Set the
        // encoding only in this invocation so Chinese filenames survive Windows pipes.
        command:
          (toolName === 'pwsh' && /^hw(?:\.exe)?$/i.test(basename(argv[0]))
            ? "$env:PYTHONUTF8='1'\n$env:PYTHONIOENCODING='utf-8'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n"
            : '') + shellCommand(argv, marker),
        workdir: cwd,
        timeoutMs,
      },
      active,
    );
    if (result?.kind === 'promoted' || result?.kind === 'background') {
      // RC5 caps the caller's foreground timeout to its own maxTimeoutMs.
      // A promoted Jobs view carries presentation text, not the typed exit
      // result (its producer even renders a missing exitCode as 0).
      report.timedOut = result.kind === 'promoted' && result.timeoutMs >= timeoutMs;
      const hostLimit = Number.isFinite(result.timeoutMs)
        ? `（宿主前台期限 ${result.timeoutMs} ms，步骤期限 ${timeoutMs} ms）`
        : '';
      if (typeof result.output === 'string') {
        report.stdout = bounded(result.output);
        report.stdoutTruncated = result.output.length > outputLimit;
      }
      report.jobId = result.jobId;
      try {
        onStopping(result.jobId);
      } finally {
        const settled = await waitForStop(stopVerificationJob(ctx, parent, result.jobId), active);
        if (!settled) throw new Error('正在等待宿主停止验证任务 · ' + result.jobId);
      }
      onStopping(undefined);
      throw new Error('DSH 将命令转入后台' + hostLimit + '，无法核实结构化退出码，已停止其任务。');
    }
    if (
      result?.kind !== 'foreground' ||
      !isAbsolute(result.cwd ?? '') ||
      !sameProjectDirectory(result.cwd, cwd) ||
      typeof result.stdout?.text !== 'string' ||
      typeof result.stderr?.text !== 'string' ||
      typeof result.timedOut !== 'boolean' ||
      typeof result.aborted !== 'boolean'
    )
      throw new Error('DSH shell 返回的工作目录或退出结果无法核实。');
    const raw = result.stdout.text;
    const marked = raw.trimEnd().endsWith(marker);
    const launchFailed =
      Number.isInteger(result.exitCode) &&
      result.exitCode !== 0 &&
      (toolName === 'pwsh' ? !marked : result.exitCode === 125 && marked);
    report.exitCode = !launchFailed && Number.isInteger(result.exitCode) ? result.exitCode : null;
    const stdout = marked ? raw.slice(0, raw.lastIndexOf(marker)) : raw;
    report.stdout = bounded(stdout);
    report.stderr = bounded(result.stderr.text);
    report.stdoutTruncated = !!result.stdout.truncated || stdout.length > outputLimit;
    report.stderrTruncated = !!result.stderr.truncated || result.stderr.text.length > outputLimit;
    report.timedOut = result.timedOut || timedOut;
    report.cancelled = result.aborted || signal.aborted;
    report.passed =
      report.exitCode === 0 &&
      result.signal === null &&
      !report.cancelled &&
      !report.timedOut &&
      !result.sandbox?.denied &&
      !result.sandbox?.runnerFailed;
    report.commandFailed =
      report.exitCode !== null &&
      report.exitCode !== 0 &&
      result.signal === null &&
      !report.cancelled &&
      !report.timedOut &&
      !result.sandbox?.denied &&
      !result.sandbox?.runnerFailed;
    report.outcome = report.passed ? 'passed' : 'failed';
    report.summary = report.passed
      ? '验证通过'
      : result.sandbox?.denied
        ? '验证被宿主沙箱拒绝'
        : report.timedOut
          ? '验证超时'
          : report.cancelled
            ? '验证已取消'
            : launchFailed
              ? '验证程序未启动或未取得程序退出码，请检查命令和运行环境'
              : '验证失败（退出码 ' + (report.exitCode ?? '未知') + '）';
  } catch (error) {
    report.timedOut ||= timedOut;
    report.cancelled ||= signal.aborted;
    report.summary = report.timedOut ? '验证超时' : report.cancelled ? '验证已取消' : '验证失败';
    report.stderr = bounded(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    report.durationMs = Date.now() - started;
  }
  return report;
}
