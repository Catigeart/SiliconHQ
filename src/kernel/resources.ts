import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { waitForWorkspace } from '../storage/workspace-lock.js';
import { KernelStore, type State } from './store.js';

export async function acquireGpu(s: State, root: string, signal: AbortSignal) {
  const directory = join(root, '..', 'gpu-lock');
  mkdirSync(directory, { recursive: true });
  const store = new KernelStore(dirname(root));
  let release: () => void;
  try {
    release = await waitForWorkspace(directory, signal, () => {
      s.activity = {
        kind: 'waiting_resource',
        since: Date.now(),
        detail: '等待其他 sihq 测试释放 GPU',
      };
      store.save(s);
      store.event(s, 'resource.waiting', s.activity);
    });
  } catch (error) {
    delete s.activity;
    store.save(s);
    throw error;
  }
  if (s.activity?.kind === 'waiting_resource') {
    delete s.activity;
    store.save(s);
    store.event(s, 'resource.acquired', { resource: 'gpu' });
  }
  return release;
}
