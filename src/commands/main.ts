import { handleChat } from './chat.js';
import { parseCommand, type Command } from './parse.js';
import { handleTask } from './task.js';
import { handleWorkflow } from './workflow.js';
import { startInteractive } from '../interactive.js';
import { kernelCli } from '../kernel/cli.js';
import type { ProjectScope } from './project-scope.js';

export async function runCli(scope?: ProjectScope): Promise<void> {
  let command: Command;
  try {
    command = parseCommand(process.argv.slice(2), process.cwd());
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
    return;
  }
  try {
    switch (command.kind) {
      case 'interactive':
        if (scope) throw new Error('交互式命令请在终端使用。');
        startInteractive();
        return;
      case 'kernel':
        await kernelCli(command.args, undefined, scope);
        return;
      case 'chat':
        process.exitCode = await handleChat(command, scope);
        return;
      case 'workflow':
        process.exitCode = await handleWorkflow(command, scope);
        return;
      case 'task':
      case 'list':
        process.exitCode = await handleTask(command, scope);
        return;
    }
  } catch (error) {
    console.error('sihq: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
