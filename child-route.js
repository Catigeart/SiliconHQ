function ownedChild(header, childId, parentId) {
  return (
    !!parentId &&
    header?.id === childId &&
    header.origin === 'subagent' &&
    header.parentSession === parentId
  );
}

function modelRoute(value) {
  const route = {};
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    if (typeof value?.[key] === 'string' && value[key]) route[key] = value[key];
  }
  return Object.keys(route).length ? route : undefined;
}

// A local handle can disappear as soon as its result settles. Capture the
// host's resolved child options while it is resident, including inherited ones.
export function liveChildRoute(ctx, childId, parentId, provider) {
  try {
    if (!ctx?.get('subagents')?.getProvider(provider)?.prepareContinuable) return;
    const agent = ctx.get('agents')?.get(childId);
    if (ownedChild(agent?.session?.header, childId, parentId)) return modelRoute(agent.options);
  } catch {
    // An observation must never interrupt a submitted activation.
  }
}

export async function readChildRouteEvidence(ctx, childId, parentId, provider) {
  const query = ctx.get('sessionQuery');
  if (!query?.observeSession) return;
  let lease;
  try {
    lease = await query.observeSession(childId, { signal: AbortSignal.timeout(3000) });
    if (!ownedChild(lease.header, childId, parentId)) return;
    const offset = lease.inheritedEventCount;
    if (!Number.isSafeInteger(offset) || offset < 0) return;
    // The first child-owned v3 descriptor establishes identity. A fork can
    // include an ancestor's descriptor and request headers in the inherited prefix.
    const events = lease.events;
    const index = events.findIndex((e, i) => i >= offset && e.type === 'subagent/descriptor');
    const descriptor = events[index]?.data;
    if (
      descriptor?.version !== 3 ||
      descriptor.mode !== 'continuable' ||
      descriptor.provider !== provider
    )
      return;
    // A later continuation can select another model. Inspect only the first
    // request of the original delegation, up to the end of that turn.
    for (let i = index + 1; i < events.length; i++) {
      const event = events[i];
      if (event.type === 'turn/end') break;
      if (event.type === 'request/header') {
        const route = modelRoute(event.data?.header?.config);
        if (route) return { route, fromRequest: true };
        break;
      }
    }
    const route = modelRoute({
      provider: descriptor.agentProvider,
      model: descriptor.agentModel,
      reasoningEffort: descriptor.agentReasoningEffort,
    });
    if (route) return { route, fromRequest: false };
  } catch {
    // External, expired and unsupported historical sessions have no readable route.
  } finally {
    try {
      lease?.[Symbol.dispose]?.();
    } catch {
      // A closing host must not hide the workflow's independently saved report.
    }
  }
}
