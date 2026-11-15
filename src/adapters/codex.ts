import { speedConfig, type Speed } from '../config/speed.js';
import { Codex, type ThreadOptions, type ThreadEvent, type ModelReasoningEffort, type SandboxMode, type ApprovalMode } from "@openai/codex-sdk";

// 进度写入 stderr，Agent 的回答写入 stdout，方便重定向结果。
export function showEvent(event: ThreadEvent, displayMessages = true): void {
  switch (event.type) {
    case "thread.started":
      console.error(`[会话] ${event.thread_id}`);
      break;
    case "turn.started":
      console.error("[执行中] Codex 正在处理任务…");
      break;
    case "item.started":
      if (event.item.type === "command_execution") console.error(`[命令] ${event.item.command}`);
      if (event.item.type === "mcp_tool_call") console.error(`[工具] ${event.item.server}/${event.item.tool}`);
      break;
    case "item.completed": {
      const item = event.item;
      if (item.type === "agent_message" && displayMessages) console.log(item.text);
      if (item.type === "command_execution") console.error(`[命令结束] ${item.status}，退出码 ${item.exit_code ?? "未知"}`);
      if (item.type === "file_change") {
        for (const change of item.changes) console.error(`[文件 ${item.status}] ${change.kind} ${change.path}`);
      }
      if (item.type === "error") console.error(`[提示] ${item.message}`);
      break;
    }
    case "turn.completed":
      console.error(`[完成] 输入 ${event.usage.input_tokens} tokens，输出 ${event.usage.output_tokens} tokens`);
      break;
  }
}

export async function consumeEvents(events: AsyncIterable<ThreadEvent>, onEvent?: (event: ThreadEvent) => void, displayMessages = true, renderEvent?: (event: ThreadEvent) => void): Promise<void> {
  let completed = false;
  for await (const event of events) {
    onEvent?.(event);
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
    if (renderEvent) renderEvent(event);
    else showEvent(event, displayMessages);
    if (event.type === "turn.completed") completed = true;
  }
  if (!completed) throw new Error("Codex 事件流提前结束，任务未确认完成。");
}

export async function runCodex(prompt: string, signal: AbortSignal, options: {
  speed?: Speed; cwd: string; threadId?: string; model?: string; reasoningEffort?: ModelReasoningEffort; sandboxMode?: SandboxMode; approvalPolicy?: ApprovalMode; outputSchema?: unknown; displayMessages?: boolean; renderEvent?: (event: ThreadEvent) => void; onEvent?: (event: ThreadEvent) => void;
}): Promise<void> {
  const codex = new Codex({ codexPathOverride: "codex", config: speedConfig(options.speed) });
  const settings: ThreadOptions = {
    workingDirectory: options.cwd,
    skipGitRepoCheck: true,
    model: options.model,
    modelReasoningEffort: options.reasoningEffort,
    sandboxMode: options.sandboxMode,
    approvalPolicy: options.approvalPolicy,
  };
  const thread = options.threadId
    ? codex.resumeThread(options.threadId, settings)
    : codex.startThread(settings);
  const { events } = await thread.runStreamed(prompt, { signal, outputSchema: options.outputSchema });
  await consumeEvents(events, options.onEvent, options.displayMessages, options.renderEvent);
}
