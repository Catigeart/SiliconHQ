// Catalog decisions use DSH's advertised capabilities. Dispatch resolves the live provider again.
export const readonlyPreset = 'sihq-readonly';
/** @param {any} base @param {any} route @param {boolean|undefined} read @param {boolean} [named] */
export function supportsRoute(base, route, read, named = true) {
  if (
    !base ||
    base.registered === false ||
    (read !== undefined && !(read ? base.read : base.develop))
  )
    return false;
  if (route.product && route.product !== base.product) return false;
  const preset = route.agentPreset;
  if (
    preset &&
    (!base.agentPreset ||
      !base.presets?.some((p) => p.id === preset && !p.broken) ||
      (read !== undefined && read !== (preset === readonlyPreset)))
  )
    return false;
  if (route.provider && (base.product || base.name === 'sihq-codex-readonly')) return false;
  return (
    !(route.provider || route.model || route.reasoningEffort) ||
    !!base.modelOverride ||
    (named && !!base.product)
  );
}
