import { agentName } from '../dist/workflow/rules.js';
import { createTaskDialog } from './launch-dialog.js';
import { installRunSidebar } from './run-sidebar.js';
import { ApprovalReturn } from './approval-return.js';
import { StepReport, stateName } from './run-reports.js';
import { Reassignment } from './reassignment.js';
import { Expandable, button, h, panelStyle, preStyle } from './ui.js';
import React from 'react';

export function installRunHistory(ctx, call) {
  const taskDialog = createTaskDialog();
  const openSidebar = installRunSidebar(ctx, call, History, RunDetail);
  const receipts = new Map();
  const listeners = new Set();
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  function showReceipt(sessionId, result) {
    if (result) {
      receipts.delete(sessionId);
      receipts.set(sessionId, result);
      if (receipts.size > 64) receipts.delete(receipts.keys().next().value);
    } else receipts.delete(sessionId);
    for (const fn of listeners) fn();
  }
  const historyOption = '$sihq-history';
  const savedOptionPrefix = 'saved:';
  /** @type {import("react").CSSProperties} */
  const receiptStyle = {
    padding: 10,
    border: '1px solid GrayText',
    borderRadius: 8,
    color: 'CanvasText',
    background: 'Canvas',
    maxHeight: '48vh',
    minWidth: 0,
    overflow: 'auto',
    overscrollBehavior: 'contain',
    overflowWrap: 'anywhere',
  };
  // The chat command UI emits a separate event for commands entered in the composer.
  const managedCommands = new Set();
  async function dispatch(sessionId, args) {
    if (managedCommands.has(sessionId)) throw new Error('当前会话正在提交指令。');
    managedCommands.add(sessionId);
    try {
      let response;
      try {
        response = await ctx.remote.commands.execute(
          sessionId,
          '/sihq ' + JSON.stringify(args),
          [],
        );
        if (!response.ok) throw new Error(response.error.message);
      } catch (error) {
        throw Object.assign(new Error(error.message), { deliveryUnknown: true });
      }
      const result = response.value?.result;
      if (result?.kind !== 'success') throw new Error(result?.text || '提交失败，请检查当前会话。');
      return result;
    } finally {
      managedCommands.delete(sessionId);
    }
  }
  ctx.on('command/executed', async (sessionId, name, result) => {
    if (name !== 'sihq' || managedCommands.has(sessionId)) return;
    if (result?.kind === 'success' && Number.isSafeInteger(result.sourceEventSeq)) {
      try {
        const receipt = await call('commandReceipt', { sessionId, seq: result.sourceEventSeq });
        if (receipt.flowId) openDetail(sessionId, receipt.flowId, 0, receipt.jobId);
        else showReceipt(sessionId, { ...result, trackingToken: receipt.jobId });
        return;
      } catch {
        /* The command text and the session's history remain available. */
      }
    }
    showReceipt(sessionId, result);
  });
  function history(sessionId, offset = 0) {
    if (openSidebar(sessionId, 'history', { offset })) return showReceipt(sessionId, null);
    showReceipt(sessionId, { view: 'history', offset });
  }
  function openDetail(sessionId, id, returnOffset = 0, jobId = undefined) {
    if (openSidebar(sessionId, id, { offset: returnOffset, ...(jobId && { jobId }) }))
      return showReceipt(sessionId, null);
    showReceipt(sessionId, { view: 'detail', flowId: id, returnOffset, jobId });
  }
  function History({
    sessionId,
    initialOffset,
    select = (id, offset) => openDetail(sessionId, id, offset),
  }) {
    const [offset, setOffset] = React.useState(initialOffset);
    const [revision, refresh] = React.useReducer((n) => n + 1, 0);
    const [result, setResult] = React.useState(null);
    React.useEffect(() => {
      let active = true;
      setResult(null);
      call('runHistory', { sessionId, offset, limit: 10 })
        .then((data) => {
          if (active) setResult(data);
        })
        .catch((e) => {
          if (active) setResult({ error: e.message });
        });
      return () => {
        active = false;
      };
    }, [sessionId, offset, revision]);
    return h(
      'div',
      { 'aria-label': '本会话运行记录' },
      h('strong', null, '本会话运行记录'),
      ' ',
      button('刷新记录', refresh),
      !result && h('p', { role: 'status' }, '正在读取…'),
      result?.error && h('p', { role: 'alert' }, result.error),
      result?.partial && h('p', { role: 'status' }, '部分历史记录暂时无法读取，可稍后刷新。'),
      !result?.partial && result?.items?.length === 0 && h('p', null, '本会话还没有运行记录。'),
      result?.items?.map((item) =>
        h(
          'article',
          { key: item.id, style: panelStyle },
          h('strong', null, item.templateName || 'SiliconHQ 开发流程'),
          h(
            'span',
            null,
            stateName(item.status) + ' · ' + new Date(item.updatedAt).toLocaleString(),
          ),
          h('span', null, item.prompt),
          h(
            'div',
            null,
            button('查看详情', () => select(item.id, offset)),
          ),
        ),
      ),
      offset > 0 && button('上一页', () => setOffset(Math.max(0, offset - 10))),
      result?.nextOffset != null && button('下一页', () => setOffset(result.nextOffset)),
    );
  }
  // Expandable mounts this component only while a step is open. Discard late
  // responses if the user closes it, changes rounds or retries that step.
  function LoadStepReport({ sessionId, id, round, index }) {
    const [step, setStep] = React.useState(null);
    const [error, setError] = React.useState('');
    const [attempt, retry] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => {
      let current = true;
      setError('');
      call('runStep', { sessionId, id, round, index })
        .then((value) => {
          if (current) setStep(value);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
      return () => {
        current = false;
      };
    }, [sessionId, id, round, index, attempt]);
    if (error) return h('div', { role: 'alert' }, error, ' ', button('重新读取此步骤', retry));
    return step ? h(StepReport, { step }) : h('p', { role: 'status' }, '正在读取步骤详情…');
  }
  function ApprovalContext({ sessionId, id, round, approvalId }) {
    const [context, setContext] = React.useState(null);
    const [error, setError] = React.useState('');
    const [attempt, retry] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => {
      let active = true;
      setError('');
      call('runApprovalContext', { sessionId, id, round, approvalId })
        .then((result) => {
          if (active) setContext(result);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
      return () => {
        active = false;
      };
    }, [sessionId, id, round, approvalId, attempt]);
    if (error) return h('p', { role: 'alert' }, error, ' ', button('重新读取', retry));
    if (!context) return h('p', { role: 'status' }, '正在读取本轮任务…');
    return h(
      React.Fragment,
      null,
      h('pre', { style: preStyle, 'aria-label': '本轮完整任务' }, context.prompt),
      context.sources?.length
        ? context.sources.map((source) =>
            h(
              Expandable,
              { key: source.id, summary: source.label },
              h('pre', { style: preStyle }, source.text),
            ),
          )
        : h('small', null, context.sources ? '本轮没有选取引用。' : '本轮记录没有保存引用快照。'),
    );
  }
  function RunDetail({
    sessionId,
    id,
    jobId,
    returnOffset,
    selectedRound = undefined,
    onRoundChange = undefined,
    back = () => history(sessionId, returnOffset),
  }) {
    const [localRound, setRound] = React.useState('');
    const round = selectedRound ?? localRound;
    const gatePanel = React.useRef(null);
    const [detail, setDetail] = React.useState(null);
    const [error, setError] = React.useState('');
    const [refreshNumber, refresh] = React.useReducer((n) => n + 1, 0);
    const [busy, setBusy] = React.useState(false);
    const [note, setNote] = React.useState('');
    const [actionMessage, setActionMessage] = React.useState('');
    React.useEffect(() => {
      let active = true,
        timer,
        revision,
        stopping = false;
      const controller = new AbortController();
      async function read() {
        try {
          /** @type {import('../dist/storage/workflow-progress.js').RunProgressQuery} */
          const query = {
            sessionId,
            id,
            ...(round && { round: Number(round) }),
            ...(revision !== undefined && { revision }),
          };
          const data = await call('runProgress', query, controller.signal);
          if (!active) return;
          revision = data.revision;
          if (!data.unchanged) {
            setDetail(data);
            stopping = data.steps.some((step) => step.stoppingJobId);
          }
          setError('');
          if (
            !round &&
            !data.interrupted &&
            !data.lockError &&
            (stopping || ['running', 'waiting_approval'].includes(data.status))
          )
            timer = setTimeout(read, data.status === 'running' ? 1800 : 5000);
        } catch (e) {
          if (active) setError(e.message);
        }
      }
      read();
      return () => {
        active = false;
        controller.abort();
        clearTimeout(timer);
      };
    }, [sessionId, id, round, refreshNumber]);
    const gate = detail?.pendingApproval;
    React.useEffect(() => {
      setNote('');
    }, [gate?.id]);
    async function action(verb, target = '') {
      setBusy(true);
      setActionMessage('');
      try {
        const args = ['workflow', verb, id];
        if (verb === 'retry' || verb === 'resume') {
          if (!detail?.recovery?.token) throw new Error('请刷新运行详情，再操作当前步骤。');
          args.push('--if-current', detail.recovery.token);
        }
        if (['approve', 'reject', 'return'].includes(verb)) {
          if (!gate) throw new Error('请刷新运行详情后再确认。');
          args.push(gate.id);
          if (verb === 'return') args.push(target);
          if (note.trim()) args.push(note.trim());
        }
        const result = await dispatch(sessionId, args);
        setActionMessage(result.text);
      } catch (e) {
        setActionMessage(e.message);
      } finally {
        setBusy(false);
        refresh();
      }
    }
    async function reassign(executionId, instance) {
      setBusy(true);
      setActionMessage('');
      try {
        const args = ['workflow', 'reassign', id, executionId, instance.id, '--confirm'];
        if (instance.revision) args.push(instance.revision);
        const result = await dispatch(sessionId, args);
        setActionMessage(result.text);
      } catch (error) {
        setActionMessage(error.message);
      } finally {
        setBusy(false);
        refresh();
      }
    }
    const current = !round;
    const retryNames = detail?.recovery?.attempts?.map((step) => step.name) ?? [];
    const reassignable =
      detail?.steps.filter((step) => detail.reassignable?.includes(step.executionId)) ?? [];
    return h(
      'section',
      {
        'aria-label': 'SiliconHQ 运行详情',
        style: { display: 'grid', gap: 6 },
      },
      h('div', null, button('返回运行记录', back), ' ', button('刷新详情', refresh, busy)),
      error && h('p', { role: 'alert' }, error),
      !detail && !error && h('p', { role: 'status' }, '正在读取运行详情…'),
      detail &&
        h(
          React.Fragment,
          null,
          h(
            'strong',
            null,
            detail.name +
              ' · ' +
              (detail.interrupted ? '运行中断，可恢复' : stateName(detail.status)),
          ),
          gate && current
            ? button(
                '处理审批 · ' + gate.name,
                () => {
                  gatePanel.current?.focus({ preventScroll: true });
                  gatePanel.current?.scrollIntoView({ block: 'start' });
                },
                busy,
                { variant: 'primary', style: { justifySelf: 'start' } },
              )
            : detail.status === 'running' &&
                !detail.interrupted &&
                detail.steps
                  .filter((s) => s.status === 'running')
                  .map((step, i) =>
                    h(
                      'span',
                      { key: step.executionId ?? i },
                      [
                        step.waitingForCapacity ? '等待名额' : '正在执行',
                        step.name,
                        step.instanceName || (step.provider && agentName(step.provider)),
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  ),
          detail.steps
            .filter(
              (s) =>
                s.kind === 'verify' &&
                s.exitCode !== undefined &&
                !s.supersededByApproval &&
                !s.supersededByRepair,
            )
            .map((step, i) =>
              h(
                'small',
                { key: step.executionId ?? i },
                step.name +
                  ' · ' +
                  (step.exitCode === null ? '未取得退出码' : '退出码 ' + step.exitCode),
              ),
            ),
          h('span', null, detail.prompt),
          h('small', null, detail.cwd + ' · ' + detail.id),
          jobId && h('small', null, 'DSH 后台任务 ' + jobId),
          detail.latestRound > 1 &&
            h(
              'label',
              null,
              '轮次 ',
              h(
                'select',
                {
                  value: round,
                  onChange: (e) => {
                    if (onRoundChange) {
                      onRoundChange(e.target.value);
                      return;
                    }
                    setRound(e.target.value);
                    setDetail(null);
                    setActionMessage('');
                    setError('');
                  },
                },
                h('option', { value: '' }, '最新 · 第 ' + detail.latestRound + ' 轮'),
                detail.rounds
                  .filter((r) => r.round !== detail.latestRound)
                  .map((r) =>
                    h('option', { key: r.round, value: r.round }, '第 ' + r.round + ' 轮'),
                  ),
              ),
            ),
          detail.error && h('p', { role: 'alert' }, detail.error),
          detail.lockError && h('p', { role: 'alert' }, detail.lockError),
          detail.interrupted && h('p', { role: 'status' }, '上次执行已中断，可从已有记录恢复。'),
          detail.steps.map((step, index) =>
            h(
              'div',
              { key: [detail.round, index, step.executionId || step.runId].join('/') },
              h(
                Expandable,
                {
                  style: panelStyle,
                  summary: [
                    step.name,
                    step.instanceName,
                    step.kind === 'verify'
                      ? '项目验证命令'
                      : step.provider && agentName(step.provider),
                    step.modelProvider,
                    step.model,
                    step.reasoningEffort,
                    step.waitingForCapacity ? '等待执行名额' : stateName(step.status),
                  ]
                    .filter(Boolean)
                    .join(' · '),
                },
                h(LoadStepReport, {
                  key: [step.status, step.finishedAt, step.waitingForCapacity, refreshNumber].join(
                    '/',
                  ),
                  sessionId,
                  id,
                  round: detail.round,
                  index,
                }),
              ),
              step.skipReason && h('p', null, '跳过原因 · ' + step.skipReason),
              (step.supersededByApproval || step.supersededByRepair) &&
                h('small', null, '退回前的历史记录'),
              step.stoppingJobId &&
                h(
                  'p',
                  { role: 'status' },
                  '等待确认验证命令已停止 · ' +
                    step.stoppingJobId +
                    '。确认前，同一工作区的写入和重试会被阻止。',
                ),
              step.suggestionCount > 0 &&
                h('small', null, '后续建议 ' + step.suggestionCount + ' 项 · 展开步骤查看'),
              step.blockingCount > 0 && h('small', null, '阻塞项 ' + step.blockingCount + ' 项'),
              step.summary && h('p', { style: preStyle }, step.summary),
            ),
          ),
          current &&
            gate &&
            h(
              'fieldset',
              { disabled: busy, ref: gatePanel, tabIndex: -1 },
              h('legend', null, gate.name + ' · 等待人工确认'),
              h('p', { style: preStyle }, gate.instructions),
              h(
                Expandable,
                { key: gate.id, summary: '查看完整任务和本轮引用' },
                h(ApprovalContext, { sessionId, id, round: detail.round, approvalId: gate.id }),
              ),
              gate.inputs?.map((node) => {
                const index = detail.steps.findLastIndex((step) => step.id === node);
                const source = detail.steps[index];
                if (!source) return h('small', { key: node }, '没有可核对的上游步骤记录：' + node);
                if (source.status === 'skipped')
                  return h('small', { key: node }, source.name + ' · 已跳过，本轮没有报告。');
                return h(
                  Expandable,
                  { key: node, summary: '核对上游报告 · ' + source.name },
                  h(LoadStepReport, { sessionId, id, round: detail.round, index }),
                );
              }),
              h(
                'label',
                { style: { display: 'grid' } },
                '决定说明（可选）',
                h('textarea', {
                  value: note,
                  onChange: (e) => setNote(e.target.value),
                }),
              ),
              button('继续运行（批准）', () => action('approve'), busy),
              ' ',
              button('拒绝继续', () => action('reject'), busy),
              h(ApprovalReturn, {
                key: gate.id,
                targets: gate.returnTargets,
                remaining: detail.maxRepairs - detail.repairCount,
                busy,
                note,
                submit: (target) => action('return', target),
              }),
            ),
          current && detail.canResume && !gate && button('恢复运行', () => action('resume'), busy),
          current &&
            detail.canRetry &&
            !gate &&
            button(
              retryNames.length ? '重试：' + retryNames.join('、') : '重试当前阶段',
              () => action('retry'),
              busy,
            ),
          current &&
            !gate &&
            reassignable.length > 0 &&
            h(Reassignment, {
              key: reassignable.map((step) => step.executionId).join('/'),
              candidates: reassignable,
              call,
              sessionId,
              id,
              busy,
              submit: reassign,
            }),
          current &&
            detail.canContinue &&
            button(
              '继续下一轮',
              async () => {
                setBusy(true);
                setActionMessage('');
                try {
                  await beginNextRound(sessionId, id);
                } catch (e) {
                  setActionMessage(e.message);
                } finally {
                  setBusy(false);
                  refresh();
                }
              },
              busy,
            ),
          actionMessage && h('pre', { role: 'status', style: preStyle }, actionMessage),
        ),
    );
  }
  async function beginNextRound(sessionId, id) {
    const prepare = (replaces = undefined) =>
      call('prepareContinuation', { sessionId, id, replaces });
    openLaunchDialog(sessionId, await prepare(), true, prepare);
  }
  function openLaunchDialog(sessionId, initialPlan, continuation, prepare) {
    const scope = ctx.sessions.scope(sessionId);
    if (!scope) throw new Error('会话已关闭，请返回工作区。');
    function bind(plan) {
      const loadSources = (includeDiff, id) =>
        id
          ? call('contextReference', { sessionId, token: plan.token, id })
          : call('contextSources', { sessionId, token: plan.token, includeDiff, compact: true });
      const documents = (request, signal) =>
        call('projectDocuments', { sessionId, token: plan.token, ...request }, signal);
      async function submit(prompt, ids, inheritReports) {
        let deliveryError, result;
        try {
          result = await dispatch(sessionId, [
            'launch',
            plan.token,
            prompt,
            JSON.stringify(ids),
            ...(inheritReports ? ['--inherit-reports'] : []),
          ]);
        } catch (error) {
          if (!error.deliveryUnknown) throw error;
          deliveryError = error;
        }
        let receipt;
        try {
          receipt = await call('launchReceipt', { sessionId, token: plan.token });
        } catch {
          // An accepted run is also accessible from this session's history.
        }
        if (deliveryError && !receipt?.jobId && !receipt?.flowId) throw deliveryError;
        const view = launchView(
          result ?? { kind: 'success', text: '已收到后台任务回执' },
          receipt ?? {},
        );
        if (receipt?.jobId && !receipt.flowId && !receipt.error) view.trackingToken = plan.token;
        if (view.flowId) openDetail(sessionId, view.flowId, 0, view.jobId);
        else showReceipt(sessionId, view);
      }
      return { plan, loadSources, submit, documents };
    }
    taskDialog(
      scope,
      bind(initialPlan),
      continuation,
      async (previousToken) => bind(await prepare(previousToken)),
      () => history(sessionId),
    );
  }
  function launchView(result, receipt) {
    if (receipt.flowId) return { ...result, ...receipt, view: 'detail' };
    if (receipt.error)
      return {
        kind: 'error',
        text: ['提交失败', receipt.error, receipt.jobId && 'DSH 后台任务 ' + receipt.jobId]
          .filter(Boolean)
          .join('\n'),
      };
    return { ...result, ...receipt };
  }
  function Receipt({ sessionId }) {
    const result = React.useSyncExternalStore(subscribe, () => receipts.get(sessionId));
    // Jobs can acknowledge a launch before the first flow checkpoint exists.
    React.useEffect(() => {
      if (!result?.trackingToken) return;
      const { trackingToken, ...accepted } = result;
      let active = true,
        timer = setTimeout(poll, 2000);
      async function poll() {
        try {
          const receipt = await call('launchReceipt', {
            sessionId,
            token: trackingToken,
          });
          if (!active) return;
          if (receipt.flowId) openDetail(sessionId, receipt.flowId, 0, receipt.jobId);
          else if (receipt.error) showReceipt(sessionId, launchView(accepted, receipt));
          else timer = setTimeout(poll, 2000);
        } catch (e) {
          if (active)
            showReceipt(sessionId, {
              ...accepted,
              text: accepted.text + '\n' + e.message,
            });
        }
      }
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [sessionId, result]);
    if (!result) return null;
    const flowId = result.flowId;
    return h(
      'section',
      { 'aria-label': 'SiliconHQ 执行结果', style: receiptStyle },
      result.view === 'history'
        ? h(History, {
            key: sessionId,
            sessionId,
            initialOffset: result.offset ?? 0,
          })
        : result.view === 'detail' && flowId
          ? h(RunDetail, {
              key: sessionId + flowId,
              sessionId,
              id: flowId,
              jobId: result.jobId,
              returnOffset: result.returnOffset,
            })
          : h(
              React.Fragment,
              null,
              h(
                'pre',
                {
                  role: result.kind === 'error' ? 'alert' : 'status',
                  style: preStyle,
                },
                result.text,
              ),
              result.trackingToken && h('small', null, '等待后台任务创建流程记录…'),
              flowId && button('查看流程状态', () => openDetail(sessionId, flowId)),
              ' ',
              button('本会话运行记录', () => history(sessionId)),
            ),
      ' ',
      button('收起回执', () => showReceipt(sessionId, null)),
    );
  }
  // The dock participates in the composer stack. The overlay slot is only an
  // anchor for popups and doesn't reserve space for a persistent report.
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'sihq-receipt',
        order: 30,
        inject: (sessionId) => ({ sessionId }),
      },
      Receipt,
    ),
  );
  return { historyOption, savedOptionPrefix, history, openLaunchDialog };
}
