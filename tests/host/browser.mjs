import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  badName,
  capacityName,
  flowName,
  gitName,
  incompleteName,
  quickName,
  verifyRepairName,
} from './profile.mjs';

import { createReview, verifyReview } from './project-review.mjs';
import { verifyFlowControls } from './controls.mjs';
import { verifyInstanceRepair } from './instance-repair.mjs';

async function waitForValue(fn, suffix) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw Error('Timed out waiting for ' + suffix);
}

// Playwright clicks auto-scroll their target. Hit-test in place to verify
// both the editor action and the focused field are usable at the same time.
function reachableAtCenter(el) {
  const rect = el.getBoundingClientRect();
  return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
}

export async function verify({
  context,
  url,
  run,
  baseline,
  shellProbe,
  expectedShellError,
  productProbe,
}) {
  const errors = [];
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pass = (name, evidence) => {
    console.log(name);
    appendFileSync(join(run, 'checks.jsonl'), JSON.stringify({ name, evidence }) + '\n');
  };
  const button = (name, root = page) => root.getByRole('button', { name, exact: true });
  const row = (name, root = page) =>
    root.locator('article').filter({ has: root.getByText(name, { exact: true }) });
  const models = () => {
    const f = join(run, 'model.jsonl');
    return existsSync(f)
      ? readFileSync(f, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  };
  const latestRun = (task, done) => {
    const base = join(run, 'home/.llm-coder/workflows');
    if (!existsSync(base)) return;
    for (const id of readdirSync(base)) {
      try {
        const f = JSON.parse(readFileSync(join(base, id, 'workflow.json'), 'utf8'));
        if (f.prompt === task && done(f)) return f;
      } catch (e) {
        if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
      }
    }
  };
  async function settings(p = page) {
    await p.locator('[aria-label="插件"]').first().click();
    await p.locator('[aria-label="查看 dsh-sihq"]').first().click();
    await button('管理 Agent 实例', p).waitFor();
  }
  async function chat(workspace) {
    await page.getByText(workspace, { exact: true }).first().hover();
    await page
      .locator('[aria-label*="' + workspace + '"][aria-label*=新建会话]')
      .first()
      .click();
    // The previous session's composer remains mounted while the workspace switch resolves.
    await page.getByText('探索未至之境', { exact: true }).waitFor();
    await page.locator('[contenteditable=true]').first().waitFor();
  }
  async function command(text = '/sihq') {
    const input = page.locator('[contenteditable=true]').first();
    await waitForValue(async () => {
      await input.fill(text);
      await page.waitForTimeout(500); // The host debounces slash-command suggestions.
      return (await input.innerText()) === text;
    }, 'stable host composer');
    await input.press('Enter');
  }
  async function pick(name) {
    await command();
    await page.getByText(name, { exact: true }).last().click();
    const dialog = page.getByRole('dialog', { name, exact: true });
    await dialog.waitFor();
    return dialog;
  }
  async function historyDetail(task) {
    await command();
    await page.getByText('本会话运行记录', { exact: true }).last().click();
    await button('查看详情', page.locator('article').filter({ hasText: task })).click();
    const detail = page.locator('[aria-label="SiliconHQ 运行详情"]');
    await detail.waitFor();
    return detail;
  }

  try {
    await page.goto(url);
    const close = page.locator('[aria-label="关闭"]').first();
    if (await close.isVisible()) await close.click();
    if (productProbe) {
      await chat('SIHQ 测试项目');
      const before = await pick('Smoke 社区后端目录');
      await before.getByText('启动前检查通过', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await command('/smoke-checkout');
      await waitForValue(() => existsSync(join(run, 'checkout.log')), 'changed checkout');
      await command('/smoke-product-cwd');
      await waitForValue(() => existsSync(join(run, 'product-cwd.json')), 'actual product cwd');
      const probe = JSON.parse(readFileSync(join(run, 'product-cwd.json'), 'utf8'));
      assert.equal(resolve(probe.observed), resolve(probe.original));
      assert.notEqual(resolve(probe.observed), resolve(probe.requested));
      const after = await pick('Smoke 社区后端目录');
      await after.getByText(/目标目录新建聊天/).waitFor();
      assert.ok(await button('开始执行', after).isDisabled());
      pass(
        'Installed Product Subagents 0.4.1 used the original cwd; SIHQ rejected dispatch in the switched checkout.',
        probe,
      );
      return;
    }
    if (shellProbe) {
      await chat('SIHQ 测试项目');
      await command('/smoke-checkout');
      await waitForValue(() => existsSync(join(run, 'checkout.log')), 'native control directory');
      await command('/smoke-native-shell');
      await waitForValue(
        () => existsSync(join(run, 'native-shell.json')),
        'native DSH shell response',
      );
      const { call, result } = JSON.parse(readFileSync(join(run, 'native-shell.json'), 'utf8'));
      assert.equal(result.results[0].callId, call.id);
      const output = result.results[0].result;
      if (expectedShellError) {
        assert.equal(output.isError, true, 'Expected a host tool failure');
        assert.equal(output.error?.info?.code, expectedShellError);
        pass('Confirmed the expected host error before command execution.', expectedShellError);
        return;
      }
      assert.equal(output.isError, false, output.error?.message);
      const value = call.name === 'run_code' ? output.value?.result : output.value;
      assert.equal(value?.kind, 'foreground');
      assert.equal(value.exitCode, 0);
      assert.equal(resolve(value.cwd), resolve(join(run, 'project/checkout')));
      assert.match(value.stdout.text, /SMOKE_NATIVE_TOOL/);
      pass('Direct DSH shell produced the expected foreground output and exit code.', call.name);
      {
        await command('/smoke-stop-shell');
        const file = join(run, 'native-stop.json');
        await waitForValue(() => existsSync(file), 'native shell stop evidence');
        const stopped = JSON.parse(readFileSync(file, 'utf8'));
        assert.ok(stopped.jobId, stopped.error);
        pass(
          'Confirmed a real background shell through the original DSH session settlement.',
          stopped.jobId,
        );
      }
      return;
    }
    await settings();
    let evidenceName = flowName;
    if (!baseline) {
      await page.getByText(new RegExp(badName)).first().waitFor();
      const invalid = page.locator('article').filter({ hasText: badName });
      await button('修复工作流', invalid).waitFor();
      await button('编辑', row('Smoke 离线流程')).click();
      await page.getByLabel('流程名称', { exact: true }).fill('Smoke 离线改名');
      await button('保存').click();
      await row('Smoke 离线改名').waitFor();
      await page.getByText(/已保存「Smoke 离线改名」。后端未就绪/).waitFor();
      await button('管理 Agent 实例').click();
      await button('编辑', row('Smoke 离线实例')).click();
      await page.getByLabel('实例名称').fill('Smoke 离线实例改名');
      await button('保存实例').click();
      await row('Smoke 离线实例改名').waitFor();
      const legacyRow = row('Smoke 旧实例');
      await button('更多操作', legacyRow).click();
      await page.getByRole('menuitem', { name: '删除实例', exact: true }).click();
      const replace = legacyRow.getByLabel('替换上述引用为');
      await replace.selectOption('quick');
      await button('确认删除', legacyRow).click();
      await legacyRow.waitFor({ state: 'hidden' });
      await button('返回工作流').click();
      await button('编辑', row('Smoke 旧实例引用')).click();
      await page.locator('summary').filter({ hasText: '阅读证据' }).first().click();
      assert.equal(
        await page.getByRole('combobox', { name: /^执行者/ }).inputValue(),
        'sihq-agent:quick',
      );
      await button('返回列表').click();
      pass(
        'An offline workflow can be renamed and padded legacy references survive instance replacement.',
      );
      await button('编辑', row(flowName)).click();
      evidenceName += ' 已合并';
      const flowNameField = page.getByLabel('流程名称', { exact: true });
      await flowNameField.fill(evidenceName);
      const viewport = page.viewportSize();
      await page.setViewportSize({ width: 940, height: 650 });
      for (const name of ['阅读证据', '人工核对', '复核证据']) {
        await page.locator('summary').filter({ hasText: name }).first().click();
      }
      const readStep = page
        .locator('summary')
        .filter({ hasText: /^1\. 阅读证据/ })
        .locator('..');
      const instructions = readStep.getByRole('textbox', { name: /^执行说明/ });
      const original = await instructions.inputValue();
      await button('插入说明示例', readStep).click();
      await page.getByRole('menuitem', { name: '验证失败分析', exact: true }).click();
      const edited = await instructions.inputValue();
      assert.ok(edited.startsWith(original) && edited.includes('复验建议'));
      await readStep.getByText('查看 Agent 输入与输出要求', { exact: true }).click();
      await waitForValue(
        async () => (await readStep.locator('pre').first().innerText()).includes(edited),
        'editable instruction preview',
      );
      await readStep.getByText('查看 Agent 输入与输出要求', { exact: true }).click();
      await instructions.fill(original);
      const lastStep = page
        .locator('summary')
        .filter({ hasText: /^3\. 复核证据/ })
        .locator('..');
      const lastStepName = lastStep.getByRole('textbox', { name: '步骤名称', exact: true });
      await lastStepName.focus();
      await lastStepName.evaluate((el) =>
        el.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      assert.equal(await flowNameField.evaluate(reachableAtCenter), false);
      assert.ok(
        await lastStepName.evaluate((el) => el === document.activeElement),
        'Expected the final step name to retain focus, got ' +
          (await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 220))),
      );
      assert.ok(await lastStepName.evaluate(reachableAtCenter));
      assert.ok(
        await button('保存').evaluate(reachableAtCenter),
        'Save must be clickable after scrolling',
      );
      const editorActions = page.getByRole('group', { name: '工作流编辑操作' });
      let reachedActions = false;
      for (let move = 0; move < 65 && !reachedActions; move++) {
        await page.keyboard.press('Shift+Tab');
        const focus = await editorActions.evaluate((bar) => {
          const field = document.activeElement;
          const rect = field.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            inActions: bar.contains(field),
            coveredByActions: bar.contains(hit) && !bar.contains(field),
            label:
              field.labels?.[0]?.innerText ?? field.getAttribute('aria-label') ?? field.tagName,
          };
        });
        assert.ok(
          !focus.coveredByActions,
          'Reverse Tab left the editor actions over ' + focus.label,
        );
        reachedActions = focus.inActions;
      }
      assert.ok(reachedActions, 'Reverse Tab should return to the editor actions');
      await page.setViewportSize(viewport);
      pass(
        'Save stays reachable and the sticky actions keep reverse-Tab focus visible in a 940×650 editor.',
      );
      const otherTab = await context.newPage();
      await otherTab.goto(url);
      await settings(otherTab);
      await button('管理 Agent 实例', otherTab).click();
      const quickRow = row(quickName, otherTab);
      const instanceActions = button('更多操作', quickRow);
      await instanceActions.press('Enter');
      const menu = otherTab.getByRole('menu');
      await menu.getByRole('menuitem', { name: '删除实例', exact: true }).waitFor();
      await otherTab.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      await waitForValue(
        () => instanceActions.evaluate((el) => el === document.activeElement),
        'instance action menu return focus',
      );
      await button('编辑', quickRow).click();
      await otherTab.getByLabel('DSH Agent 预设').selectOption('sihq-readonly');
      await button('保存实例', otherTab).click();
      await row(quickName, otherTab).waitFor();
      await otherTab.close();
      await button('保存').click();
      await row(evidenceName).waitFor();
      pass('Editing an unrelated named instance in another tab preserved the workflow draft.');
      await createReview({ page, button, row });
      await button('编辑', row(verifyRepairName)).click();
      await page
        .locator('summary')
        .filter({ hasText: /^2\. 复测/ })
        .click();
      await page.getByRole('combobox', { name: /验证失败时退回/ }).selectOption('writer');
      await page.getByRole('combobox', { name: /该步骤最多退回次数/ }).selectOption('1');
      await button('保存').click();
      await row(verifyRepairName).waitFor();
    } else {
      await button('管理 Agent 实例').click();
      await row(quickName).waitFor();
    }
    await chat('SIHQ 测试项目');
    if (!baseline) {
      await command('/smoke-checkout');
      await waitForValue(() => existsSync(join(run, 'checkout.log')), 'host directory change');
      await command('SMOKE_SELECTED_CHAT');
      await page.getByText('已记录聊天背景。', { exact: true }).first().waitFor();
      const calls = models().length;
      const offline = await pick('Smoke 离线改名');
      await offline.getByText('启动前检查未通过').waitFor();
      assert.ok(await button('开始执行', offline).isDisabled());
      await offline.getByText('查看调用指令', { exact: true }).click();
      assert.equal(
        await offline.getByLabel('聊天调用指令').inputValue(),
        '/sihq workflow --template "offline" "你的任务"',
      );
      await page.keyboard.press('Escape');
      await offline.waitFor({ state: 'hidden' });
      const git = await pick(gitName);
      assert.match(await git.innerText(), /Git/i);
      await git.getByRole('textbox', { name: '任务', exact: true }).fill('Check Git preflight');
      await waitForValue(() => button('开始执行', git).isDisabled(), 'non-Git preflight');
      await button('重新检查', git).click();
      await git.getByText(/已重新检查，任务文字已保留/).waitFor();
      assert.equal(
        await git.getByRole('textbox', { name: '任务', exact: true }).inputValue(),
        'Check Git preflight',
      );
      assert.ok(await button('开始执行', git).isDisabled());
      await page.keyboard.press('Escape');
      await git.waitFor({ state: 'hidden' });
      assert.equal(models().length, calls);
      pass('Broken template isolated; non-Git preflight blocked before model invocation.');
      const saved = await pick('Smoke 旧实例引用');
      await saved.getByText('查看调用指令', { exact: true }).click();
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (value) => {
              window.sihqCopiedCommand = value;
            },
          },
        }),
      );
      await button('复制调用指令', saved).click();
      await saved.getByText('已复制调用指令。', { exact: true }).waitFor();
      const copied = await page.evaluate(() => window.sihqCopiedCommand);
      await page.keyboard.press('Escape');
      await saved.waitFor({ state: 'hidden' });
      const prompt = '复制指令验收 ' + Date.now();
      await command(copied.replace('你的任务', prompt));
      const launched = await waitForValue(
        () => latestRun(prompt, (f) => f.status === 'completed'),
        'copied workflow command',
      );
      assert.equal(launched.dsh.template.id, 'padded-instance');
      assert.equal(launched.dsh.template.steps[0].instanceId, 'quick');
      pass(
        'Pasted the command copied from the launch dialog and completed the workflow with the replacement instance.',
      );
    }
    const task = 'Host evidence ' + Date.now();
    const ready = await pick(evidenceName);
    if (!baseline) {
      const taskField = ready.getByRole('textbox', { name: '任务', exact: true });
      await waitForValue(
        () => taskField.evaluate((el) => el === document.activeElement),
        'launch dialog initial focus',
      );
      await taskField.fill('   ');
      assert.ok(await button('开始执行', ready).isDisabled());
      await ready.getByText('请输入任务描述。', { exact: true }).waitFor();
      assert.ok((await ready.innerText()).includes('checkout'));
      await ready.locator('summary').filter({ hasText: '引用上下文' }).click();
      await ready.getByRole('checkbox', { name: /用户.*SMOKE_SELECTED_CHAT/ }).check();
    }
    assert.match(await ready.innerText(), /quick/);
    await ready.locator('textarea').first().fill(task);
    await button('开始执行', ready).click();
    const waiting = await waitForValue(
      () => latestRun(task, (f) => f.status === 'waiting_approval'),
      'durable human gate',
    );
    assert.equal(resolve(waiting.cwd), resolve(run, baseline ? 'project' : 'project/checkout'));
    if (!baseline) assert.equal(waiting.dsh.template.steps[0].agentPreset, 'sihq-readonly');
    pass('Chat submitted the preview in its selected workspace.', waiting.id);

    if (!baseline) {
      const sidebar = page.getByRole('region', { name: '当前工作流侧栏' });
      await button('处理审批 · 人工核对', sidebar).waitFor();
      assert.ok((await sidebar.innerText()).includes(waiting.id));
    }
    await page.reload();
    if (!baseline) {
      const restored = page.getByRole('region', { name: '当前工作流侧栏' });
      await button('处理审批 · 人工核对', restored).click();
      assert.ok((await restored.innerText()).includes(waiting.id));
      await restored.screenshot({ path: join(run, 'current-workflow.png') });
      pass(
        'The native sidebar restored the exact running workflow and pending approval after reload.',
      );
    }
    const stepRequests = [];
    const progressRequests = [];
    const countReads = (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/sihqCatalog/runStep')) stepRequests.push(request.postDataJSON().payload);
      if (path.endsWith('/sihqCatalog/runProgress'))
        progressRequests.push(request.postDataJSON().payload);
    };
    page.on('request', countReads);
    const detail = await historyDetail(task);
    const step = detail.locator('details').filter({ hasText: '阅读证据' }).first();
    await step.locator('summary').first().waitFor();
    if (!baseline) {
      assert.equal(stepRequests.length, 0);
      assert.ok(!(await detail.innerText()).includes('END_OF_EVIDENCE'));
      assert.ok(progressRequests.length > 0);
    }
    await step.locator('summary').first().click();
    await waitForValue(
      async () => (await step.innerText()).includes('END_OF_EVIDENCE'),
      'complete lazy evidence',
    );
    assert.ok((await step.innerText()).includes('long '.repeat(14500) + 'END_OF_EVIDENCE'));
    if (!baseline) {
      assert.equal(stepRequests.length, 1);
      assert.equal(stepRequests[0].round, 1);
      assert.equal(stepRequests[0].index, 0);
      const evidence = await step.getByLabel('执行模型信息').innerText();
      assert.match(evidence, /指派 · Smoke 快读.*sihq-test\/quick.*low.*预设 sihq-readonly/);
      assert.match(evidence, /实际请求 · sihq-test\/quick/);
      const fullReport = await step.locator('[data-sihq-report]').textContent();
      assert.deepEqual(JSON.parse(fullReport), waiting.steps[0].report);
      // The browser test owns this clipboard so the user's OS clipboard stays untouched.
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (value) => {
              window.sihqCopiedReport = value;
            },
          },
        }),
      );
      await button('复制完整报告', step).click();
      assert.equal(await page.evaluate(() => window.sihqCopiedReport), fullReport);
      await step.getByText('查看实际委派输入', { exact: true }).click();
      const input = await step.locator('[data-sihq-input]').textContent();
      assert.ok(
        input.includes('SMOKE_READ') &&
          input.includes(task) &&
          input.includes('SMOKE_SELECTED_CHAT'),
      );
      await detail.getByLabel('决定说明（可选）').fill('确认本轮证据');
      await waitForValue(
        () => progressRequests.some((req) => req.revision !== undefined),
        'incremental progress poll',
      );
      assert.equal(stepRequests.length, 1);
      await step.locator('summary').first().click();
      await button('刷新详情', detail).click();
      assert.equal(await detail.getByLabel('决定说明（可选）').inputValue(), '确认本轮证据');
      assert.equal(stepRequests.length, 1);
      pass(
        'Closed steps request no full reports; incremental polling preserves the gate, input and complete copied evidence.',
      );
    }
    page.off('request', countReads);
    await button('继续运行（批准）', detail).click();
    await waitForValue(
      () => latestRun(task, (f) => f.status === 'completed'),
      'approved run completion',
    );
    pass('Refreshed history still opens the complete 72k evidence and approves the gate.');

    if (!baseline) {
      await button('继续下一轮', detail).click();
      const continuation = page.getByRole('dialog', { name: evidenceName, exact: true });
      await continuation.locator('summary').filter({ hasText: '引用上下文' }).click();
      await continuation
        .getByRole('checkbox', { name: /阅读证据/ })
        .first()
        .check();
      const nextTask = 'Selected previous report ' + Date.now();
      await continuation.locator('textarea').first().fill(nextTask);
      await button('开始下一轮', continuation).click();
      const next = await waitForValue(
        () => latestRun(nextTask, (f) => f.status === 'waiting_approval'),
        'round 2 human gate',
      );
      assert.equal(next.id, waiting.id);
      assert.equal(next.round, 2);
      const roundDetail = await historyDetail(nextTask);
      await roundDetail.getByLabel('轮次').selectOption('1');
      await roundDetail.getByText(task, { exact: true }).waitFor();
      await page.reload();
      await roundDetail.getByText(task, { exact: true }).waitFor();
      assert.equal(await roundDetail.getByLabel('轮次').inputValue(), '1');
      assert.equal(await button('拒绝继续', roundDetail).count(), 0);
      await roundDetail.getByLabel('轮次').selectOption('');
      await button('拒绝继续', roundDetail).click();
      await waitForValue(
        () => latestRun(nextTask, (f) => f.status === 'rejected'),
        'round 2 reject',
      );
      pass(
        'Continued with a selected report, restored the historical round on reload and rejected the gate only in the latest round.',
      );

      const limited = await pick(capacityName);
      const limitedTask = 'Capacity one, two readers ' + Date.now();
      const start = models().length;
      await limited.locator('textarea').first().fill(limitedTask);
      await button('开始执行', limited).click();
      const settled = await waitForValue(
        () => latestRun(limitedTask, (f) => f.status !== 'running'),
        'parallel admission',
      );
      assert.equal(settled.status, 'completed', settled.error);
      assert.deepEqual(
        models()
          .slice(start)
          .filter((e) => e.event === 'start' && e.structured)
          .map((e) => e.tag)
          .sort(),
        ['SMOKE_LEFT', 'SMOKE_RIGHT'],
      );
      pass('Two readers used one real DSH capacity slot without duplicate activation.');

      const incomplete = await pick(incompleteName);
      const request = 'Incomplete ' + Date.now();
      await incomplete.locator('textarea').first().fill(request);
      await button('开始执行', incomplete).click();
      const stopped = await waitForValue(
        () => latestRun(request, (f) => f.status !== 'running'),
        'incomplete run',
      );
      assert.ok(['failed', 'blocked', 'incomplete'].includes(stopped.status), stopped.status);
      assert.equal(stopped.steps[0].report.outcome, 'incomplete');
      pass('Unclaimed incomplete development preserved its report and stopped the workflow.');
      await verifyFlowControls({
        page,
        run,
        pass,
        button,
        models,
        command,
        pick,
        historyDetail,
        latestRun,
        waitForValue,
      });
    }
    if (!baseline) await verifyReview({ page, button, pick, run, latestRun, waitForValue, pass });
    await chat('SIHQ 隔离项目');
    await command();
    await page.getByText('本会话运行记录', { exact: true }).last().click();
    await page
      .getByText(/暂无|还没有|没有运行/)
      .last()
      .waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes(task));
    pass('Second project has independent history.');
    if (!baseline) {
      await button('新标签页').click();
      await page
        .getByRole('button', { name: /^当前工作流/ })
        .last()
        .click();
      await page
        .getByText('本会话还没有运行记录。在聊天中输入 /sihq 可启动工作流。', { exact: true })
        .waitFor();
      pass('The native new-tab guide opens the current workflow for the selected session.');
      await settings();
      await verifyInstanceRepair(page);
      pass(
        'Repaired and deleted individual duplicate agent rows without changing their surviving identities.',
      );
      const flowActions = button('更多操作', row(evidenceName));
      await flowActions.press('ArrowDown');
      const menu = page.getByRole('menu');
      await menu.getByRole('menuitem', { name: '查看调用指令', exact: true }).press('Enter');
      const runCommand = await row(evidenceName).getByLabel('聊天调用指令').inputValue();
      await flowActions.click();
      const [file] = await Promise.all([
        page.waitForEvent('download'),
        menu.getByRole('menuitem', { name: '导出工作流', exact: true }).click(),
      ]);
      const data = JSON.parse(readFileSync(await file.path(), 'utf8'));
      assert.equal(
        runCommand,
        '/sihq workflow --template "' + data.workflow.template.id + '" "你的任务"',
      );
      assert.equal(data.instances[0].agentPreset, 'sihq-readonly');
      // Reproduce a target profile that already has an unrelated instance with the same name.
      data.instances[0].model = 'deep';
      const input = {
        name: 'smoke.sihq.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(data)),
      };
      for (const repeat of [false, true]) {
        await button('导入工作流').click();
        await page.getByLabel('工作流文件').setInputFiles(input);
        await page.getByLabel(/目标实例/).waitFor();
        await button('检查导入').click();
        const panel = page.locator('fieldset').filter({ has: page.getByLabel('工作流文件') });
        await button('确认导入', panel).waitFor();
        if (repeat) assert.match(await panel.innerText(), /复用实例/);
        await button('确认导入', panel).click();
        await page.getByLabel('工作流文件').waitFor({ state: 'detached' });
      }
      pass(
        'Exported DSH preset was preserved; repeating a colliding import reuses its previous instance.',
      );
      const paddedRow = row('Smoke padded delete');
      await button('更多操作', paddedRow).click();
      await page.getByRole('menuitem', { name: '删除工作流', exact: true }).click();
      await button('确认删除', paddedRow).click();
      await paddedRow.waitFor({ state: 'detached' });
      await row(evidenceName).waitFor();
      pass(
        'Edited, launched and deleted whitespace-padded legacy workflow IDs by their original rows.',
      );
      const invalidRow = page.locator('article').filter({ hasText: badName });
      await button('修复工作流', invalidRow).click();
      await button('移除失效的输入和退回引用', invalidRow).click();
      await button('保存修复', invalidRow).click();
      await button('编辑', row(badName)).waitFor();
      pass('Repaired an invalid template without deleting the other templates.');
    }
    assert.deepEqual(errors, []);
  } catch (e) {
    await page.screenshot({ path: join(run, 'failure.png') }).catch(() => {});
    appendFileSync(
      join(run, 'failure.txt'),
      errors.join('\n') + '\n' + (await page.locator('body').innerText()).slice(-12000),
    );
    throw e;
  }
}
