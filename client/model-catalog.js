/** Native catalogs expose provider and model choices. Product CLIs own their
 * own catalogs, and RC5 resolves reasoning efforts through the LLM service. */
export function createModelChoices(ctx, call) {
  const listeners = new Set();
  const pending = new Map();
  let catalog;
  function invalidate() {
    catalog = undefined;
    pending.clear();
    for (const listener of listeners) listener();
  }
  for (const event of ['llm/adapters-updated', 'settings/document-updated']) {
    if (ctx.remote?.$on) ctx.effect(() => ctx.remote.$on(event, invalidate));
  }
  ctx.effect(() => ctx.on('connection/reset', invalidate));
  async function choices(payload) {
    const { backend, provider, model } = payload;
    if (
      payload.productCatalog ||
      !['spawn', 'fork'].includes(backend) ||
      model ||
      !ctx.remote?.session?.modelCatalog
    )
      return call('modelChoices', payload);
    // Share the host's provider enumeration between fields and mounted editors.
    if (!catalog) {
      const request = Promise.resolve()
        .then(() => ctx.remote.session.modelCatalog())
        .then((response) => {
          if (!response.ok) throw new Error(response.error.message);
          return response.value;
        });
      catalog = request;
      request.catch(() => {
        if (catalog === request) catalog = undefined;
      });
    }
    const { groups, failures } = await catalog;
    const partial = !!failures?.length;
    const options = (rows) => rows.map(({ id, name }) => ({ id, name: name ?? id }));
    if (!provider) return { providers: options(groups), partial };
    return {
      models: options(groups.find((group) => group.id === provider)?.models ?? []),
      partial,
    };
  }
  function load(payload) {
    const key = JSON.stringify(payload);
    if (!pending.has(key)) {
      const request = choices(payload).finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      });
      pending.set(key, request);
    }
    return pending.get(key);
  }
  load.subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return load;
}
