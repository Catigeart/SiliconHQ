import { delegationDepthOptions } from './delegation-depth.js';
import { readonlyCodex } from './codex-backend.js';
import {
  checkProductWorkspace,
  developmentRestriction,
  externalBridge,
  productEntries,
  selectProductSpec,
} from './product-adapter.js';
import { validatePreset, readonlyPreset as readPreset } from './preset-options.js';
import {
  effectiveAgentRoute,
  inspectModel,
  InvalidModelRoute,
  usesHostModels,
} from './model-route.js';

/** @param {any} service @param {any} route @param {boolean} readOnly @param {any} [ctx] @param {any} [parent] @param {string} [cwd] */
export function routeFor(
  service,
  route,
  readOnly,
  ctx = undefined,
  parent = undefined,
  cwd = undefined,
) {
  const product = ctx && productEntries(ctx).get(route.baseBackend ?? route.backend);
  if (ctx && route.product && route.product !== product?.product)
    throw new Error('产品后端绑定已变化，请重新选择基础后端');
  const restriction = developmentRestriction(product);
  if (!readOnly && restriction) throw new Error(restriction);
  if (route.backend === externalBridge && ctx) {
    const requested = {
      provider: route.backend,
      agentOptions: {
        provider: route.baseBackend,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
      },
    };
    const selected = selectProductSpec(ctx, route, requested);
    if (selected.provider !== route.backend)
      route = {
        ...route,
        backend: selected.provider,
        provider: undefined,
        model: undefined,
        reasoningEffort: undefined,
      };
  }
  const provider = service?.getProvider(route.backend);
  if (!provider)
    throw new Error(
      '当前 DSH profile 未注册子 Agent provider “' +
        route.backend +
        '”。请在插件页启用或更正其注册名。',
    );
  if (!readOnly && ctx) checkProductWorkspace(ctx, provider, parent, cwd);
  const caps = provider.capabilities;
  if (route.agentPreset) {
    if (!caps.agentPreset || provider.inheritsParentContext)
      throw new Error(route.backend + ' 不支持独立指定 DSH Agent 预设');
    if (readOnly && route.agentPreset !== readPreset)
      throw new Error('只读步骤只接受 ' + readPreset + ' 预设，请为开发预设选择开发步骤。');
    if (!readOnly && route.agentPreset === readPreset)
      throw new Error('只读 Agent 预设不能用于开发步骤。');
  }
  if (!readOnly && route.backend === readonlyCodex)
    throw new Error(
      '开发步骤需要工作区写权限。请在 SiliconHQ 工作流设置中将 ' +
        readonlyCodex +
        ' 换成允许编辑的开发 provider。',
    );
  if (
    readOnly &&
    route.backend !== readonlyCodex &&
    (!caps.agentPreset || provider.inheritsParentContext)
  )
    throw new Error(
      route.backend + ' 无法逐次指定只读预设。计划和审查可选择 spawn 或 ' + readonlyCodex,
    );
  if (route.backend === readonlyCodex && route.provider)
    throw new Error('只读 Codex 的模型供应商由 Codex CLI 管理');
  if (route.provider || route.model || route.reasoningEffort)
    route = effectiveAgentRoute(route, provider);
  const llm = route.provider && usesHostModels(route.backend, provider) && ctx?.get('llm');
  if (llm?.listProviders && !llm.listProviders().some((p) => p.id === route.provider))
    throw new Error('DSH 未注册模型供应商 ' + route.provider);
  if (route.provider || route.model || route.reasoningEffort) {
    if (!caps.agentOptions)
      throw new Error(route.backend + ' 从 provider 自身配置读取模型，请清空该角色的模型覆盖。');
  }
  return {
    provider: route.backend,
    ...delegationDepthOptions(service, provider, parent),
    ...(readOnly && route.backend !== readonlyCodex && { agentPreset: readPreset }),
    ...(route.agentPreset && { agentPreset: route.agentPreset }),
    ...(route.provider || route.model || route.reasoningEffort
      ? {
          agentOptions: {
            ...(route.provider && { provider: route.provider }),
            ...(route.backend === externalBridge &&
              product?.product && { expectedProduct: product.product }),
            ...(route.model && { model: route.model }),
            ...(route.reasoningEffort && { reasoningEffort: route.reasoningEffort }),
          },
        }
      : {}),
  };
}

// Health checks, workflow preflight and every fresh dispatch validate the effective spec.
/** @param {{cwd?: string, includeCatalog?: boolean}} [options] */
export async function checkedRoute(
  ctx,
  service,
  route,
  readOnly,
  parent = undefined,
  options = {},
) {
  const { includeCatalog = false, cwd } = options;
  const spec = routeFor(service, route, readOnly, ctx, parent, cwd);
  await validatePreset(ctx, spec.agentPreset);
  const instance =
    route.backend === externalBridge
      ? { ...route, backend: route.baseBackend ?? route.provider, provider: undefined }
      : { ...route, ...(!route.product && spec.agentOptions) };
  let modelCheck;
  try {
    modelCheck = await inspectModel(ctx, instance, includeCatalog, parent);
  } catch (error) {
    if (error instanceof InvalidModelRoute) throw error;
    modelCheck = { state: 'unconfirmed', detail: '模型目录暂时无法核对：' + error.message };
  }
  return { spec, modelCheck };
}
