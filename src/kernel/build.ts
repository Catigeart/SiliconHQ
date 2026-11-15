import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { command } from './process.js';
async function compileFrozen(
  source: string,
  trusted: string,
  dest: string,
  log: string,
  signal: AbortSignal,
  onBuild: () => void = () => {},
): Promise<string> {
  const build = join(dest, 'build');
  // A fixed build recipe, outside the candidate, prevents changed CMake/test code from bypassing checks.
  const quote = (v: string) => '"' + v.replaceAll('\\', '/').replaceAll('"', '\\"') + '"';
  const initializerSource = ['benchmark_input.cu', 'correctness_input.cu']
    .map((name) => join(trusted, 'tests', name))
    .filter((path) => existsSync(path))
    .map((path) => ' ' + quote(path))
    .join('');
  writeFileSync(
    join(dest, 'CMakeLists.txt'),
    `cmake_minimum_required(VERSION 3.22)
project(kernel_check LANGUAGES CXX CUDA)
find_package(CUDAToolkit REQUIRED)
find_package(Boost REQUIRED)
add_library(candidate STATIC ${quote(join(source, 'src/trtri.cu'))})
target_include_directories(candidate PRIVATE ${quote(join(source, 'include'))})
target_link_libraries(candidate PUBLIC CUDA::cudart CUDA::cublas)
target_compile_features(candidate PRIVATE cuda_std_17)
add_executable(diagonal ${quote(join(trusted, 'tests/diagonal_workflow.cpp'))}${initializerSource})
target_include_directories(diagonal PRIVATE ${quote(join(trusted, 'include'))} ${quote(join(trusted, 'tests'))} \${Boost_INCLUDE_DIRS})
target_compile_features(diagonal PRIVATE cxx_std_17 cuda_std_17)
target_link_libraries(diagonal PRIVATE candidate)
`,
  );
  await command(
    [
      'cmake',
      '-S',
      dest,
      '-B',
      build,
      '-G',
      'Ninja',
      '-DCMAKE_BUILD_TYPE=Release',
      '-DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc',
      '-DCMAKE_CUDA_ARCHITECTURES=80;90;120',
    ],
    dest,
    log,
    signal,
  );
  onBuild();
  await command(['cmake', '--build', build, '-j', '2'], dest, log, signal);
  return join(build, 'diagonal');
}

// The same inputs always compile at the same path. Absolute paths embedded in
// CUDA binaries therefore no longer defeat sanitizer reuse between experiments.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { atomic, copySource, manifest, readJson, treeManifest } from './store.js';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let compilerIdentity: string | undefined;
function toolchain() {
  return (compilerIdentity ??= JSON.stringify(
    ['/usr/local/cuda/bin/nvcc', 'cmake', 'c++'].map((tool) => [
      tool,
      execFileSync(tool, ['--version'], { encoding: 'utf8', timeout: 10000 }),
    ]),
  ));
}
export async function buildFrozen(
  source: string,
  trusted: string,
  dest: string,
  log: string,
  signal: AbortSignal,
  onBuild: () => void = () => {},
): Promise<string> {
  signal.throwIfAborted();
  mkdirSync(dest, { recursive: true });
  const inputs = {
    source: manifest(source),
    trusted: treeManifest(trusted),
    toolchain: toolchain(),
    recipe: digest(readFileSync(new URL('./build.js', import.meta.url))),
  };
  const key = digest(JSON.stringify(inputs));
  const cache = join(dirname(trusted), 'build-cache', key),
    record = join(cache, 'artifact.json');
  const binary = join(cache, 'build/diagonal');
  if (existsSync(record) && existsSync(binary)) {
    let old;
    try {
      old = readJson(record);
    } catch {
      old = null;
    }
    if (
      old?.hash === digest(readFileSync(binary)) &&
      JSON.stringify(old.inputs) === JSON.stringify(inputs)
    ) {
      atomic(join(dest, 'build-artifact.json'), {
        key,
        binary,
        hash: old.hash,
        reused: true,
        record,
      });
      return binary;
    }
  }
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  copySource(source, join(cache, 'source'));
  const built = await compileFrozen(join(cache, 'source'), trusted, cache, log, signal, onBuild);
  if (
    JSON.stringify(manifest(source)) !== JSON.stringify(inputs.source) ||
    JSON.stringify(treeManifest(trusted)) !== JSON.stringify(inputs.trusted)
  )
    throw new Error('构建期间输入变化');
  const hash = digest(readFileSync(built));
  atomic(record, { inputs, hash });
  atomic(join(dest, 'build-artifact.json'), { key, binary: built, hash, reused: false, record });
  return built;
}
