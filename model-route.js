import { productEntries } from './product-adapter.js';
import { codexModelCatalog, readonlyCodex } from './codex-backend.js';

// Used by both the settings selectors and the explicit instance health check.
/** @param {any} ctx @param {{backend: string, provider?: string, model?: string}} selection */
export async function modelChoices(ctx, { backend, provider, model }) {
  const product = productEntries(ctx).get(backend)?.product;
  if (!product && !ctx.get('subagents')?.getProvider(backend)?.capabilities.agentOptions)
    throw new Error('该执行者使用 provider 实例配置');
  if (product === 'codex' || backend === readonlyCodex) {
    const profile = product === 'codex' ? ctx.get('profileContext').dir : undefined;
    return {
      models: await codexModelCatalog({ subprocess: ctx.get('subprocess') }, profile),
    };
  }
  if (product === 'claude-code') {
    return {
      models: ['sonnet', 'opus', 'haiku'].map((id) => ({ id, name: id })),
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({
        id,
        name: id,
      })),
    };
  }
  if (!usesHostModels(backend, ctx.get('subagents')?.getProvider(backend))) return { manual: true };
  const llm = ctx.get('llm');
  if (!llm) throw new Error('当前 profile 未启用 DSH 模型服务');
  const options = (values) => values.map(({ id, name }) => ({ id, name }));
  if (!provider) return { providers: options(llm.listProviders()) };
  if (!model) return { models: options(await llm.listModels(provider)) };
  const info = await llm.resolveModelInfo(provider, model);
  return { efforts: options(info.reasoning?.efforts ?? []) };
}

// A third-party one-shot backend can own its own model provider namespace.
export function usesHostModels(name, backend) {
  return (
    !!backend?.agentRouteDefaults ||
    ['spawn', 'fork'].includes(name) ||
    typeof backend?.prepareContinuable === 'function'
  );
}

export function effectiveAgentRoute(route, backend) {
  const defaults = backend?.agentRouteDefaults;
  return defaults
    ? {
        ...route,
        provider: route.provider || defaults.provider,
        model: route.model || defaults.model,
      }
    : route;
}

function matches(choices, value) {
  return choices.some((option) => option.id === value);
}

export class InvalidModelRoute extends Error {}

/** @param {any} ctx @param {any} instance @param {boolean} [includeCatalog] @param {any} [parent] */
export async function inspectModel(ctx, instance, includeCatalog = false, parent = undefined) {
  const { backend, product, reasoningEffort } = instance;
  const registered = ctx.get('subagents')?.getProvider(backend);
  let { provider, model } =
    product || backend === readonlyCodex ? instance : effectiveAgentRoute(instance, registered);
  if (
    !product &&
    backend !== readonlyCodex &&
    (provider || model || reasoningEffort) &&
    !usesHostModels(backend, registered)
  )
    return { state: 'unconfirmed', detail: '此后端管理自己的模型路由，可用性由实际委派确认。' };
  // Existing templates may override only effort. RC5 merges local options over
  // the latest parent request. Never apply that inheritance to a product CLI.
  if ((!provider || !model) && !product && backend !== readonlyCodex) {
    const defaults =
      provider || model || reasoningEffort
        ? (parent?.session?.requestHeader?.()?.config ?? parent?.options)
        : undefined;
    provider ||= defaults?.provider;
    model ||= defaults?.model;
  }
  if (reasoningEffort && !model)
    return {
      state: 'inherited',
      detail: '模型由会话或后端决定，使用指定思考强度 ' + reasoningEffort + '。',
    };
  if (!provider && !model)
    return {
      state: 'inherited',
      detail: '路由已解析，模型及思考强度由会话或后端决定。',
    };
  let efforts;
  if (product || backend === readonlyCodex) {
    if (provider) throw new InvalidModelRoute('产品后端使用自己的模型供应商');
    if (!includeCatalog && !reasoningEffort)
      return { state: 'unconfirmed', detail: '模型可用性由产品后端确定。' };
    const catalog = await modelChoices(ctx, { backend });
    const entry = catalog.models.find((option) => option.id === model);
    efforts = entry?.efforts ?? catalog.efforts;
    if (reasoningEffort && efforts && !matches(efforts, reasoningEffort))
      throw new InvalidModelRoute('可选强度中没有 ' + reasoningEffort);
    if (product === 'claude-code' || !entry)
      return {
        state: 'unconfirmed',
        detail: '启动配置已解析。该模型在当前账户上的可用性需要实际委派确认。',
      };
  } else {
    if (!provider)
      return {
        state: 'inherited',
        detail: '模型供应商随父会话选择，实际委派将使用测试会话。',
      };
    if (!model) return { state: 'inherited', detail: '供应商已注册，模型由会话决定。' };
    const llm = ctx.get('llm');
    if (llm?.resolveCallConfig) {
      const parentRoute = parent?.session?.requestHeader?.()?.config ?? parent?.options;
      const effort =
        reasoningEffort ??
        (provider === parentRoute?.provider && model === parentRoute?.model
          ? parentRoute.reasoningEffort
          : undefined);
      try {
        await llm.resolveCallConfig({
          provider,
          model,
          ...(effort && { reasoningEffort: effort }),
        });
      } catch (error) {
        throw new InvalidModelRoute(
          'DSH 无法解析模型路由 ' + provider + '/' + model + '：' + error.message,
        );
      }
      return { state: 'pass', detail: [provider, model, effort].filter(Boolean).join(' · ') };
    }
    if (reasoningEffort) {
      const info = await modelChoices(ctx, { backend, provider, model });
      if (!matches(info.efforts, reasoningEffort))
        throw new InvalidModelRoute('模型 ' + model + ' 未声明思考强度 ' + reasoningEffort);
    }
    // A missing catalog entry can still be a valid custom model. Its lookup
    // provides a diagnostic in settings, and is unnecessary on every dispatch.
    if (includeCatalog) {
      const catalog = await modelChoices(ctx, { backend, provider });
      if (!matches(catalog.models, model))
        return {
          state: 'unconfirmed',
          detail: '路由可解析。供应商目录未列出该模型，请用实际委派验证。',
        };
    }
  }
  return {
    state: 'pass',
    detail: [provider, model, reasoningEffort].filter(Boolean).join(' · '),
  };
}
