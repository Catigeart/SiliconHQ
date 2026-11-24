import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ownerAlive, processIdentity } from '../dist/runtime/identity.js';
import { hasLiveLock, lockFile } from '../dist/storage/lock.js';

test(
  'Windows locks distinguish PID generations and preserve owners that cannot be inspected',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sihq-win-identity-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, 'lock');
    const unlock = lockFile(file);
    try {
      const owner = JSON.parse(readFileSync(file, 'utf8'));
      assert.match(owner.start, /^\d+$/);
      assert.equal(owner.start, processIdentity().start);
      assert.equal(hasLiveLock(file), true);
    } finally {
      unlock();
    }

    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const exited = once(child, 'exit');
    try {
      const owner = processIdentity(child.pid);
      assert.match(owner.start, /^\d+$/);
      assert.equal(ownerAlive(owner), true);
      // Recreate the record left by a process whose PID was reused by this child.
      writeFileSync(
        file,
        JSON.stringify({ ...owner, start: (BigInt(owner.start) - 1n).toString() }),
      );
      assert.equal(hasLiveLock(file), false);
      lockFile(file)();

      writeFileSync(file, JSON.stringify({ pid: child.pid }));
      assert.equal(hasLiveLock(file), true);
      writeFileSync(file, JSON.stringify(owner));
      const systemRoot = process.env.SystemRoot;
      process.env.SystemRoot = root;
      try {
        assert.equal(processIdentity(child.pid).start, undefined);
        assert.equal(hasLiveLock(file), true);
        assert.throws(() => lockFile(file), /正在运行/);
      } finally {
        if (systemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = systemRoot;
      }
    } finally {
      child.stdin.end();
      await exited;
    }
    assert.equal(hasLiveLock(file), false);
  },
);
