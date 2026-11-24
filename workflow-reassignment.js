import { currentBatch } from './workflow-control.js';
import { createHash, randomUUID } from 'node:crypto';
import { instancePrefix, instancesOf, resolveRoute } from './agent-instances.js';
import { sameInstanceRoute } from './route-compatibility.js';
import { checkedRoute } from './agent-routing.js';

import { roleForStage } from './dist/workflow/rules.js';

const routeKeys = [
  'backend',
  'baseBackend',
  'product',
  'provider',
  'model',
  'reasoningEffort',
  'agentPreset',
  'instanceId',
  'instanceName',
];

function routeOnly(route) {
  return Object.fromEntries(
    routeKeys.filter((key) => route[key] !== undefined).map((key) => [key, route[key]]),
  );
}

// An old failed record outside the current batch is historical and cannot be dispatched again.
export function failedAttempts(flow) {
  if (!flow.dsh || !['failed', 'cancelled'].includes(flow.status)) return [];
  return currentBatch(flow).filter(
    (step) =>
      !!step.executionId &&
      step.stage !== 'approval' &&
      step.stage !== 'verify' &&
      ['failed', 'cancelled'].includes(step.status),
  );
}

function failedStep(flow, executionId) {
  const step = failedAttempts(flow).find((s) => s.executionId === executionId);
  if (!step) throw new Error('此失败尝试已变更，请刷新详情后再改派');
  return step;
}

function previousRoute(flow, step) {
  const node = flow.dsh.template?.steps.find((s) => s.id === step.node);
  const roles = flow.dsh.roles;
  return routeOnly(
    step.routeOverride ?? node ?? roles?.[roleForStage[step.stage]] ?? roles?.developer,
  );
}

function revision(route) {
  return createHash('sha256')
    .update(JSON.stringify(routeOnly(route)))
    .digest('hex');
}

function instanceRoute(flow, step, instance) {
  const route = resolveRoute({ backend: instancePrefix + instance.id }, [instance]);
  const previous = previousRoute(flow, step);
  if (
    route.instanceId === previous.instanceId &&
    route.baseBackend === previous.baseBackend &&
    sameInstanceRoute(route, previous)
  )
    throw new Error('请选择不同的执行实例或使用原实例重试');
  return route;
}

export async function reassignmentOptions(ctx, config, flow, executionId) {
  const step = failedStep(flow, executionId);
  const named = instancesOf(config);
  const options = await Promise.all(
    named.map(async (instance) => {
      try {
        const route = instanceRoute(flow, step, instance);
        await checkedRoute(
          ctx,
          ctx.get('subagents'),
          route,
          !['implement', 'repair'].includes(step.stage),
          ctx.get('agents')?.get?.(flow.dsh.session),
          { cwd: flow.cwd },
        );
        return {
          id: instance.id,
          name: instance.name,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
          revision: revision(route),
        };
      } catch (error) {
        return { id: instance.id, name: instance.name, reason: error.message };
      }
    }),
  );
  return {
    options: options.filter((row) => !('reason' in row)),
    excluded: options.filter((row) => 'reason' in row),
  };
}

export function resolveReassignment(config, flow, request) {
  if (request.confirmed !== true) throw new Error('请核对工作区并显式确认，再改派此步骤');
  const step = failedStep(flow, request.executionId);
  const instance = instancesOf(config).find((i) => i.id === request.instanceId);
  if (!instance) throw new Error('找不到目标命名实例，请刷新运行详情');
  const route = instanceRoute(flow, step, instance);
  if (request.revision && request.revision !== revision(route))
    throw new Error('目标实例配置已变更，请刷新并重新选择');
  return {
    route,
    readOnly: !['implement', 'repair'].includes(step.stage),
    revision: revision(route),
  };
}

// Called under both locks. The new ID prevents replay of stale confirmations and keeps
// the old DSH delivery trace/receipt available even when repairs share a run directory.
export function reassignAttempt(flow, request, route, runs) {
  const step = failedStep(flow, request.executionId);
  const id = renewAttempt(flow, step, runs);
  step.routeOverride = route;
  step.provider = route.baseBackend ?? route.backend;
  return id;
}

export function retryAttempts(flow, runs) {
  for (const step of failedAttempts(flow)) renewAttempt(flow, step, runs);
}

function renewAttempt(flow, step, runs) {
  const run = runs.read(step.runId);
  step.previousAttempts ??= [];
  step.previousAttempts.push({
    executionId: step.executionId,
    status: step.status,
    route: previousRoute(flow, step),
    error: step.error ?? run.error ?? flow.error,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
  });
  step.executionId = randomUUID();
  step.startedAt = new Date().toISOString();
  delete step.finishedAt;
  delete step.error;
  return step.executionId;
}

export function stepWithOverride(step, override) {
  if (!override) return step;
  const next = { ...step };
  for (const key of routeKeys) delete next[key];
  return { ...next, ...override };
}
