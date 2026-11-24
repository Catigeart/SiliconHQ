import { whileActive } from './cancellation.js';
import { inspectTrackedDiff, baselineSource } from './workflow-git.js';
import { stat } from 'node:fs/promises';
import { checkedRoute } from './agent-routing.js';
import { verificationTool } from './verification-command.js';
import { isAgentStep } from './dist/workflow/rules.js';

const roleNames = {
  planner: '计划及最终汇总',
  developer: '开发与修复',
  reviewer: '独立审查',
  feedback: '开发反馈',
};

/** @param {{onBaseline?: (reference: ReturnType<typeof baselineSource>) => void, baselineReady?: boolean, signal?: AbortSignal}} [options] */
export async function preflightWorkflow(ctx, frozen, cwd, options = {}) {
  const { onBaseline, baselineReady, signal } = options;
  signal?.throwIfAborted();
  const diagnostics = [];
  const issue = (step, message) => diagnostics.push({ step, message });
  const directoryExists =
    typeof cwd === 'string' && (await stat(cwd).catch(() => null))?.isDirectory();
  if (!directoryExists) issue('工作目录', '请选择可访问的本地项目目录');
  if (!ctx.get('jobs')) issue('后台任务', '当前 DSH profile 未启用 Jobs 服务');

  if (directoryExists && frozen.template?.includeDiff && !baselineReady) {
    try {
      const diff = await inspectTrackedDiff(cwd, signal);
      onBaseline?.(baselineSource(diff));
    } catch (error) {
      issue('Git diff', error.message);
    }
  }
  const commands = frozen.template?.steps.filter((s) => s.kind === 'verify') ?? [];
  if (commands.length) {
    try {
      await whileActive(
        verificationTool(ctx, ctx.get('agents')?.get(frozen.session), signal),
        signal,
      );
    } catch (error) {
      for (const step of commands) issue(step.name, error.message);
    }
  }
  const entries = frozen.template
    ? frozen.template.steps.filter(isAgentStep).map((route) => ({
        name: route.name,
        route,
        readOnly: route.kind !== 'develop',
      }))
    : Object.entries(frozen.roles).map(([role, route]) => ({
        name: roleNames[role] ?? role,
        route,
        readOnly: role !== 'developer',
      }));
  const service = ctx.get('subagents');
  const parent = ctx.get('agents')?.get?.(frozen.session);
  const routeChecks = new Map();
  for (const { name, route, readOnly } of entries) {
    signal?.throwIfAborted();
    try {
      const key = JSON.stringify([
        route.backend,
        route.baseBackend,
        route.product,
        route.provider,
        route.model,
        route.reasoningEffort,
        route.agentPreset,
        readOnly,
      ]);
      if (!routeChecks.has(key))
        routeChecks.set(key, checkedRoute(ctx, service, route, readOnly, parent, { cwd }));
      await whileActive(routeChecks.get(key), signal);
    } catch (error) {
      issue(name, error.message);
    }
  }
  signal?.throwIfAborted();
  return { ok: !diagnostics.length, diagnostics };
}

export function assertPreflight(report) {
  if (!report.ok) {
    throw new Error(
      '启动前检查未通过\n' + report.diagnostics.map((d) => d.step + ' · ' + d.message).join('\n'),
    );
  }
}
