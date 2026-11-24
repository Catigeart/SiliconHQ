import { isAbsolute } from 'node:path';
import { canonicalProjectDirectory, sameProjectDirectory } from './dist/storage/project-path.js';

function localWorkspace(agent, cwd) {
  if (!agent?.id || !cwd || !isAbsolute(cwd)) throw new Error('请打开关联本地项目的 DSH 会话');
  return canonicalProjectDirectory(cwd);
}

export function agentWorkspace(agent, ctx) {
  const service = ctx?.get?.('workingDirectory');
  const cwd = service?.ensure ? service.get(agent?.session) : agent?.session?.header?.cwd;
  return localWorkspace(agent, cwd);
}

export async function ensureAgentWorkspace(ctx, agent, signal) {
  if (!agent?.id) throw new Error('请打开关联本地项目的 DSH 会话');
  const service = ctx.get?.('workingDirectory');
  if (!service?.ensure) return agentWorkspace(agent);
  return localWorkspace(agent, await service.ensure(agent, signal));
}

export function sessionWorkspace(ctx, sessionId) {
  const agent = ctx.get('agents')?.get(sessionId);
  if (!agent) throw new Error('请打开关联本地项目的 DSH 会话');
  return agentWorkspace(agent, ctx);
}

export function scopedFlowForAgent(
  agent,
  id,
  store,
  cwd = agentWorkspace(agent),
  currentOnly = true,
) {
  const flow = currentOnly && store.readCurrent ? store.readCurrent(id) : store.read(id);
  assertScope(flow, agent.id, cwd);
  return flow;
}

export function assertScope(flow, sessionId, cwd) {
  if ((flow.dsh && flow.dsh.session !== sessionId) || !sameProjectDirectory(flow.cwd, cwd))
    throw new Error('请在创建该流程的项目和会话中查看');
}

export function scopedFlow(ctx, sessionId, id, store, currentOnly = true) {
  const agent = ctx.get('agents')?.get(sessionId);
  if (!agent) throw new Error('请打开关联本地项目的 DSH 会话');
  return scopedFlowForAgent(agent, id, store, agentWorkspace(agent, ctx), currentOnly);
}
