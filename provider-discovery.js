import { developmentRestriction } from './product-adapter.js';
import { externalBridge, instancePrefix } from './agent-instances.js';

// RC5 exposes getProvider and lifecycle events but has no public enumeration
// method. Use the registry only to bootstrap already-mounted custom backends.
function initialNames(service) {
  return typeof service?.providers?.keys === 'function' ? service.providers.keys() : [];
}

export function observeProviderNames(ctx) {
  const names = new Set();
  let current;
  ctx.on?.('subagent/provider-added', (provider) => names.add(provider.name));
  ctx.on?.('subagent/provider-removed', (name) => names.delete(name));
  return (service) => {
    if (service !== current) {
      current = service;
      // Preserve lifecycle facts received before the first catalog request.
      for (const name of initialNames(service)) names.add(name);
    }
    return names;
  };
}

export function providerCapabilities(
  service,
  configuredNames,
  knownNames = initialNames(service),
  products = new Map(),
) {
  const configured = new Set(
    configuredNames.filter(
      (name) =>
        typeof name === 'string' &&
        name &&
        name !== externalBridge &&
        !name.startsWith(instancePrefix),
    ),
  );
  const names = new Set([
    'spawn',
    'fork',
    'codex',
    'claude-code',
    'sihq-codex-readonly',
    ...configured,
    ...knownNames,
  ]);
  return [...names].sort().flatMap((name) => {
    if (name === externalBridge) return [];
    const provider = service?.getProvider(name);
    if (!provider && !configured.has(name)) return [];
    const agentPreset = !!provider?.capabilities.agentPreset && !provider.inheritsParentContext;
    const restriction = developmentRestriction(products.get(name));
    return [
      {
        name,
        registered: !!provider,
        agentPreset,
        read: !!provider && (name === 'sihq-codex-readonly' || agentPreset),
        develop: !!provider && name !== 'sihq-codex-readonly' && !restriction,
        ...(restriction && { restriction }),
        modelOverride: !!provider?.capabilities.agentOptions,
        ...(provider?.agentRouteDefaults && { routeDefaults: provider.agentRouteDefaults }),
      },
    ];
  });
}
