import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { sameProjectDirectory } from './dist/storage/project-path.js';

export const externalBridge = 'sihq-product-instance';

const products = new Map([
  ['@deepseek-ai/dsh-subagent-codex', 'codex'],
  ['@deepseek-ai/dsh-subagent-claude-code', 'claude-code'],
]);

// RC5 has no provider configuration introspection API. Keep its loader-specific
// entry shape here; unrelated and uninspectable entries must not break the menu.
export function productEntries(ctx) {
  const entries = new Map();
  for (const entry of ctx.get('loader')?.entries?.() ?? []) {
    const product = products.get(entry?.options?.name);
    const fiber = entry?.fiber;
    if (!product || fiber?.state !== 2 || typeof fiber.resolveConfig !== 'function') continue;
    let config;
    try {
      config = fiber.resolveConfig(entry.options.config ?? {});
    } catch {
      // A record being reloaded is not a usable source of frozen overrides.
      continue;
    }
    if (typeof config?.providerName === 'string' && config.providerName) {
      entries.set(config.providerName, { product, config, apply: entry.moduleNamespace?.apply });
    }
  }
  return entries;
}

// Product Subagents 0.4.1 starts its product in the original session directory.
// Resolve from the active loader entry, including profiles with custom provider names.
export function checkProductWorkspace(ctx, provider, parent, cwd) {
  if (!parent || !cwd || sameProjectDirectory(parent.session?.header?.cwd || process.cwd(), cwd))
    return;
  if (!provider?.prepareContinuable || productEntries(ctx).has(provider.name)) return;
  const pkg = 'dsh-plugin-product-subagents';
  for (const entry of ctx.get('loader')?.entries?.() ?? []) {
    if (entry.options?.name !== pkg || entry.fiber?.state !== 2) continue;
    const cfg = entry.fiber.resolveConfig(entry.options.config ?? {});
    const ns = cfg?.providerNamespace ?? 'product-subagents';
    const keys = ['codex', 'claude-code', 'acp', ...Object.keys(cfg?.providers ?? {})];
    if (!keys.some((key) => provider.name === (ns ? ns + ':' + key : key))) continue;
    let version;
    try {
      const resolve = createRequire(entry.parent.tree.context.baseUrl).resolve;
      version = JSON.parse(readFileSync(resolve(pkg + '/package.json'), 'utf8')).version;
    } catch {
      /* A custom loader can omit the package location. */
    }
    if (version && version !== '0.4.1') continue;
    throw new Error(
      provider.name +
        ' 无法确认会在切换后的工作目录执行。请在目标目录新建聊天，或改用支持切换目录的 DSH 后端。',
    );
  }
}

export function developmentRestriction(entry) {
  if (entry?.product === 'claude-code' && entry.config.permissionMode === 'plan')
    return '此 Claude Code 后端的 permissionMode 为 plan，仅生成计划，不能用于开发步骤。';
}

function baseEntry(ctx, name, expectedProduct) {
  const service = ctx.get('subagents') ?? ctx.subagents;
  if (!service?.getProvider(name)) throw new Error('原 DSH 产品后端已停用：' + name);
  const entry = productEntries(ctx).get(name);
  if (!entry || (expectedProduct && entry.product !== expectedProduct))
    throw new Error('无法确认 DSH 产品后端的当前配置或产品类型：' + name);
  return entry;
}

// Resolve against current registration at dispatch, including on resume. A run
// with a frozen explicit model keeps it if the base profile is edited meanwhile.
export function selectProductSpec(ctx, route, spec) {
  if (route.backend !== externalBridge) return spec;
  const base = route.baseBackend ?? route.provider;
  const entry = baseEntry(ctx, base, route.product);
  const modelMatches = !route.model || route.model === entry.config.model;
  const effortMatches =
    !route.reasoningEffort ||
    (entry.product === 'claude-code' &&
      route.reasoningEffort === entry.config.env?.CLAUDE_CODE_EFFORT_LEVEL);
  if (modelMatches && effortMatches) {
    const { agentOptions, ...rest } = spec;
    return { ...rest, provider: base };
  }
  if (typeof entry.apply !== 'function')
    throw new Error(base + ' 的宿主接口不支持动态覆盖，请选用配置好模型的 DSH 后端实例。');
  return spec;
}

// The product providers in RC5 accept model/effort at profile level only. Use
// the official provider implementation with an isolated configuration for this
// activation; credentials, permission mode and lifecycle stay provider-owned.
export function productStart(entry, request, ctx) {
  const { agentOptions = {}, ...baseRequest } = request;
  const { model, reasoningEffort: effort } = agentOptions;
  if (effort && !/^[a-z][a-z0-9_-]{0,31}$/i.test(effort)) throw new Error('无效的思考强度 ID');
  if (typeof entry.apply !== 'function') throw new Error('宿主产品接口不支持动态模型覆盖');
  const config = { ...entry.config, ...(model && { model }) };
  if (effort && entry.product === 'claude-code')
    config.env = { ...config.env, CLAUDE_CODE_EFFORT_LEVEL: effort };
  let subprocess = ctx.subprocess;
  if (effort && entry.product === 'codex') {
    subprocess = {
      spawn(spec) {
        if (!Array.isArray(spec.argv) || !spec.argv.includes('app-server'))
          throw new Error('当前 Codex provider 的启动接口已改变');
        return ctx.subprocess.spawn({
          ...spec,
          argv: [...spec.argv, '-c', 'model_reasoning_effort=' + JSON.stringify(effort)],
        });
      },
    };
  }
  let provider;
  entry.apply(
    {
      logger: ctx.logger,
      subprocess,
      subagents: {
        registerProvider(value) {
          provider = value;
        },
      },
    },
    config,
  );
  if (typeof provider?.start !== 'function') throw new Error('宿主产品 provider 未注册 start 接口');
  return provider.start(baseRequest);
}

export function registerProductBridge(ctx) {
  ctx.subagents.registerProvider({
    name: externalBridge,
    inheritsParentContext: false,
    capabilities: {
      agentOptions: true,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    },
    start(request) {
      const entry = baseEntry(
        ctx,
        request.agentOptions?.provider,
        request.agentOptions?.expectedProduct,
      );
      const restriction = developmentRestriction(entry);
      if (restriction) throw new Error(restriction);
      return productStart(entry, request, ctx);
    },
  });
}
