import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { executeVerification } from './verification-command.js';

const markdown = /\.(?:md|markdown)$/iu;
function projectPath(root, input) {
  const path = relative(root, resolve(root, input));
  if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep))
    throw new Error('请选择当前工作目录内的文档');
  return path.split(sep).join('/');
}

/** @param {{directory?: string, file?: string, keyword?: string, query?: string}} request */
export async function projectDocuments(ctx, agent, trial, request, signal) {
  const { directory, file, keyword } = request;
  const files = ctx.get('workspaceFiles');
  if (!files) throw new Error('当前 DSH profile 未启用工作区文件服务');
  const scope = { sessionId: agent.id, workspaceRoot: trial.cwd };
  if (request.query !== undefined) {
    if (typeof request.query !== 'string' || !request.query.trim()) throw new Error('请输入文件名');
    const result = await files.search(
      scope,
      {
        query: request.query.trim(),
        excludedPaths: [],
        includeHidden: false,
        respectGitignore: true,
      },
      signal,
    );
    return {
      paths: result.matches
        .filter((item) => item.type === 'file' && markdown.test(item.path))
        .map((item) => projectPath(trial.cwd, item.path)),
      truncated: result.truncated || result.incomplete,
    };
  }
  if (keyword !== undefined) {
    if (typeof keyword !== 'string' || !keyword.trim()) throw new Error('请输入功能关键词');
    const result = await executeVerification(
      ctx,
      agent,
      trial.cwd,
      { argv: ['hw', 'find', '--json', '--', keyword.trim()], timeoutMs: 15000 },
      signal,
    );
    if (!result.passed)
      throw new Error(['按需求查找失败', result.summary, result.stderr].filter(Boolean).join('\n'));
    if (result.stdoutTruncated) throw new Error('匹配结果过多，请缩小关键词范围');
    const found = JSON.parse(result.stdout);
    if (typeof found.root !== 'string' || !Array.isArray(found.files))
      throw new Error('hw 返回的文档目录无效');
    // hw can locate RULES.md above the active checkout. Only offer files inside this run's cwd.
    const paths = found.files.flatMap((item) => {
      if (typeof item.path !== 'string' || !markdown.test(item.path)) return [];
      const absolute = resolve(found.root, item.path);
      try {
        return [projectPath(trial.cwd, absolute)];
      } catch {
        return [];
      }
    });
    return { paths };
  }
  if (file !== undefined) {
    if (typeof file !== 'string' || !markdown.test(file)) throw new Error('请选择 Markdown 文件');
    const path = projectPath(trial.cwd, file);
    const physical = await realpath(resolve(trial.cwd, path));
    projectPath(trial.cwd, physical);
    if (!markdown.test(physical)) throw new Error('请选择 Markdown 文件');
    const data = await files.readBytes(scope, physical, {}, signal);
    projectPath(trial.cwd, data.absolutePath);
    if (!data.eof) throw new Error('未能完整读取文档，请重新选择');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.data);
    if (text.includes('\0')) throw new Error('文件不是 UTF-8 Markdown 文档');
    const id =
      'document:' + createHash('sha256').update(path).update('\0').update(data.data).digest('hex');
    const item = { kind: 'document', id, label: path, text };
    (trial.documents ??= new Map()).set(id, item);
    return { item };
  }
  const path = projectPath(trial.cwd, directory ?? '');
  const listing = await files.list(scope, path || '.', signal);
  return {
    directory: path,
    truncated: listing.truncated,
    hypo: !path && listing.entries.some((e) => e.type === 'file' && e.name === 'RULES.md'),
    entries: listing.entries
      .filter((e) => e.type === 'directory' || (e.type === 'file' && markdown.test(e.name)))
      .map(({ name, type }) => ({ name, type })),
  };
}
