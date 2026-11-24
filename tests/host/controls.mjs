import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  diffFlowName,
  repairFlowName,
  reassignFlowName,
  verifyFlowName,
  verifyRepairName,
} from './profile.mjs';

import { verifyProgressAbort } from './progress-abort.mjs';

export async function verifyFlowControls({
  page,
  run,
  button,
  command,
  pick,
  historyDetail,
  models,
  latestRun,
  waitForValue,
  pass,
}) {
  const checkout = join(run, 'project', 'checkout');
  const inputFor = (step) =>
    JSON.parse(
      readFileSync(
        join(run, 'home/.llm-coder/runs', step.runId, 'dsh-input-' + step.executionId + '.json'),
        'utf8',
      ),
    ).prompt;
  const state = (task, predicate, description) =>
    waitForValue(() => latestRun(task, predicate), description);
  const waiting = (task) =>
    state(task, (f) => f.status === 'waiting_approval', 'human gate for ' + task.slice(0, 45));
  const finished = (task) =>
    state(task, (f) => f.status === 'completed', 'completed workflow ' + task.slice(0, 45));
  const submit = async (dialog, task) => {
    await dialog.locator('textarea').first().fill(task);
    await button('开始执行', dialog).click();
  };

  const referencePrefix = '审批附件 ' + Date.now();
  const reference = referencePrefix + '背景内容。'.repeat(160) + 'REFERENCE-END-53';
  await command(reference);
  await page.getByText(reference, { exact: true }).first().waitFor();
  const prefix = '完整需求 ' + Date.now();
  const task = prefix + ' 具体任务。'.repeat(130) + 'TASK-END-47';
  const ready = await pick(repairFlowName);
  await ready.locator('summary').filter({ hasText: '引用上下文' }).click();
  await ready.getByRole('checkbox', { name: new RegExp('用户.*' + referencePrefix) }).check();
  await submit(ready, task);
  const firstGate = await waiting(task);
  const contextRequests = [];
  const countApproval = (req) => {
    if (new URL(req.url()).pathname.endsWith('/sihqCatalog/runApprovalContext'))
      contextRequests.push(req.postDataJSON().payload);
  };
  page.on('request', countApproval);
  const detail = await historyDetail(prefix);
  const fullContext = detail.getByText('查看完整任务和本轮引用', { exact: true });
  await fullContext.waitFor();
  assert.equal(contextRequests.length, 0);
  assert.ok(!(await detail.innerText()).includes('TASK-END-47'));
  await fullContext.click();
  const fullTask = detail.getByLabel('本轮完整任务');
  await fullTask.waitFor();
  assert.equal(await fullTask.textContent(), task);
  await detail.locator('summary').filter({ hasText: referencePrefix }).click();
  await detail.getByText(reference, { exact: true }).waitFor();
  assert.equal(contextRequests.length, 1);
  assert.equal(contextRequests[0].approvalId, firstGate.pendingApproval.id);
  page.off('request', countApproval);
  await detail.getByText('核对上游报告 · 阅读证据', { exact: true }).click();
  await detail.locator('[data-sihq-report]').first().waitFor();
  assert.deepEqual(
    JSON.parse(await detail.locator('[data-sihq-report]').first().textContent()),
    firstGate.steps[0].report,
  );
  const note = '补查独立证据 HUMAN-RETURN-29';
  await detail.getByLabel('退回目标步骤').selectOption('read');
  assert.ok(await button('退回修改', detail).isDisabled());
  await detail.getByLabel('决定说明（可选）').fill(note);
  await button('退回修改', detail).click();
  const secondGate = await state(
    task,
    (f) => f.status === 'waiting_approval' && f.pendingApproval.id !== firstGate.pendingApproval.id,
    'reopened gate',
  );
  assert.equal(secondGate.repairCount, 1);
  assert.equal(secondGate.id, firstGate.id);
  assert.equal(secondGate.steps.find((s) => s.report?.decision === 'returned').report.note, note);
  const revised = secondGate.steps.findLast((s) => s.node === 'read');
  assert.notEqual(revised.runId, firstGate.steps[0].runId);
  assert.ok(
    inputFor(revised).includes(note) && inputFor(revised).includes('SMOKE_REVISION evidence'),
  );
  await command('/sihq workflow approve ' + secondGate.id + ' ' + firstGate.pendingApproval.id);
  await page
    .getByText(/此确认已失效|审批已失效|确认.*过期|人工确认已变更/)
    .last()
    .waitFor();
  assert.equal((await waiting(task)).pendingApproval.id, secondGate.pendingApproval.id);
  await command('/sihq workflow approve ' + secondGate.id + ' ' + secondGate.pendingApproval.id);
  await finished(task);
  pass(
    'Approval loaded the entire 500+ character task, selected source and upstream report on demand. Returning sent the note and prior evidence to the same step, rejected the old gate and completed after fresh approval.',
    secondGate.id,
  );

  execFileSync('git', ['init', '--quiet'], { cwd: checkout, windowsHide: true });
  const tracked = join(checkout, 'tracked.txt');
  writeFileSync(tracked, 'INITIAL\n');
  execFileSync('git', ['add', '--', 'tracked.txt'], {
    cwd: checkout,
    windowsHide: true,
    stdio: 'pipe',
  });
  for (const entry of ['menu', 'command']) {
    const before = 'ROUND-BASELINE-' + entry,
      after = 'CURRENT-STEP-' + entry;
    const task = 'Diff policy ' + entry + ' ' + Date.now();
    writeFileSync(tracked, before + '\n');
    if (entry === 'menu') {
      const dialog = await pick(diffFlowName);
      await submit(dialog, task);
    } else await command('/sihq run diffs "' + task + '"');
    const flow = await waiting(task);
    await page
      .getByRole('region', { name: '当前工作流侧栏' })
      .getByText(task, { exact: true })
      .waitFor();
    writeFileSync(tracked, after + '\n');
    await command('/sihq workflow approve ' + flow.id + ' ' + flow.pendingApproval.id);
    const complete = await finished(task);
    const getInput = (node) => inputFor(complete.steps.find((s) => s.node === node));
    for (const node of ['read', 'frozen']) {
      assert.ok(getInput(node).includes(before) && !getInput(node).includes(after));
      assert.ok(getInput(node).includes('本轮启动时的 Git diff'));
    }
    assert.ok(
      getInput('live').includes(before) &&
        getInput('live').includes(after) &&
        getInput('live').includes('本步骤开始时的 Git diff'),
    );
    pass(
      'Git inputs via ' +
        entry +
        ' kept the round baseline and read post-approval changes only on the configured live step.',
      flow.id,
    );
  }

  const rerouteTask = 'Reassign to second named instance ' + Date.now();
  const callStart = models().length;
  await submit(await pick(reassignFlowName), rerouteTask);
  const failed = await state(rerouteTask, (f) => f.status === 'failed', 'failed first attempt');
  const prior = failed.steps[0];
  const retryDetail = await historyDetail(rerouteTask);
  await button('改派失败步骤', retryDetail).click();
  assert.equal(await retryDetail.getByLabel('失败步骤').inputValue(), prior.executionId);
  await retryDetail.getByLabel('新 Agent 实例').selectOption('deep');
  assert.ok(await button('确认改派', retryDetail).isDisabled());
  await retryDetail.getByLabel('已核对工作区，允许重新委派').check();
  await button('确认改派', retryDetail).click();
  const resumed = await finished(rerouteTask);
  assert.equal(resumed.id, failed.id);
  assert.notEqual(resumed.steps[0].executionId, prior.executionId);
  assert.equal(resumed.steps[0].routeOverride.instanceId, 'deep');
  assert.equal(resumed.dsh.template.steps[0].instanceId, 'quick');
  const previous = resumed.steps[0].previousAttempts[0];
  assert.equal(previous.executionId, prior.executionId);
  assert.equal(previous.route.instanceId, 'quick');
  const trace = models()
    .slice(callStart)
    .filter((e) => e.event === 'start' && e.structured);
  assert.deepEqual(
    [...new Set(trace.map((e) => e.model + '/' + e.effort))],
    ['quick/low', 'deep/high'],
  );
  const completedStep = retryDetail
    .locator('summary')
    .filter({ hasText: /阅读证据.*已完成/ })
    .first();
  await completedStep.click();
  await retryDetail.getByText('历史尝试', { exact: true }).click();
  const priorArticle = retryDetail.locator('article').filter({ hasText: prior.executionId });
  assert.match(
    await priorArticle.getByLabel('执行模型信息').innerText(),
    /实际请求 · sihq-test\/quick/,
  );
  assert.match(
    await retryDetail.getByLabel('执行模型信息').first().innerText(),
    /实际请求 · sihq-test\/deep/,
  );
  await priorArticle.getByText('查看实际委派输入', { exact: true }).click();
  assert.ok(
    (await priorArticle.locator('[data-sihq-input]').textContent()).includes('SMOKE_REASSIGN'),
  );
  assert.ok((await priorArticle.innerText()).includes('Smoke 快读'));
  pass(
    'Reassigned only the failed attempt after confirmation. The host actually switched from quick/low to deep/high, retained the former input and left the template route intact.',
    resumed.id,
  );

  await verifyProgressAbort(page, retryDetail, button);
  pass(
    'Leaving run details aborted the in-flight incremental progress response from the real DSH endpoint.',
  );
  const script = join(checkout, 'verify-smoke.cjs');
  for (const code of [0, 7]) {
    const stamp = 'SMOKE_VERIFICATION_' + code;
    writeFileSync(
      script,
      'console.log(' +
        JSON.stringify(stamp) +
        " + ' ' + process.cwd());\nconsole.error('diagnostic marker');\nprocess.exitCode = " +
        code +
        ';\n',
    );
    const task = 'Verify real process ' + code + ' ' + Date.now();
    const before = models().filter((e) => e.structured).length;
    const dialog = await pick(verifyFlowName);
    assert.ok((await dialog.innerText()).includes('verify-smoke.cjs'));
    await submit(dialog, task);
    const result = await state(
      task,
      (f) => f.status !== 'running' && f.steps.length > 0 && !!f.steps[0].report,
      'native exit code ' + code,
    );
    const report = result.steps[0].report;
    if (
      code === 0 &&
      report.exitCode === null &&
      /sandbox-local: windows-acl/.test(report.stderr)
    ) {
      await command('/smoke-native-shell');
      const probe = join(run, 'native-shell.json');
      await waitForValue(() => existsSync(probe), 'DSH native shell diagnostic');
      const native = JSON.parse(readFileSync(probe, 'utf8'));
      assert.ok(JSON.stringify(native.result).includes('SetNamedSecurityInfoW'));
      pass(
        'The same Windows ACL error occurred in a direct DSH shell control, before the command ran.',
        native.call.name,
      );
    }
    assert.equal(report.outcome, code === 0 ? 'passed' : 'failed', JSON.stringify(report));
    assert.equal(report.exitCode, code);
    assert.equal(result.status, code === 0 ? 'completed' : 'failed');
    assert.ok(report.stderr.includes('diagnostic marker'));
    assert.equal(resolve(report.cwd), resolve(checkout));
    assert.deepEqual(report.argv, ['node', 'verify-smoke.cjs']);
    assert.ok(
      report.stdout.includes(stamp) && report.stdout.toLowerCase().includes(checkout.toLowerCase()),
    );
    assert.equal(models().filter((e) => e.structured).length, before);
    const commandDetail = await historyDetail(task);
    await commandDetail.getByText('运行本地命令 · 退出码 ' + code, { exact: true }).waitFor();
    await commandDetail.locator('summary').filter({ hasText: '运行本地命令' }).first().click();
    const reportUI = commandDetail.getByLabel('命令验证结果');
    await reportUI.waitFor();
    assert.ok((await reportUI.innerText()).includes(stamp));
    if (code === 7) {
      writeFileSync(script, "console.log('retry passed');");
      await button('重试：运行本地命令', commandDetail).click();
      const retried = await finished(task);
      assert.deepEqual(
        retried.steps.map((step) => step.report.exitCode),
        [7, 0],
      );
      pass(
        'The visible retry command selected the failed verification and kept both attempts.',
        retried.id,
      );
    }
    pass(
      'DSH ran the local verification command in the selected checkout and displayed real exit code ' +
        code +
        ' and output, using zero Agent calls.',
      result.id,
    );
  }
  writeFileSync(
    join(checkout, 'repair-smoke.cjs'),
    [
      "const fs=require('node:fs');",
      "if (!fs.existsSync('repair-smoke.marker')) {",
      "  console.error('first test failed'); process.exitCode=7;",
      "} else console.log('retest passed');",
    ].join('\n'),
  );
  const repairTask = 'Verify configured repair loop ' + Date.now();
  await submit(await pick(verifyRepairName), repairTask);
  const repaired = await state(
    repairTask,
    (f) => f.status !== 'running',
    'verification repair and retest',
  );
  assert.equal(repaired.status, 'completed', repaired.error);
  assert.equal(repaired.repairCount, 1);
  assert.deepEqual(
    repaired.steps.map((s) => s.node),
    ['writer', 'unit', 'writer', 'unit'],
  );
  assert.match(inputFor(repaired.steps[2]), /验证失败报告[\s\S]*first test failed/);
  assert.deepEqual(
    repaired.steps.filter((s) => s.stage === 'verify').map((s) => s.report.exitCode),
    [7, 0],
  );
  pass(
    'Configured verification return in Settings, delivered stderr to the developer and retested successfully.',
    repaired.id,
  );
}
