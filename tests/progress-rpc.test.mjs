import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../plugin.js';

test('the RC5 progress endpoint rejects an invalid or cancelled query before opening a session', async () => {
  let progressRoute;
  let sessionRequests = 0;
  apply({
    commands: { register() {} },
    inject(services, mount) {
      if (!services.includes('connection')) return;
      mount({
        connection: {
          fetch: {
            register(route) {
              if (route.path === '/api/sihqCatalog/runProgress') progressRoute = route;
            },
          },
        },
      });
    },
    get(name) {
      assert.equal(name, 'agents');
      sessionRequests++;
      return { get: () => undefined };
    },
  });
  async function invoke(payload, signal) {
    const response = await progressRoute.fetch(
      new Request('http://localhost' + progressRoute.path, {
        method: 'POST',
        body: JSON.stringify({ rpcId: 'probe', payload }),
        signal,
      }),
    );
    const body = await response.json();
    assert.equal(body.rpcId, 'probe');
    return body.result;
  }
  const original = { sessionId: 's', id: 'flow' };
  for (const query of [null, { ...original, round: 0 }, { ...original, revision: {} }]) {
    assert.match((await invoke(query)).error.message, /查询参数/);
  }
  assert.match(
    (await invoke(original, AbortSignal.abort(new Error('closed before lookup')))).error.message,
    /closed before lookup/,
  );
  assert.equal(sessionRequests, 0);
  assert.match((await invoke(original)).error.message, /DSH 会话/);
  assert.equal(sessionRequests, 1);
});
