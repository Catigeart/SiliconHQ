import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { describeRun } from '../run-results.js';

// Two pages show the first failure. Only the page that acted refreshes automatically.
export async function checkRecoveryPages(start) {
  const actions = fc.array(
    fc.constantFrom(
      'refreshLeft',
      'refreshRight',
      'retryLeft',
      'retryRight',
      'resumeStaleLeft',
      'resumeStaleRight',
    ),
    { minLength: 2, maxLength: 7 },
  );
  await fc.assert(
    fc.asyncProperty(actions, async (operations) => {
      const app = await start();
      let generation = 0;
      const page = () => ({ generation, token: describeRun(app.read()).recovery?.token });
      const pages = [page(), page()];
      for (const op of operations) {
        const tab = op.endsWith('Left') ? 0 : 1;
        const stale = pages[tab].generation !== generation;
        if (
          (op.startsWith('retry') || (op.startsWith('resumeStale') && stale)) &&
          pages[tab].generation < 2
        ) {
          const before = app.callCount();
          if (stale) {
            await assert.rejects(
              async () =>
                app.recover(op.startsWith('resumeStale') ? 'resume' : 'retry', pages[tab].token),
              /已变更|已更新/,
            );
            assert.equal(app.callCount(), before);
          } else {
            await app.recover('retry', pages[tab].token);
            assert.ok(app.callCount() > before);
            generation++;
            assert.equal(app.read().status === 'failed', generation === 1);
          }
        }
        pages[tab] = page();
      }
    }),
    {
      numRuns: 8,
      examples: [
        [['retryLeft', 'retryRight']],
        [['retryLeft', 'resumeStaleRight']],
        [['refreshLeft', 'retryRight', 'refreshLeft', 'retryLeft']],
      ],
    },
  );
}
