import { prepareTask } from '../execution/prepare.js';
import { executeTask, taskExitCode } from '../execution/tasks.js';
import { RunStore } from '../storage/runs.js';
import { lockWorkspace } from '../storage/workspace-lock.js';
import type { Command } from './parse.js';
import { withSignal } from './signals.js';
import type { ProjectScope } from './project-scope.js';
export async function handleTask(
  command: Extract<Command, { kind: 'task' | 'list' }>,
  scope?: ProjectScope,
): Promise<number> {
  const store = new RunStore();
  if (command.kind === 'list') {
    const runs = store.list().filter((run) => !scope || scope.includes(run.cwd));
    if (!runs.length) console.log('暂无运行记录');
    for (const run of runs)
      console.log(
        `${run.id}\t${run.status}${run.reviewVerdict ? '/' + run.reviewVerdict : run.implementationOutcome ? '/' + run.implementationOutcome : ''}\t${run.updatedAt}\t${JSON.stringify(run.prompt)}`,
      );
    return 0;
  }
  const { request, speed } = command;
  const cwd =
    'cwd' in request
      ? request.cwd
      : 'sourceId' in request
        ? store.read(request.sourceId).cwd
        : request.workflow.cwd;
  scope?.require(cwd);
  const unlock = lockWorkspace(cwd);
  try {
    const { run, prompt } = prepareTask(store, request);
    if (speed) run.speed = speed;
    return await withSignal(async (signal) =>
      taskExitCode(await executeTask(store, run, prompt, signal)),
    );
  } finally {
    unlock();
  }
}
