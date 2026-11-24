import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const flowName = '项目约定验收';
export async function createReview({ page, button, row }) {
  await button('新建工作流').click();
  await button('开始编辑').click();
  await page.getByLabel('流程名称', { exact: true }).fill(flowName);
  async function step(index, name, kind, instance) {
    const summary = page.locator('summary').filter({ hasText: new RegExp('^' + index + '\\. ') });
    await summary.click();
    const editor = summary.locator('..');
    await editor.getByLabel('步骤名称', { exact: true }).fill(name);
    if (index === 1) {
      const selector = editor.getByRole('combobox', { name: /^步骤类型/ });
      const instructions = editor.getByRole('textbox', { name: /^执行说明/ });
      await selector.selectOption('develop');
      assert.match(await instructions.inputValue(), /修改代码/);
      await instructions.fill('保留作者指令');
      await selector.selectOption('plan');
      assert.equal(await instructions.inputValue(), '保留作者指令');
    }
    await editor.getByRole('combobox', { name: /^步骤类型/ }).selectOption(kind);
    await editor.getByRole('combobox', { name: /^执行者/ }).selectOption('sihq-agent:' + instance);
    await editor.getByRole('textbox', { name: /^执行说明/ }).fill('按所选项目文档核对入口。');
    if (kind === 'review') {
      await editor.getByLabel('审查策略').selectOption('blocking');
      await editor.getByText('查看 Agent 输入与输出要求', { exact: true }).click();
      await editor.locator('pre').first().filter({ hasText: '按阻塞级别验收' }).waitFor();
    }
  }
  await step(1, '阅读项目约定', 'read', 'quick');
  await button('在末尾添加步骤').click();
  await step(2, '检查用户入口', 'review', 'deep');
  await button('保存').click();
  await row(flowName).waitFor();
}
export async function verifyReview({ page, button, pick, run, latestRun, waitForValue, pass }) {
  const cwd = join(run, 'project/checkout');
  mkdirSync(join(cwd, 'docs'), { recursive: true });
  const path = join(cwd, 'docs/约定.md');
  if (process.env.SIHQ_TEST_HW) {
    writeFileSync(
      join(cwd, 'RULES.md'),
      '# 项目规则\n\n## 文档地图\n\n| 放什么 | 在哪 | 怎么写 |\n| --- | --- | --- |\n| 产品现在的样子 | docs/<功能>.md | 需求 |\n',
    );
  }
  writeFileSync(path, '# 约定\n\n## 现在\nSIHQ_DOC_ORIGINAL 回车后显示流程。');
  const dialog = await pick(flowName);
  await dialog.getByRole('textbox', { name: '任务', exact: true }).fill('文档约定端到端验收');
  await dialog.locator('summary').filter({ hasText: '引用上下文' }).click();
  await dialog.getByText('项目文档', { exact: true }).click();
  const search = dialog.getByLabel(/^文档路径、文件名/);
  await search.fill('约定');
  await button('按文件名查找', dialog).click();
  await button(
    '引用 docs/约定.md',
    dialog.getByRole('region', { name: '匹配的需求文档' }),
  ).waitFor();
  pass('Workspace Files located the Markdown by filename in a nested directory.');
  if (process.env.SIHQ_TEST_HW) {
    await search.fill('回车');
    await button('用 hw 查找相关需求', dialog).click();
    await button(
      '引用 docs/约定.md',
      dialog.getByRole('region', { name: '匹配的需求文档' }),
    ).click();
    pass(
      'The DSH shell ran the installed hw find and the launch picker offered its matching Markdown document.',
    );
  } else {
    await button(
      '引用 docs/约定.md',
      dialog.getByRole('region', { name: '匹配的需求文档' }),
    ).click();
  }
  await dialog.getByText('查看文档原文', { exact: true }).click();
  await dialog.locator('pre').filter({ hasText: 'SIHQ_DOC_ORIGINAL' }).waitFor();
  writeFileSync(path, '# SIHQ_DOC_CHANGED\n已在预览之后修改。');
  await button('开始执行', dialog).click();
  const flow = await waitForValue(
    () => latestRun('文档约定端到端验收', (f) => f.status !== 'running'),
    'two-instance review',
  );
  assert.equal(flow.status, 'passed', flow.error);
  assert.equal(flow.repairCount, 0);
  assert.deepEqual(
    flow.dsh.template.steps.map((s) => s.instanceId),
    ['quick', 'deep'],
  );
  assert.match(flow.steps[0].report.evidence.join(' '), /SIHQ_DOC_ORIGINAL/);
  assert.equal(flow.steps[1].report.suggestions[0].severity, 'P2');
  const sidebar = page.getByRole('region', { name: '当前工作流侧栏' });
  await sidebar.getByText('后续建议 1 项 · 展开步骤查看', { exact: true }).waitFor();
  await sidebar.locator('summary').filter({ hasText: '检查用户入口' }).click();
  await sidebar.getByText('P2 · 合并重复的入口说明', { exact: true }).waitFor();
  await sidebar.getByText('查看实际委派输入', { exact: true }).click();
  const sent = await sidebar.locator('[data-sihq-input]').innerText();
  assert.match(sent, /SIHQ_DOC_ORIGINAL/);
  assert.doesNotMatch(sent, /SIHQ_DOC_CHANGED/);
  await sidebar.screenshot({ path: join(run, 'project-review.png') });
  pass(
    'Created a workflow in settings, chose two named instances, launched it from chat, verified the frozen document across both delegations and displayed the non-blocking P2 in the sidebar.',
    flow.id,
  );
}
