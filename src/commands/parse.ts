import { parseSpeedArgs, type Speed } from '../config/speed.js';
import type { TaskRequest } from '../execution/prepare.js';
export const usage =
  '用法：sihq chat [list|resume <id>] | run "任务" | plan "需求" | implement <id> | review <id> | list | resume <id> "指令" | workflow "需求" [--max-repairs 0|1|2] | workflow list|status|resume|continue；执行命令支持 --fast|--no-fast';
type WorkflowCommand =
  | { action: 'start'; prompt: string; maxRepairs: number }
  | { action: 'list' }
  | { action: 'status'; id: string }
  | { action: 'resume'; id: string }
  | { action: 'continue'; id: string; prompt: string };
export type Command =
  | { kind: 'interactive' }
  | { kind: 'kernel'; args: string[] }
  | { kind: 'chat'; action: 'start' | 'list'; speed?: Speed }
  | { kind: 'chat'; action: 'resume'; id: string; speed?: Speed }
  | { kind: 'workflow'; request: WorkflowCommand; speed?: Speed }
  | { kind: 'list' }
  | { kind: 'task'; request: TaskRequest; speed?: Speed };
export function parseCommand(input: string[], cwd: string): Command {
  const command = input[0];
  if (command === 'kernel') return { kind: 'kernel', args: input.slice(1) };
  if (
    !['run', 'plan', 'implement', 'review', 'list', 'resume', 'workflow', 'chat'].includes(
      command ?? '',
    ) ||
    (command === 'resume' && input[1]?.startsWith('-'))
  )
    return { kind: 'interactive' };
  const { args, speed } = parseSpeedArgs(input);
  if (
    speed &&
    (command === 'list' ||
      (['chat', 'workflow'].includes(command!) && ['list', 'status'].includes(args[1] ?? '')))
  )
    throw new Error('查询命令不接受速度选项');
  if (command === 'chat') {
    if (args.length === 1) return { kind: 'chat', action: 'start', speed };
    if (args[1] === 'list' && args.length === 2) return { kind: 'chat', action: 'list' };
    if (args[1] === 'resume' && args.length === 3)
      return { kind: 'chat', action: 'resume', id: args[2]!, speed };
    throw new Error('用法：sihq chat | chat resume <chat-id> | chat list');
  }
  if (command === 'workflow') {
    let request: WorkflowCommand;
    if (args[1] === 'list' && args.length === 2) request = { action: 'list' };
    else if ((args[1] === 'status' || args[1] === 'resume') && args.length === 3)
      request = { action: args[1], id: args[2]! };
    else if (args[1] === 'continue' && args.length === 4)
      request = { action: 'continue', id: args[2]!, prompt: args[3]! };
    else {
      const maxRepairs =
        args.length === 2
          ? 2
          : args.length === 4 && args[2] === '--max-repairs' && /^[012]$/.test(args[3] ?? '')
            ? Number(args[3])
            : NaN;
      if (
        !Number.isInteger(maxRepairs) ||
        !args[1]?.trim() ||
        ['status', 'list', 'resume', 'continue'].includes(args[1])
      )
        throw new Error(usage);
      request = { action: 'start', prompt: args[1], maxRepairs };
    }
    return { kind: 'workflow', request, speed };
  }
  if (command === 'list' && args.length === 1) return { kind: 'list' };
  let request: TaskRequest;
  if ((command === 'run' || command === 'plan') && args.length === 2 && args[1]?.trim())
    request = { command, prompt: args[1], cwd };
  else if ((command === 'implement' || command === 'review') && args.length === 2)
    request = { command, sourceId: args[1]! };
  else if (command === 'resume' && args.length === 3 && args[2]?.trim())
    request = { command, sourceId: args[1]!, prompt: args[2] };
  else throw new Error(usage);
  return { kind: 'task', request, speed };
}
