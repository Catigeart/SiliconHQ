import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson } from './dist/storage/files.js';
import { baselineSource } from './workflow-git.js';

export function chatSources(session) {
  const items = [];
  const events = session?.snapshotEvents?.() ?? session?.events ?? [];
  for (const event of events) {
    const user = event.type === 'user/message' && event.data?.source?.kind === 'user';
    if (!user && event.type !== 'assistant/message') continue;
    const content = user ? event.data.content : event.data?.message?.content;
    if (!Array.isArray(content)) continue;
    // Only human-facing text. Tool results, reasoning and injected messages stay out.
    const parts = content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text);
    if (!parts.some((part) => /\S/u.test(part))) continue;
    let preview = '';
    for (const part of parts) {
      preview = (preview + part.slice(0, 50) + '\n').slice(0, 50);
      if (preview.length === 50) break;
    }
    const key = user
      ? event.data.id
      : event.data.turn !== undefined && event.data.step !== undefined
        ? event.data.turn + '/' + event.data.step
        : undefined;
    items.push({
      id: (user ? 'user:' : 'assistant:') + (key ?? randomUUID()),
      kind: 'chat',
      label: (user ? '用户' : '助手') + ' · ' + preview.trimEnd(),
      read: () => parts.join('\n'),
    });
  }
  return items;
}

export function reportSources(detail, readReport) {
  return detail.steps.flatMap((step, index) =>
    step.reportAvailable
      ? [
          {
            id: 'report:' + detail.id + ':' + detail.round + ':' + index,
            kind: 'report',
            label:
              detail.name +
              ' · 第 ' +
              detail.round +
              ' 轮 · ' +
              (index + 1) +
              '. ' +
              step.name +
              (step.supersededByApproval || step.supersededByRepair ? '（退回前）' : ''),
            read: () => readReport(step, index),
          },
        ]
      : [],
  );
}

export async function contextReference(trial, id) {
  if (trial.diff && trial.diff.id === id) return trial.diff;
  const candidate = trial.candidates?.find((item) => item.id === id);
  if (!candidate) throw new Error('选中的上下文不属于本次预览');
  const existing = trial.sources?.find((item) => item.id === id);
  if (existing) return existing;
  const { kind, label, read } = candidate;
  const item = { id, kind, label, text: await read() };
  // A checkbox and an expanded preview can request the same item concurrently.
  const frozen = trial.sources.find((source) => source.id === id);
  if (frozen) return frozen;
  trial.sources.push(item);
  return item;
}

export async function attachDiff(trial, readDiff) {
  if (trial.diff) return;
  if (trial.loadingDiff) return trial.loadingDiff;
  trial.loadingDiff = capture();
  try {
    await trial.loadingDiff;
  } finally {
    delete trial.loadingDiff;
  }
  async function capture() {
    try {
      trial.diff = baselineSource(await readDiff(trial.cwd));
      delete trial.diffError;
    } catch (error) {
      trial.diffError = error.message;
    }
  }
}

export function selectHandoff(trial, selection) {
  const ids = selection === undefined ? [] : JSON.parse(selection);
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string') ||
    new Set(ids).size !== ids.length
  )
    throw new Error('上下文选择无效，请重新预览');
  const available = [
    ...(trial.sources ?? []),
    ...(trial.documents?.values() ?? []),
    ...(trial.diff ? [trial.diff] : []),
  ];
  if (trial.diffRequired && !trial.diff)
    throw new Error(trial.diffError || '无法读取工作流要求的 Git diff');
  const selected = new Set(ids);
  if (trial.diffRequired) selected.add(trial.diff.id);
  if ([...selected].some((id) => !available.some((item) => item.id === id)))
    throw new Error('选中的上下文不属于本次预览');
  return [...selected].map((id) => available.find((item) => item.id === id));
}

export function promptWithHandoff(prompt, sources) {
  if (!sources?.length) return prompt;
  return (
    prompt +
    '\n本轮选择的参考资料（作为背景，以任务和验收标准为准）\n' +
    JSON.stringify(sources.map(({ kind, label, text }) => ({ kind, label, text })))
  );
}

// Separate from DSH activation receipts: writing a delivery trace does not imply admission.
export function recordStepInput(directory, executionId, value) {
  const file = join(directory, 'dsh-input-' + executionId + '.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  const attempts = previous
    ? [
        ...(previous.previousAttempts ?? []),
        {
          at: previous.at,
          prompt: previous.prompt,
          structured: previous.structured,
          outputSchema: previous.outputSchema,
          sources: previous.sources,
        },
      ]
    : [];
  atomicJson(file, {
    ...value,
    at: new Date().toISOString(),
    ...(attempts.length ? { previousAttempts: attempts } : {}),
  });
}
