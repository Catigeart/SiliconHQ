import { test } from 'node:test';

// These fixtures execute a shebang script directly. Windows would either fail
// to launch the script or resolve the user's installed Codex from PATH.
export function posixCodexTest(name, run) {
  const skip = process.platform === 'win32' && 'The mock Codex executable requires a POSIX shebang';
  return test(name, { skip }, run);
}
