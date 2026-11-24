import assert from 'node:assert/strict';

// Delay only the downstream response. The request still reaches the real, authenticated DSH endpoint.
export async function verifyProgressAbort(page, detail, button) {
  const pattern = '**/api/sihqCatalog/runProgress';
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  let timer, pending;
  const intercept = (route) => {
    pending = (async () => {
      try {
        const upstream = await route.fetch({ timeout: 15000 });
        arrived.resolve(upstream.status());
        await release.promise;
        await route.fulfill({ response: upstream });
      } catch (error) {
        // After the upstream 200 the browser may already have cancelled the held request.
        arrived.reject(error);
      }
    })();
    return pending;
  };
  await page.route(pattern, intercept, { times: 1 });
  try {
    const aborted = page.waitForEvent('requestfailed', {
      predicate: (req) =>
        new URL(req.url()).pathname.endsWith('/sihqCatalog/runProgress') &&
        /ABORT/i.test(req.failure()?.errorText ?? ''),
    });
    // If another operation fails first, the waiting event must not become an unhandled rejection.
    aborted.catch(() => {});
    await button('刷新详情', detail).click();
    const status = await Promise.race([
      arrived.promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('DSH progress request did not reach the host')),
          15000,
        );
      }),
    ]);
    assert.equal(status, 200);
    await button('返回运行记录', detail).click();
    release.resolve();
    await aborted;
  } finally {
    clearTimeout(timer);
    release.resolve();
    await page.unroute(pattern, intercept);
    await pending;
  }
}
