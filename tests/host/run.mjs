import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { overlay, profilePatch } from './profile.mjs';
import { verify } from './browser.mjs';

const opts = parseArgs({
  options: {
    package: { type: 'string' },
    out: { type: 'string' },
    browser: { type: 'string' },
    dsh: { type: 'string' },
    'llm-module': { type: 'string' },
    baseline: { type: 'boolean' },
    'permission-mode': { type: 'string' },
    'shell-probe': { type: 'boolean' },
    'expect-shell-error': { type: 'string' },
    source: { type: 'boolean' },
    'product-package': { type: 'string' },
  },
}).values;
if (opts['product-package'] && (opts.baseline || opts['shell-probe']))
  throw new Error('Run the product contract in its own profile');
if (opts.source && opts.package) throw new Error('Choose --source or --package');
if (opts['expect-shell-error'] && !opts['shell-probe'])
  throw new Error('--expect-shell-error requires --shell-probe');
const permissionMode = opts['permission-mode'] ?? 'workspace-write';
if (!['read-only', 'workspace-write', 'danger-full-access'].includes(permissionMode))
  throw new Error('Choose a DSH permission preset for the isolated test process.');
const here = dirname(fileURLToPath(import.meta.url));
const project = realpathSync(resolve(here, '../..'));
const parent = realpathSync(resolve(opts.out ?? dirname(project)));
const inside = relative(project, parent);
if (!inside || !(inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside))) {
  throw new Error('--out must be outside the plugin directory');
}
const run = mkdtempSync(join(parent, 'sihq-host-'));
console.log('Host test output: ' + run);
const home = join(run, 'home'),
  dshHome = join(run, 'dsh'),
  temp = join(run, 'temp');
for (const path of [home, temp, dshHome, join(run, 'project'), join(run, 'other')]) mkdirSync(path);

// Playwright allocates its temporary user-data directory in the launcher's own tmpdir.
Object.assign(process.env, { TEMP: temp, TMP: temp, TMPDIR: temp });
const desktop = join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness');
const modules = join(desktop, 'resources/app.asar/dsh/node_modules/@deepseek-ai');
const useDesktop = !opts.dsh && process.platform === 'win32';
const executable = useDesktop ? join(desktop, 'DeepSeek Harness.exe') : (opts.dsh ?? 'dsh');
const prefix = useDesktop
  ? ['--expose-internals', join(modules, 'dsh-desktop-host/lib/cli.js')]
  : [];
mkdirSync(join(run, 'project/checkout'));
const env = {};
// Start the host with a fresh credential store and only OS/process launch settings.
for (const key of [
  'PATH',
  'Path',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'LOCALAPPDATA',
  'APPDATA',
  'PNPM_HOME',
]) {
  if (process.env[key]) env[key] = process.env[key];
}
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
  DSH_HOME: dshHome,
  DSH_PERMISSION_MODE: permissionMode,
  SIHQ_TEST_DIR: run,
  SIHQ_TEST_LLM_MODULE: opts['llm-module']
    ? resolve(opts['llm-module'])
    : join(modules, 'dsh-llm/lib/index.js'),
  ...(useDesktop && { ELECTRON_RUN_AS_NODE: '1' }),
});

const profile = join(dshHome, 'profiles/test');
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, 'cordis.yml'), '[]\n');
writeFileSync(
  join(profile, 'package.json'),
  JSON.stringify({
    name: 'sihq-test-profile',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }),
);
function pack() {
  const npm =
    process.platform === 'win32'
      ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
      : undefined;
  const args = [
    'pack',
    '--silent',
    '--json',
    '--pack-destination',
    run,
    '--cache',
    join(run, 'npm-cache'),
  ];
  const output = execFileSync(npm ? process.execPath : 'npm', npm ? [npm, ...args] : args, {
    cwd: project,
    encoding: 'utf8',
  });
  return join(run, JSON.parse(output)[0].filename);
}
const source = realpathSync(resolve(opts.package ?? (opts.source ? project : pack()))).replaceAll(
  '\\',
  '/',
);
const hostVersion = execFileSync(executable, [...prefix, '--version'], {
  env,
  cwd: run,
  encoding: 'utf8',
  windowsHide: true,
}).trim();
const release = {
  hostVersion,
  permissionMode,
  source,
  ...(source.endsWith('.tgz') && {
    sha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
  }),
};
writeFileSync(join(run, 'release.json'), JSON.stringify(release, null, 2));
function start(args, name) {
  const child = spawn(executable, [...prefix, ...args], {
    env,
    cwd: run,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logPath = join(run, name + '.log');
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => appendFileSync(logPath, chunk));
  }
  return child;
}

const installer = start(['plugin', '--profile', 'test', 'add', 'file:' + source], 'install');
if ((await once(installer, 'close'))[0] !== 0)
  throw Error('DSH plugin installation failed; see install.log');
const patch = profilePatch(!opts.baseline);
if (opts['product-package']) {
  const archive = realpathSync(resolve(opts['product-package'])).replaceAll('\\', '/');
  const product = start(
    ['plugin', '--profile', 'test', 'add', 'file:' + archive],
    'product-install',
  );
  if ((await once(product, 'close'))[0] !== 0) throw Error('See product-install.log');
  const name = 'sihq-cwd-test';
  patch.push({
    id: 'product-subagents',
    config: {
      providerNamespace: 'checkout-test',
      providers: { [name]: { type: 'codex', command: process.execPath } },
    },
  });
  patch
    .find((entry) => entry.id === 'siliconhq-command')
    .config.templates.push({
      id: 'product-cwd',
      name: 'Smoke 社区后端目录',
      steps: [
        {
          id: 'write',
          name: '写入',
          kind: 'develop',
          backend: 'checkout-test:' + name,
          instructions: '检查目录',
          inputs: [],
        },
      ],
    });
  // node exec --json ... runs this entirely local Codex stand-in in the actual product cwd.
  for (const path of [run, join(run, 'project'), join(run, 'project/checkout')])
    writeFileSync(join(path, 'exec'), 'console.log(process.cwd());');
  env.SIHQ_TEST_PRODUCT = 'checkout-test:' + name;
}
writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify(patch));
const overlayPath = join(run, 'fixture.yml');
writeFileSync(
  overlayPath,
  JSON.stringify(overlay(join(here, 'fixture.mjs').replaceAll('\\', '/'))),
);
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const host = start(
  [
    '--profile',
    'test',
    '--patch',
    overlayPath,
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  'host',
);
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error('DSH did not print a local owner URL; see host.log')),
      60000,
    );
    let output = '';
    const cleanup = () => clearTimeout(timeout);
    for (const stream of [host.stdout, host.stderr])
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-3000);
        const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
        if (found) {
          cleanup();
          resolve(found[0]);
        }
      });
    host.once('error', (e) => {
      cleanup();
      reject(e);
    });
    host.once('close', (code) => {
      cleanup();
      reject(Error('DSH exited with ' + code + '; see host.log'));
    });
  });
  const executablePath =
    opts.browser ?? (process.platform === 'win32' ? undefined : chromium.executablePath());
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'msedge' }),
    env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await verify({
    context,
    url,
    run,
    baseline: !!opts.baseline,
    shellProbe: !!opts['shell-probe'],
    expectedShellError: opts['expect-shell-error'],
    productProbe: !!opts['product-package'],
  });
  console.log(
    opts['expect-shell-error']
      ? 'Expected host error reproduced.'
      : opts['product-package']
        ? 'Product checkout contract passed.'
        : opts['shell-probe']
          ? 'Host shell probe passed.'
          : 'Host smoke checks passed.',
  );
} finally {
  try {
    await browser?.close();
  } finally {
    if (host.exitCode === null && host.signalCode === null) {
      const ended = once(host, 'close');
      host.kill();
      await ended;
    }
  }
}
