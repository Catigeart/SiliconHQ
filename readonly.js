// In rc.5 an Agent inherits its preset tools. Restrict the finished Agent
// scope so the readers stay visible alongside its scoped structured-result tool.
export function installReadonlyGuard(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    if (ctx.agentPresets.composedPreset(agent.ctx) !== 'sihq-readonly') return;
    agent.ctx.get('tools').restrict({ allow: ['read', 'glob', 'grep'] });
  });
}
