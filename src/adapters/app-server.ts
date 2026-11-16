import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ThreadEvent } from '@openai/codex-sdk';
import { speedConfig } from '../config/speed.js';
import { executionScope } from '../runtime/context.js';
import { classify, ExecutionError, fault } from '../runtime/faults.js';
import { managedSpawn } from '../runtime/process.js';
import type { CodexOptions } from './codex.js';
import { assertCodexProtocol } from './protocol.js';

type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: any };
// A response with an RPC error confirms that this request was rejected. A lost
// response has an unknown outcome and must be reconciled before resubmission.
class RpcResponseError extends ExecutionError {}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function providerError(value: any, threadId?: string, turnId?: string) {
  return new ExecutionError({ ...classify(value), provider: 'codex', threadId, turnId });
}

// Deliberately small protocol client: generated 0.169 schemas were checked during
// development. Unknown notifications are retained; malformed terminal messages fail.
export async function appServerTurn(
  prompt: string,
  signal: AbortSignal,
  options: CodexOptions,
  emit: (event: ThreadEvent) => void,
): Promise<void> {
  const scope = executionScope.getStore();
  const terminal = scope?.operation.provider?.terminal as any;
  const emitted = new Set<string>();
  let threadId = scope?.operation.provider?.threadId ?? options.threadId;
  let turnId: string | undefined;
  let usage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
  const completed = deferred<void>();
  let accepting = false;
  let providerFailure: ExecutionError | undefined;
  function item(value: any, phase: 'started' | 'completed') {
    if (!value || typeof value.id !== 'string' || typeof value.type !== 'string')
      throw fault('configuration', 'PROTOCOL_ITEM', 'Codex item 事件结构不兼容');
    if (phase === 'completed' && emitted.has(value.id)) return;
    let mapped: any;
    if (value.type === 'agentMessage')
      mapped = { type: 'agent_message', id: value.id, text: value.text };
    if (value.type === 'commandExecution')
      mapped = {
        type: 'command_execution',
        id: value.id,
        command: value.command,
        aggregated_output: value.aggregatedOutput ?? '',
        exit_code: value.exitCode ?? null,
        status: value.status === 'inProgress' ? 'in_progress' : value.status,
      };
    if (value.type === 'fileChange')
      mapped = {
        type: 'file_change',
        id: value.id,
        status: value.status,
        changes: (value.changes ?? []).map((change: any) => ({
          path: change.path,
          kind: typeof change.kind === 'string' ? change.kind : (change.kind?.type ?? 'update'),
        })),
      };
    if (value.type === 'mcpToolCall')
      mapped = {
        type: 'mcp_tool_call',
        id: value.id,
        server: value.server,
        tool: value.tool,
        arguments: value.arguments,
        result: value.result,
        error: value.error,
        status: value.status === 'inProgress' ? 'in_progress' : value.status,
      };
    if (mapped) emit({ type: `item.${phase}`, item: mapped } as ThreadEvent);
    if (phase === 'completed') emitted.add(value.id);
  }
  function finish(turn: any) {
    if (
      !turn ||
      typeof turn.id !== 'string' ||
      !['completed', 'failed', 'interrupted'].includes(turn.status)
    )
      throw fault('configuration', 'PROTOCOL_TERMINAL', 'Codex turn 终态结构不兼容');
    turnId = turn.id;
    scope?.provider({ threadId, turnId, terminal: turn });
    if (turn.status === 'completed') {
      for (const value of turn.items ?? []) item(value, 'completed');
      emit({ type: 'turn.completed', usage });
      completed.resolve();
    } else {
      completed.reject(
        turn.error
          ? providerError(turn.error, threadId, turnId)
          : (providerFailure ??
              fault(
                turn.status === 'interrupted' ? 'cancelled' : 'unknown',
                'TURN_' + turn.status.toUpperCase(),
                'Codex 调用终止：' + turn.status,
              )),
      );
    }
  }
  if (terminal?.status === 'completed') {
    if (scope?.operation.provider?.usage) usage = scope.operation.provider.usage as typeof usage;
    if (threadId) emit({ type: 'thread.started', thread_id: threadId });
    finish(terminal);
    await completed.promise;
    return;
  }
  signal.throwIfAborted();
  const process = managedSpawn(
    [options.codexPath ?? 'codex', 'app-server', '--listen', 'stdio://'],
    { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const { child } = process;
  const pending = new Map<number | string, ReturnType<typeof deferred<any>>>();
  let sequence = 0,
    stderr = '',
    shuttingDown = false;
  let fatal: unknown;
  const fail = (error: unknown) => {
    fatal ??= error;
    for (const value of pending.values()) value.reject(error);
    pending.clear();
    completed.reject(error);
  };
  child.stderr!.on('data', (data) => {
    stderr = (stderr + String(data)).slice(-16000);
  });
  child.stdin!.on('error', (error) => fail(error));
  const lines = createInterface({ input: child.stdout! });
  const send = (message: Message) => {
    if (child.stdin!.destroyed)
      throw fault('transport', 'PIPE_CLOSED', 'Codex 通道已关闭', 'reconcile');
    child.stdin!.write(JSON.stringify(message) + '\n');
  };
  const request = async (
    method: string,
    params: unknown,
    timeoutMs = options.startupTimeoutMs ?? 30_000,
  ) => {
    if (fatal) throw fatal;
    const id = ++sequence,
      value = deferred<any>();
    pending.set(id, value);
    const timer = setTimeout(
      () =>
        value.reject(fault('timeout', 'RPC_TIMEOUT', `Codex ${method} 未确认完成`, 'reconcile')),
      timeoutMs,
    );
    try {
      send({ id, method, params });
      return await value.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  lines.on('line', (line) => {
    try {
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        throw fault('configuration', 'PROTOCOL_JSON', 'Codex app-server 返回了无效 JSON');
      }
      options.onRawEvent?.(message);
      if (message.id !== undefined && !message.method) {
        const value = pending.get(message.id);
        if (message.error)
          value?.reject(
            new RpcResponseError(classify({ ...message.error, ...message.error.data })),
          );
        else value?.resolve(message.result);
        return;
      }
      if (message.id !== undefined && message.method) {
        // Unattended managed work never leaves an approval request hanging.
        if (/requestApproval$/.test(message.method))
          send({ id: message.id, result: { decision: 'decline' } });
        else
          send({
            id: message.id,
            error: {
              code: -32601,
              message: 'Interactive request unavailable in managed execution',
            },
          });
        scope?.event('provider.request.declined', { method: message.method });
        return;
      }
      const p = message.params;
      if (!accepting || !p || p.threadId !== threadId) return;
      if (turnId && p.turnId && p.turnId !== turnId) return;
      if (message.method === 'turn/started') {
        if (!p.turn?.id) throw fault('configuration', 'PROTOCOL_TURN', 'Codex turn 缺少 ID');
        if (turnId && p.turn.id !== turnId) return;
        turnId = p.turn.id;
        scope?.provider({ threadId, turnId, terminal: undefined });
        emit({ type: 'turn.started' });
        scope?.progress();
      } else if (message.method === 'error') {
        if (typeof p.willRetry !== 'boolean' || typeof p.error?.message !== 'string')
          throw fault(
            'configuration',
            'PROTOCOL_ERROR',
            'Codex 错误事件缺少 willRetry/message，请检查协议版本',
          );
        providerFailure = providerError(p.error, threadId, p.turnId ?? turnId);
        scope?.event(p.willRetry ? 'provider.reconnecting' : 'provider.error', {
          ...providerFailure.failure,
          willRetry: p.willRetry,
        });
        // Wait for the terminal turn. Reconnect messages do not count as progress.
      } else if (message.method === 'turn/completed') {
        if (turnId && p.turn?.id !== turnId) return;
        finish(p.turn);
      } else if (message.method === 'item/started' || message.method === 'item/completed') {
        item(p.item, message.method === 'item/started' ? 'started' : 'completed');
        scope?.progress();
      } else if (message.method === 'thread/tokenUsage/updated') {
        const last = p.tokenUsage?.last;
        if (last)
          usage = {
            input_tokens: last.inputTokens ?? 0,
            output_tokens: last.outputTokens ?? 0,
            cached_input_tokens: last.cachedInputTokens ?? 0,
            cache_write_input_tokens: last.cacheWriteInputTokens ?? 0,
            reasoning_output_tokens: last.reasoningOutputTokens ?? 0,
          };
        scope?.provider({ usage });
      } else if (/^item\/.*(?:delta|Delta)$/.test(message.method ?? '')) scope?.progress();
    } catch (error) {
      fail(error);
    }
  });
  void process.exited.then(({ code, signal: exitSignal }) => {
    if (!shuttingDown)
      fail(
        fault(
          'transport',
          'PROCESS_EXIT',
          `Codex 进程提前退出 (${code ?? exitSignal})：${stderr}`,
          'reconcile',
        ),
      );
  }, fail);
  lines.on('close', () => {
    if (!shuttingDown)
      fail(fault('transport', 'STREAM_EOF', 'Codex 事件流提前结束，任务未确认完成', 'reconcile'));
  });
  const aborted = () => {
    fail(signal.reason);
    if (threadId && turnId) {
      try {
        send({ id: ++sequence, method: 'turn/interrupt', params: { threadId, turnId } });
      } catch {}
    }
  };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    signal.throwIfAborted();
    const initialized = await request('initialize', {
      clientInfo: { name: 'siliconhq', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    assertCodexProtocol(initialized?.userAgent);
    scope?.provider({ version: initialized?.userAgent });
    send({ method: 'initialized' });
    const oldTurnId = scope?.operation.provider?.turnId;
    if (scope?.recovery && threadId && (oldTurnId || scope.operation.provider?.submitted)) {
      const stored = await request('thread/read', { threadId, includeTurns: true });
      const previous = stored?.thread?.turns?.find((turn: any) =>
        oldTurnId
          ? turn.id === oldTurnId
          : turn.items?.some(
              (entry: any) =>
                entry.type === 'userMessage' &&
                entry.content?.some(
                  (content: any) =>
                    content.type === 'text' &&
                    content.text?.includes(
                      `[SiliconHQ operation ${scope.operation.provider?.requestId ?? scope.operation.id}]`,
                    ),
                ),
            ),
      );
      if (previous?.status === 'completed') {
        if (scope.operation.provider?.usage) usage = scope.operation.provider.usage as typeof usage;
        emit({ type: 'thread.started', thread_id: threadId });
        finish(previous);
        await completed.promise;
        return;
      }
      if (previous?.status === 'inProgress' && stored.thread?.status?.type === 'active')
        throw fault('resource', 'TURN_STILL_ACTIVE', '原 Codex turn 仍在执行，拒绝重复启动');
      if (!previous)
        throw fault(
          'unknown',
          'OUTCOME_UNKNOWN',
          'Codex 请求可能已接受，但历史中未能确认对应 turn；保留现场，暂不重复提交',
          'reconcile',
        );
      scope.event('provider.reconciled', {
        threadId,
        turnId: oldTurnId,
        status: previous?.status ?? 'unknown',
      });
    }
    const settings = {
      cwd: options.cwd,
      model: options.model,
      sandbox: options.sandboxMode,
      approvalPolicy: options.approvalPolicy ?? 'never',
      config: {
        ...speedConfig(options.speed),
        ...(options.reasoningEffort ? { model_reasoning_effort: options.reasoningEffort } : {}),
      },
    };
    let started;
    try {
      started = await request(threadId ? 'thread/resume' : 'thread/start', {
        ...settings,
        ...(threadId ? { threadId } : {}),
      });
    } catch (error) {
      if (
        !threadId ||
        scope?.operation.provider?.submitted ||
        !/thread[^\n]*not found|no rollout found/i.test(String(error))
      )
        throw error;
      scope?.event('provider.session.reconstructed', {
        previousThreadId: threadId,
        reason: String(error),
      });
      started = await request('thread/start', settings);
    }
    if (typeof started.thread?.id !== 'string')
      throw fault('configuration', 'PROTOCOL_THREAD', 'Codex thread 响应缺少 ID');
    threadId = started.thread.id;
    scope?.provider({ threadId, turnId: undefined, terminal: undefined });
    emit({ type: 'thread.started', thread_id: threadId! });
    accepting = true;
    const requestId = scope
      ? `${scope.operation.id}:attempt-${scope.operation.attempt}`
      : undefined;
    scope?.provider({ submitted: true, usage: undefined, requestId });
    const response = await request('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text: prompt + (requestId ? `\n[SiliconHQ operation ${requestId}]` : ''),
          text_elements: [],
        },
      ],
      effort: options.reasoningEffort,
      model: options.model,
      outputSchema: options.outputSchema,
      ...(options.speed && options.speed !== 'inherit'
        ? { serviceTier: options.speed === 'fast' ? 'fast' : 'default' }
        : {}),
    }).catch((error) => {
      if (error instanceof RpcResponseError && !turnId)
        scope?.provider({ submitted: false, requestId: undefined });
      throw error;
    });
    if (typeof response.turn?.id !== 'string')
      throw fault('configuration', 'PROTOCOL_TURN', 'Codex turn 响应缺少 ID');
    turnId = response.turn.id;
    scope?.provider({ threadId, turnId });
    await completed.promise;
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', aborted);
    // Give an interrupted turn a short cooperative cleanup interval, then drain
    // the owned process group. Even successful turns may leave tool descendants.
    if (signal.aborted && turnId) await sleep(100);
    shuttingDown = true;
    fail(fault('cancelled', 'CLIENT_CLOSED', 'Codex 客户端已关闭'));
    await process.close();
    lines.close();
  }
}
