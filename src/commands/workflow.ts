import { WorkflowStore } from '../storage/workflows.js';
import {
  continueWorkflow,
  resumeWorkflow,
  runWorkflow,
  workflowExitCode,
} from '../workflow/runner.js';
import type { Command } from './parse.js';
import { withSignal } from './signals.js';
export async function handleWorkflow({
  request,
  speed,
}: Extract<Command, { kind: 'workflow' }>): Promise<number> {
  const flows = new WorkflowStore();
  if (request.action === 'list') {
    for (const flow of flows.list())
      console.log(`${flow.id}\t${flow.status}\t${flow.stage}\t${JSON.stringify(flow.prompt)}`);
    return 0;
  }
  if (request.action === 'status') {
    console.log(JSON.stringify(flows.read(request.id), null, 2));
    return 0;
  }
  const flow = await withSignal((signal) =>
    request.action === 'start'
      ? runWorkflow(request.prompt, process.cwd(), signal, request.maxRepairs, undefined, speed)
      : request.action === 'resume'
        ? resumeWorkflow(request.id, signal, undefined, speed)
        : continueWorkflow(request.id, request.prompt, signal, undefined, speed),
  );
  return workflowExitCode(flow);
}
