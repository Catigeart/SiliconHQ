import { workflowRowId } from './dist/workflow/rules.js';
import { instancePrefix } from './agent-instances.js';
import { workflowTemplateSchema } from './dist/workflow/templates.js';
export { workflowTemplateSchema, diffReview } from './dist/workflow/templates.js';

// Examine each stored row independently. Keep its position so even duplicate or
// missing IDs can be repaired without changing another workflow.
/** @typedef {import('./dist/workflow/templates.js').WorkflowTemplate} WorkflowTemplate */
/** @typedef {{index:number, id:string, name:string, diagnostic?:string, editable?:boolean, template?:WorkflowTemplate}} TemplateEntry */
/** @param {unknown} rows @param {{instanceIds?: Set<string>}} [options] @returns {TemplateEntry[]} */
export function inspectTemplates(rows, { instanceIds } = {}) {
  if (!Array.isArray(rows)) throw new Error('工作流配置必须是数组');
  const counts = new Map();
  for (const row of rows) {
    const id = workflowRowId(row);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return rows.map((row, index) => {
    const id = workflowRowId(row);
    const item = {
      index,
      id,
      name: (typeof row?.name === 'string' && row.name.trim()) || '未命名流程',
    };
    if (counts.get(id) > 1 || id === 'siliconhq')
      return { ...item, diagnostic: '流程 ID 重复或与 SiliconHQ 默认模板冲突' };
    const parsed = workflowTemplateSchema.safeParse(row);
    if (!parsed.success) {
      const diagnostic = parsed.error.issues
        .map((issue) => {
          const path = issue.path;
          const field =
            path[0] === 'steps' && typeof path[1] === 'number'
              ? '第 ' + (path[1] + 1) + ' 步 ' + path.slice(2).join('.')
              : path.join('.');
          return (field ? field + '：' : '') + issue.message;
        })
        .join('；');
      return { ...item, diagnostic };
    }
    if (instanceIds) {
      const missing = parsed.data.steps.filter(
        (s) =>
          s.backend.startsWith(instancePrefix) &&
          !instanceIds.has(s.backend.slice(instancePrefix.length)),
      );
      if (missing.length)
        return {
          ...item,
          editable: true,
          diagnostic: missing
            .map((s) => s.name + '：找不到引用的 Agent 实例 ' + s.backend)
            .join('；'),
        };
    }
    return { ...item, template: parsed.data };
  });
}

export function selectedWorkflowTemplate(rows, id, options) {
  const entry = inspectTemplates(rows, options).find((row) => row.id === id);
  if (entry?.diagnostic) throw new Error(entry.name + '：' + entry.diagnostic);
  return entry?.template;
}

export function validateTemplates(value) {
  return inspectTemplates(value).map((row) => {
    if (!row.template) throw new Error(row.name + '：' + row.diagnostic);
    return row.template;
  });
}
