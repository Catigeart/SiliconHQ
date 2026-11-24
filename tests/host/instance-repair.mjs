import assert from 'node:assert/strict';

// Enter and leave the settings workflow list. Three duplicate ID rows allow
// us to repair one and delete another while checking the remaining identity.
export async function verifyInstanceRepair(page) {
  const action = (scope, name) => scope.getByRole('button', { name, exact: true });
  const broken = (n) =>
    page.getByRole('article', { name: new RegExp('^Smoke duplicate ' + n + ' · 第') });
  const valid = (n) => page.getByRole('article', { name: 'Smoke duplicate ' + n, exact: true });
  await action(page, '管理 Agent 实例').click();
  await action(broken(1), '修复实例').click();
  await action(broken(1), '为此项生成新 ID').click();
  const input = JSON.parse(await broken(1).getByLabel('实例配置（JSON）').inputValue());
  assert.notEqual(input.id, 'dupe');
  await action(broken(1), '保存修复').click();
  await valid(1).waitFor();
  await broken(3).waitFor();
  await action(broken(2), '删除实例').click();
  await action(broken(2), '确认删除').click();
  await valid(3).waitFor();
  assert.equal(await valid(1).count(), 1);
  assert.equal(await page.getByText('Smoke duplicate 2', { exact: true }).count(), 0);
  await action(page, '返回工作流').click();
}
