import { WorkflowStore } from '../storage/workflows.js';
import {
  continueWorkflow,
  resumeWorkflow,
  runWorkflow,
  workflowExitCode,
} from '../workflow/runner.js';
import type { Command } from './parse.js';
import { withSignal } from './signals.js';
import type { ProjectScope } from './project-scope.js';
export async function handleWorkflow(
  { request, speed }: Extract<Command, { kind: 'workflow' }>,
  scope?: ProjectScope,
): Promise<number> {
  const flows = new WorkflowStore();
  if (request.action === 'list') {
    for (const flow of flows.list()) {
      if (scope && !scope.includes(flow.cwd)) continue;
      console.log(`${flow.id}\t${flow.status}\t${flow.stage}\t${JSON.stringify(flow.prompt)}`);
    }
    return 0;
  }
  if (request.action === 'status') {
    const record = flows.read(request.id);
    scope?.require(record.cwd);
    console.log(JSON.stringify(record, null, 2));
    return 0;
  }
  if (scope && 'id' in request) scope.require(flows.read(request.id).cwd);
  const flow = await withSignal((signal) =>
    request.action === 'start'
      ? runWorkflow(request.prompt, process.cwd(), signal, request.maxRepairs, undefined, speed)
      : request.action === 'resume'
        ? resumeWorkflow(request.id, signal, undefined, speed)
        : continueWorkflow(request.id, request.prompt, signal, undefined, speed),
  );
  return workflowExitCode(flow);
}
