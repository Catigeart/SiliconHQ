import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { runWorkflow } from '../dist/workflow/runner.js';
import { lockWorkspace } from '../dist/storage/workspace-lock.js';
test('cancelled workflow persists terminal status and releases workspace lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-cancel-'));
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previous = process.env[homeKey];
  try {
    process.env[homeKey] = root;
    assert.equal(homedir(), root);
    const controller = new AbortController();
    controller.abort();
    const flow = await runWorkflow('cancelled request', root, controller.signal);
    assert.equal(flow.status, 'cancelled');
    assert.equal(flow.steps.length, 0);
    assert.equal(flow.stopReason, 'cancelled');
    const release = lockWorkspace(root);
    release();
  } finally {
    if (previous === undefined) delete process.env[homeKey];
    else process.env[homeKey] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
