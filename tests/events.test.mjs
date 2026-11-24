import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeEvents } from '../dist/adapters/codex.js';
async function* stream(events) {
  yield* events;
}
test('failure event rejects with the actual reason', async () => {
  await assert.rejects(
    consumeEvents(stream([{ type: 'turn.failed', error: { message: 'authentication failed' } }])),
    /authentication failed/,
  );
});
test('truncated streams cannot report success', async () => {
  await assert.rejects(consumeEvents(stream([])), /未确认完成/);
});
test('fatal stream error rejects', async () => {
  await assert.rejects(
    consumeEvents(stream([{ type: 'error', message: 'connection lost' }])),
    /connection lost/,
  );
});
test('completed turn succeeds', async () => {
  await consumeEvents(
    stream([{ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }]),
  );
});
