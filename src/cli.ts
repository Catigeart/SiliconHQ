#!/usr/bin/env node
import { handleChat } from './commands/chat.js';
import { parseCommand, type Command } from './commands/parse.js';
import { handleTask } from './commands/task.js';
import { handleWorkflow } from './commands/workflow.js';
import { startInteractive } from './interactive.js';
import { kernelCli } from './kernel/cli.js';
async function main(): Promise<void> {
  let command: Command;
  try {
    command = parseCommand(process.argv.slice(2), process.cwd());
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
    return;
  }
  switch (command.kind) {
    case 'interactive':
      startInteractive();
      return;
    case 'kernel':
      await kernelCli(command.args);
      return;
    case 'chat':
      process.exitCode = await handleChat(command);
      return;
    case 'workflow':
      process.exitCode = await handleWorkflow(command);
      return;
    case 'task':
    case 'list':
      process.exitCode = await handleTask(command);
      return;
  }
}
main().catch((error) => {
  console.error(`sihq: ${error.message}`);
  process.exitCode = 1;
});
