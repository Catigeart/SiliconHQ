import type {
  ApprovalMode,
  ModelReasoningEffort,
  SandboxMode,
  ThreadEvent,
} from '@openai/codex-sdk';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { type Speed } from '../config/speed.js';
import { dataDirectory } from '../storage/files.js';
import { executionScope } from '../runtime/context.js';
import { executeOperation, type ExecutionOptions } from '../runtime/executor.js';
import { classify, ExecutionError, fault, outputError } from '../runtime/faults.js';
import { Journal } from '../runtime/journal.js';
import { appServerTurn } from './app-server.js';
import { execTurn } from './exec-transport.js';

// 进度写入 stderr，Agent 的回答写入 stdout，方便重定向结果。
export function showEvent(event: ThreadEvent, displayMessages = true): void {
  switch (event.type) {
    case 'thread.started':
      console.error(`[会话] ${event.thread_id}`);
      break;
    case 'turn.started':
      console.error('[执行中] Codex 正在处理任务…');
      break;
    case 'item.started':
      if (event.item.type === 'command_execution') console.error(`[命令] ${event.item.command}`);
      if (event.item.type === 'mcp_tool_call')
        console.error(`[工具] ${event.item.server}/${event.item.tool}`);
      break;
    case 'item.completed': {
      const item = event.item;
      if (item.type === 'agent_message' && displayMessages) console.log(item.text);
      if (item.type === 'command_execution')
        console.error(`[命令结束] ${item.status}，退出码 ${item.exit_code ?? '未知'}`);
      if (item.type === 'file_change') {
        for (const change of item.changes)
          console.error(`[文件 ${item.status}] ${change.kind} ${change.path}`);
      }
      if (item.type === 'error') console.error(`[提示] ${item.message}`);
      break;
    }
    case 'turn.completed':
      console.error(
        `[完成] 输入 ${event.usage.input_tokens} tokens，输出 ${event.usage.output_tokens} tokens`,
      );
      break;
  }
}

export async function consumeEvents(
  events: AsyncIterable<ThreadEvent>,
  onEvent?: (event: ThreadEvent) => void,
  displayMessages = true,
  renderEvent?: (event: ThreadEvent) => void,
): Promise<void> {
  let completed = false;
  for await (const event of events) {
    onEvent?.(event);
    if (event.type === 'turn.failed') throw new ExecutionError(classify(event.error));
    if (event.type === 'error') {
      // exec drops willRetry. Only a narrow, version-tested reconnect notice is
      // nonterminal; unknown errors still fail closed.
      if (/^Reconnecting\.\.\. \d+\/\d+(?:\s*\(|$)/.test(event.message)) continue;
      throw new ExecutionError(classify(event));
    }
    if (renderEvent) renderEvent(event);
    else showEvent(event, displayMessages);
    if (event.type === 'turn.completed') completed = true;
  }
  if (!completed)
    throw fault('transport', 'STREAM_EOF', 'Codex 事件流提前结束，任务未确认完成。', 'reconcile');
}

export type CodexOptions = {
  speed?: Speed;
  cwd: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
  outputSchema?: unknown;
  displayMessages?: boolean;
  renderEvent?: (event: ThreadEvent) => void;
  onEvent?: (event: ThreadEvent) => void;
  onRawEvent?: (event: unknown) => void;
  onExecutionEvent?: (type: string, data: unknown) => void;
  validateOutput?: (answer: string) => void;
  execution?: { directory: string; id: string; capture?: () => unknown };
  codexPath?: string;
  transport?: 'app-server' | 'exec';
  startupTimeoutMs?: number;
  recoveryPolicy?: ExecutionOptions<string>['policy'];
};
export async function runCodex(
  prompt: string,
  signal: AbortSignal,
  options: CodexOptions,
): Promise<string> {
  const invoke = async (activeSignal: AbortSignal) => {
    const scope = executionScope.getStore();
    let answer = '';
    const emit = (event: ThreadEvent) => {
      if (event.type === 'thread.started') scope?.provider({ threadId: event.thread_id });
      if (event.type === 'item.completed' && event.item.type === 'agent_message')
        answer = event.item.text;
      if (event.type === 'turn.completed' && transport === 'exec')
        scope?.provider({
          terminal: { transport: 'exec', status: 'completed', answer, usage: event.usage },
        });
      if (event.type !== 'error') scope?.progress();
      options.onEvent?.(event); // persistence callbacks are part of the execution contract
      try {
        if (options.renderEvent) options.renderEvent(event);
        else showEvent(event, options.displayMessages);
      } catch {
        /* A terminal renderer must not restart a successful mutation. */
      }
    };
    const recovery = scope?.recovery
      ? `\n上次调用可能已产生修改。先检查当前工作区、已有产物与会话记录，只完成剩余工作，不重复应用已有修改。调用前现场：${JSON.stringify(scope.operation.before)}；上次现场：${JSON.stringify(scope.operation.after)}。`
      : '';
    const feedback = scope?.feedback
      ? `\n上次输出未通过校验，请仅修正报告并输出完整结果：${scope.feedback}`
      : '';
    const transport = options.transport ?? process.env.SIHQ_CODEX_TRANSPORT ?? 'app-server';
    if (!['app-server', 'exec'].includes(transport))
      throw fault('configuration', 'TRANSPORT', '未知 Codex transport：' + transport);
    await (transport === 'exec' ? execTurn : appServerTurn)(
      prompt + recovery + feedback,
      activeSignal,
      options,
      emit,
    );
    if (!answer.trim())
      throw fault('output', 'EMPTY_OUTPUT', 'Codex 调用结束但没有有效回答', 'correct');
    try {
      options.validateOutput?.(answer);
    } catch (error) {
      throw outputError(error);
    }
    return answer;
  };
  if (executionScope.getStore()) return invoke(signal);
  const directory = options.execution?.directory ?? dataDirectory('operations', randomUUID());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return executeOperation({
    journal: new Journal(directory),
    id: options.execution?.id ?? randomUUID(),
    identity: {
      prompt,
      cwd: options.cwd,
      model: options.model,
      effort: options.reasoningEffort,
      speed: options.speed,
      schema: options.outputSchema,
      sandbox: options.sandboxMode,
    },
    signal,
    invoke,
    capture: options.execution?.capture,
    readOnly: options.sandboxMode === 'read-only',
    policy: options.recoveryPolicy,
    validate: (value) => {
      if (typeof value !== 'string')
        throw fault('integrity', 'RESULT_CORRUPT', '持久化回答格式损坏');
      options.validateOutput?.(value);
      return value;
    },
    onEvent:
      options.onExecutionEvent ??
      ((type, data) => console.error(`[${type}] ${JSON.stringify(data)}`)),
  });
}
