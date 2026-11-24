// RC5 delegates depth to external providers and supplies a numeric cap to
// capable providers. Read it for each attempt so profile edits take effect.
/**
 * @param {{resolveMaxDepth?: () => number | undefined}} service
 * @param {{capabilities: {depthLimit?: boolean}}} provider
 * @param {{options?: {subagentDepth?: number}, session?: {header?: {delegationDepth?: number}}}} [parent]
 */
export function delegationDepthOptions(service, provider, parent = undefined) {
  if (!provider.capabilities.depthLimit || typeof service.resolveMaxDepth !== 'function') return {};
  const maxDepth = service.resolveMaxDepth();
  if (maxDepth === undefined) return {};
  // A resumed session can carry its delegation depth in the persisted header
  // even when the running Agent no longer has an explicit subagentDepth.
  const depth = Math.max(
    parent?.options?.subagentDepth ?? 0,
    parent?.session?.header?.delegationDepth ?? 0,
  );
  if (depth >= maxDepth)
    throw new Error(`DSH 子 Agent 委派深度将达到 ${depth + 1}，超过当前设置的上限 ${maxDepth}。`);
  return { maxDepth };
}
