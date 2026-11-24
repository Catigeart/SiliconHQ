import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockFile } from '../dist/storage/lock.js';
import { canonicalProjectDirectory, sameProjectDirectory } from '../dist/storage/project-path.js';
import { lockWorkspace } from '../dist/storage/workspace-lock.js';

function isolatedHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'sihq-project-lock-'));
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const original = process.env[homeKey];
  process.env[homeKey] = root;
  t.after(() => {
    if (original === undefined) delete process.env[homeKey];
    else process.env[homeKey] = original;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('aliases share one project identity and lock', (t) => {
  const root = isolatedHome(t),
    project = join(root, 'CaseProject'),
    alias = join(root, 'link');
  mkdirSync(project);
  symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const unlock = lockWorkspace(project);
  try {
    assert.equal(canonicalProjectDirectory(alias), canonicalProjectDirectory(project));
    assert.throws(() => lockWorkspace(alias), /正在运行/);
    if (process.platform === 'win32') {
      assert.ok(sameProjectDirectory(project, join(root, 'CASEPROJECT')));
      assert.throws(() => lockWorkspace(join(root, 'CASEPROJECT')), /正在运行/);
    }
  } finally {
    unlock();
  }
});

test('Git subdirectories share their checkout lock and linked worktrees have independent locks', (t) => {
  const root = isolatedHome(t),
    project = join(root, 'repo'),
    other = join(root, 'linked');
  mkdirSync(project);
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        cwd: project,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: join(root, 'no-user-config'),
        },
      },
    );
  git('init', '-q');
  git('commit', '--allow-empty', '-qm', 'fixture');
  git('worktree', 'add', '--detach', other);
  const child = join(project, 'module');
  mkdirSync(child);
  const unlock = lockWorkspace(child);
  try {
    assert.throws(() => lockWorkspace(project), /正在运行/);
    lockWorkspace(other)();
    assert.ok(!sameProjectDirectory(child, project));
  } finally {
    unlock();
  }
  lockWorkspace(project)();
});

test('a live legacy subdirectory lock blocks migration until its original owner releases it', (t) => {
  const root = isolatedHome(t),
    project = join(root, 'repo'),
    child = join(project, 'module');
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(child);
  const oldKey = createHash('sha256').update(realpathSync(child)).digest('hex').slice(0, 36);
  const directory = join(root, '.llm-coder', 'workspace-locks', oldKey);
  mkdirSync(directory, { recursive: true });
  const releaseLegacy = lockFile(join(directory, 'lock'));
  try {
    assert.throws(() => lockWorkspace(project), /旧版任务正在运行/);
  } finally {
    releaseLegacy();
  }
  lockWorkspace(project)();
});
