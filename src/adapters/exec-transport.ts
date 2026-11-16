import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ThreadEvent } from '@openai/codex-sdk';
import { executionScope } from '../runtime/context.js';
import { fault } from '../runtime/faults.js';
import { managedSpawn } from '../runtime/process.js';
import { consumeEvents, type CodexOptions } from './codex.js';

// Explicit legacy transport, used for old CLI versions and compatibility tests.
// Own the subprocess instead of relying on SDK iterator cleanup semantics.
export async function execTurn(
  prompt: string,
  signal: AbortSignal,
  options: CodexOptions,
  emit: (event: ThreadEvent) => void,
): Promise<void> {
  const saved = executionScope.getStore()?.operation.provider?.terminal as any;
  if (saved?.transport === 'exec' && saved.status === 'completed') {
    emit({
      type: 'item.completed',
      item: { type: 'agent_message', id: 'recovered', text: saved.answer },
    });
    emit({ type: 'turn.completed', usage: saved.usage });
    return;
  }
  const args = ['exec', '--experimental-json', '--skip-git-repo-check', '--cd', options.cwd];
  if (options.model) args.push('--model', options.model);
  if (options.sandboxMode) args.push('--sandbox', options.sandboxMode);
  if (options.reasoningEffort)
    args.push('--config', `model_reasoning_effort="${options.reasoningEffort}"`);
  if (options.approvalPolicy) args.push('--config', `approval_policy="${options.approvalPolicy}"`);
  if (options.speed && options.speed !== 'inherit')
    args.push(
      '--config',
      `service_tier="${options.speed === 'fast' ? 'fast' : 'default'}"`,
      '--config',
      `features.fast_mode=${options.speed === 'fast'}`,
    );
  const temporary = mkdtempSync(join(tmpdir(), 'sihq-schema-'));
  try {
    if (options.outputSchema) {
      const schema = join(temporary, 'schema.json');
      writeFileSync(schema, JSON.stringify(options.outputSchema));
      args.push('--output-schema', schema);
    }
    const scope = executionScope.getStore();
    const threadId = scope?.operation.provider?.threadId ?? options.threadId;
    if (threadId) args.push('resume', threadId);
    const process = managedSpawn([options.codexPath ?? 'codex', ...args], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const { child } = process;
    let stderr = '';
    child.stderr!.on('data', (data) => {
      stderr = (stderr + String(data)).slice(-16000);
    });
    child.stdin!.on('error', () => {});
    const lines = createInterface({ input: child.stdout! });
    const abort = () => {
      void process.close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      child.stdin!.end(prompt);
      async function* events(): AsyncGenerator<ThreadEvent> {
        for await (const line of lines) {
          let value: ThreadEvent;
          try {
            value = JSON.parse(line);
          } catch {
            throw fault('configuration', 'PROTOCOL_JSON', 'Codex exec 返回了无效 JSON');
          }
          options.onRawEvent?.(value);
          yield value;
        }
        const exit = await process.exited;
        signal.throwIfAborted();
        if (exit.code !== 0)
          throw fault(
            'unknown',
            'PROCESS_EXIT',
            `Codex exec 退出 (${exit.code ?? exit.signal})：${stderr}`,
            'reconcile',
          );
      }
      await consumeEvents(events(), emit, false, () => {});
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', abort);
      await process.close();
      lines.close();
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
