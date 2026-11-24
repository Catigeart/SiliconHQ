import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as fc from 'fast-check';
import { stopVerificationJob } from '../verification-command.js';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { lockFile } from '../dist/storage/lock.js';
import { WorkflowStore } from '../dist/storage/workflows.js';
import {
  lockWorkspace,
  lockTemplateWorkspace,
  workspaceVerificationStops,
} from '../dist/storage/workspace-lock.js';

const lockModule = new URL('../dist/storage/workspace-lock.js', import.meta.url).href;

test('restored stops survive missing exports and forced settlement across writer admissions', async (t) => {
  const { parent, home } = fixture(t);
  const other = join(home, 'independent');
  mkdirSync(other);
  lockWorkspace(parent)();
  const future = new WorkflowStore().directory(randomUUID());
  mkdirSync(future, { recursive: true });
  const futureDb = new DatabaseSync(join(future, 'runtime.sqlite'));
  futureDb.exec('PRAGMA user_version=99');
  futureDb.close();
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('restore', 'remove-export', 'force-settle', 'retry'), {
        maxLength: 8,
      }),
      async (actions) => {
        const id = randomUUID(),
          dir = new WorkflowStore().directory(id),
          jobId = 'old-' + id;
        mkdirSync(dir, { recursive: true });
        const file = join(dir, 'workflow.json');
        const row = { id, cwd: parent, steps: [{ runId: 'r', stoppingJobId: jobId }] };
        const owner = { id: 's', session: { events: [] } };
        for (const action of ['restore', ...actions, 'retry']) {
          if (action === 'restore') writeFileSync(file, JSON.stringify(row));
          if (action === 'remove-export') rmSync(file, { force: true });
          if (action === 'force-settle') {
            owner.session.events = [
              {
                type: 'job/settled',
                data: {
                  owner: 's',
                  jobId,
                  kind: process.platform === 'win32' ? 'pwsh' : 'bash',
                  status: 'failed',
                  cause: 'teardown',
                  producerReported: false,
                },
              },
            ];
            const jobs = { kill: () => 'already-finished', wait() {} };
            await assert.rejects(
              stopVerificationJob({ get: () => jobs }, owner, jobId),
              /等待确认/,
            );
          }
          assert.throws(() => lockWorkspace(parent), new RegExp(jobId));
          lockWorkspace(other)();
        }
        rmSync(file, { force: true });
        workspaceVerificationStops(parent, id).confirmed(jobId);
        lockWorkspace(parent)();
      },
    ),
    { numRuns: 5, examples: [[['force-settle', 'remove-export', 'retry', 'restore']]] },
  );
});

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'sihq-workspace-overlap-'));
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previous = process.env[homeKey];
  process.env[homeKey] = home;
  t.after(() => {
    if (previous === undefined) delete process.env[homeKey];
    else process.env[homeKey] = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const parent = join(home, 'plain');
  const child = join(parent, 'lib');
  const sibling = join(parent, 'lib-extra');
  mkdirSync(child, { recursive: true });
  mkdirSync(sibling);
  return { home, parent, child, sibling };
}

test('an active 0.8 empty marker is treated as an unknown workspace until release', (t) => {
  const { home, parent, child } = fixture(t);
  lockWorkspace(child)();
  const root = join(home, '.llm-coder', 'workspace-locks');
  const oldDirectory = readdirSync(root, { withFileTypes: true }).find((entry) =>
    entry.isDirectory(),
  );
  const keyDirectory = join(root, oldDirectory.name);
  writeFileSync(join(keyDirectory, 'worktree-key'), '');
  const release = lockFile(join(keyDirectory, 'lock'));
  try {
    assert.throws(() => lockWorkspace(parent), /旧版任务正在运行/);
  } finally {
    release();
  }
  lockWorkspace(parent)();
});

test('valid unrelated markers exclude their owners; unknown markers check liveness', (t) => {
  const { home, child, sibling } = fixture(t);
  lockWorkspace(child)();
  const root = join(home, '.llm-coder', 'workspace-locks');
  const key = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory()).name;
  const dir = join(root, key);
  const lock = join(dir, 'lock');
  // A probe would throw if the unrelated owner were queried.
  writeFileSync(lock, 'unreadable owner');
  lockWorkspace(sibling)();
  writeFileSync(join(dir, 'worktree-key'), '{broken');
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  assert.throws(
    () => lockWorkspace(sibling),
    (error) => error.failure?.code === 'LOCKED',
  );
  // The kernel cannot allocate this PID on our Windows or Linux hosts.
  writeFileSync(lock, JSON.stringify({ pid: 0x7fffffff }));
  lockWorkspace(sibling)();
});

test('overlapping plain directories exclude each other in either order while siblings can write', (t) => {
  const { parent, child, sibling } = fixture(t);
  const first = lockWorkspace(parent);
  try {
    assert.throws(
      () => lockWorkspace(child),
      (error) => error.failure?.code === 'LOCKED',
    );
  } finally {
    first();
  }
  const nested = lockWorkspace(child);
  try {
    assert.throws(
      () => lockWorkspace(parent),
      (error) => error.failure?.code === 'LOCKED',
    );
    lockWorkspace(sibling)();
  } finally {
    nested();
  }
  lockWorkspace(parent)();
});

test('a plain parent covers a nested checkout, separate nested Git roots remain independent', (t) => {
  const { parent, child } = fixture(t);
  mkdirSync(join(child, '.git'));
  const plain = lockWorkspace(parent);
  try {
    assert.throws(
      () => lockWorkspace(child),
      (error) => error.failure?.code === 'LOCKED',
    );
  } finally {
    plain();
  }
  mkdirSync(join(parent, '.git'));
  const checkout = lockWorkspace(parent);
  try {
    lockWorkspace(child)();
  } finally {
    checkout();
  }
});

async function acquireConcurrently(directories) {
  const script = `
    const { lockWorkspace } = await import(process.argv[1]);
    let release;
    console.log('ready');
    for await (const command of process.stdin) {
      try {
        release = lockWorkspace(process.argv[2]);
        console.log('acquired');
      } catch (error) { console.log(error.failure?.code ?? String(error)); }
    }
    release?.();
  `;
  const children = directories.map((directory) =>
    spawn(process.execPath, ['--input-type=module', '-e', script, lockModule, directory], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    }),
  );
  const closed = Promise.all(children.map((worker) => once(worker, 'close')));
  const output = children.map((worker) =>
    createInterface({ input: worker.stdout })[Symbol.asyncIterator](),
  );
  const readAll = () => Promise.all(output.map(async (lines) => (await lines.next()).value));
  try {
    assert.deepEqual(
      await readAll(),
      directories.map(() => 'ready'),
    );
    for (const worker of children) worker.stdin.write('acquire\n');
    return await readAll();
  } finally {
    for (const worker of children) worker.stdin.end();
    await closed;
  }
}

test(
  'simultaneous writers in separate processes admit exactly one overlapping directory',
  { timeout: 20000 },
  async (t) => {
    const { parent, child } = fixture(t);
    assert.deepEqual((await acquireConcurrently([parent, child])).sort(), ['LOCKED', 'acquired']);
    lockWorkspace(parent)();
  },
);

test(
  'independent checkout processes can all acquire while their peers keep their locks',
  { timeout: 30000 },
  async (t) => {
    const { home } = fixture(t);
    const projects = Array.from({ length: 6 }, (_, i) => join(home, 'checkout-' + i));
    for (const cwd of projects) mkdirSync(join(cwd, '.git'), { recursive: true });
    assert.deepEqual(
      await acquireConcurrently(projects),
      projects.map(() => 'acquired'),
    );
  },
);

test('read leases coexist and exclude overlapping writers until the last reader leaves', (t) => {
  const { child, parent, sibling } = fixture(t);
  const first = lockWorkspace(child, 'read'),
    second = lockWorkspace(child, 'read');
  try {
    assert.throws(
      () => lockWorkspace(parent),
      (e) => e.failure?.code === 'LOCKED',
    );
    lockWorkspace(sibling)();
  } finally {
    first();
  }
  try {
    assert.throws(
      () => lockWorkspace(child),
      (e) => e.failure?.code === 'LOCKED',
    );
  } finally {
    second();
  }
  const writer = lockWorkspace(parent);
  try {
    assert.throws(
      () => lockWorkspace(child, 'read'),
      (e) => e.failure?.code === 'LOCKED',
    );
  } finally {
    writer();
  }
});

test('first admission migrates unresolved v0.14.1 jobs and fences overlapping writers in a second process', (t) => {
  const { parent, child, sibling } = fixture(t);
  const flows = new WorkflowStore();
  const f = flows.create('legacy', parent, 0, {
    session: 'prior',
    template: { id: 'v', name: 'v', steps: [] },
  });
  Object.assign(f, {
    status: 'failed',
    steps: [
      {
        stage: 'verify',
        status: 'failed',
        startedAt: f.createdAt,
        runId: 'run',
        stoppingJobId: 'pending-shell',
      },
    ],
  });
  flows.save(f);
  lockWorkspace(sibling, 'read')();
  const elsewhere = join(parent, '..', 'unrelated');
  mkdirSync(elsewhere);
  lockWorkspace(elsewhere)();
  const attempted = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {lockWorkspace} from ${JSON.stringify(lockModule)};lockWorkspace(${JSON.stringify(child)})();`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(attempted.status, 1);
  assert.match(attempted.stderr, /pending-shell/);
  const lease = lockTemplateWorkspace(parent, 'write', f.id);
  try {
    const stops = workspaceVerificationStops(parent, f.id);
    assert.deepEqual(
      stops.pending().map((r) => r.jobId),
      ['pending-shell'],
    );
    stops.confirmed('pending-shell');
  } finally {
    lease.release();
  }
  lockWorkspace(child)();
});

test('two legacy owners can reconcile independently before new work is admitted', (t) => {
  const { parent } = fixture(t);
  const lease = lockWorkspace(parent);
  const a = workspaceVerificationStops(parent, 'flow-a'),
    b = workspaceVerificationStops(parent, 'flow-b');
  try {
    a.remember('a', 'first-job');
    b.remember('b', 'second-job');
  } finally {
    lease();
  }
  const first = lockTemplateWorkspace(parent, 'write', 'flow-a');
  try {
    a.confirmed('first-job');
    assert.throws(first.assertReady, /second-job/);
  } finally {
    first.release();
  }
  assert.throws(() => lockWorkspace(parent), /second-job/);
  const second = lockTemplateWorkspace(parent, 'write', 'flow-b');
  try {
    b.confirmed('second-job');
    second.assertReady();
  } finally {
    second.release();
  }
  lockWorkspace(parent)();
});

test('an exclusive workflow journal fences its own checkout without blocking another project', (t) => {
  const { parent, home, child } = fixture(t);
  const other = join(home, 'independent');
  mkdirSync(other);
  const store = new WorkflowStore();
  const flow = store.create('locked journal', parent, 0);
  const db = new DatabaseSync(join(store.directory(flow.id), 'runtime.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    lockWorkspace(other)();
    assert.throws(
      () => lockWorkspace(child),
      (e) => e.failure?.code === 'LOCKED',
    );
    db.exec('ROLLBACK');
    lockWorkspace(child)();
  } finally {
    db.close();
  }
});

test('a replacement journal cannot use the old export to bypass an unknown workspace fence', (t) => {
  const { parent, home } = fixture(t);
  const other = join(home, 'independent');
  mkdirSync(other);
  const store = new WorkflowStore();
  const flow = store.create('original', parent, 0);
  const file = join(store.directory(flow.id), 'runtime.sqlite');
  renameSync(file, file + '.original');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE checkpoints(name TEXT PRIMARY KEY,value TEXT); BEGIN EXCLUSIVE');
    assert.throws(
      () => lockWorkspace(other),
      (e) => e.failure?.code === 'LOCKED',
    );
  } finally {
    db.close();
  }
});
