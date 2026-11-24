import React from 'react';
import { button, h } from './ui.js';

const kind = 'sihq-run';
const prefix = 'dsh-resource://sihq-run/';
const flowAddress = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/([1-9]\d*))?$/i;

export function installRunSidebar(ctx, call, History, RunDetail) {
  let navigation;

  function LatestRun({ sessionId, actions }) {
    const [state, setState] = React.useState('正在读取当前工作流…');
    const [attempt, retry] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => {
      const controller = new AbortController();
      call('runHistory', { sessionId, offset: 0, limit: 1 }, controller.signal)
        .then(({ items }) => {
          if (controller.signal.aborted) return;
          if (items.length) actions.openResource(prefix + items[0].id, { kind, replaceTab: true });
          else setState('本会话还没有运行记录。在聊天中输入 /sihq 可启动工作流。');
        })
        .catch((e) => {
          if (!controller.signal.aborted) setState(e.message);
        });
      return () => controller.abort();
    }, [sessionId, actions, attempt]);
    return h('div', null, h('p', { role: 'status' }, state), button('刷新记录', retry));
  }

  function Body({ sessionId, useTabInfo }) {
    const { tab } = useTabInfo();
    if (!tab.visible) return null;
    const target = tab.contentId.startsWith(prefix) ? tab.contentId.slice(prefix.length) : '';
    const params = tab.navigation?.params ?? {};
    const offset = Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
    const match = target.match(flowAddress);
    const open = (path, offset = 0) =>
      tab.actions.openResource(prefix + path, { kind, replaceTab: true, params: { offset } });
    return h(
      'section',
      {
        'aria-label': '当前工作流侧栏',
        style: {
          height: '100%',
          boxSizing: 'border-box',
          overflow: 'auto',
          padding: 14,
          overflowWrap: 'anywhere',
        },
      },
      target === 'history'
        ? h(History, {
            key: sessionId + ':' + offset,
            sessionId,
            initialOffset: offset,
            select: (id, page) => open(id, page),
          })
        : match
          ? h(RunDetail, {
              key: sessionId + ':' + target,
              sessionId,
              id: match[1],
              selectedRound: match[2] ?? '',
              jobId: params.jobId,
              returnOffset: offset,
              onRoundChange: (round) => open(match[1] + (round ? '/' + round : ''), offset),
              back: () => open('history', offset),
            })
          : h(LatestRun, { key: sessionId, sessionId, actions: tab.actions }),
    );
  }

  // The chat dock remains usable on profiles without the optional right-hand pane.
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
    scope.effect(() =>
      scope.sidebarRightTabs.register({
        id: 'dsh-sihq',
        kind,
        patterns: [prefix + '**'],
        title: () => '当前工作流',
        guide: [
          {
            id: 'current',
            order: 40,
            title: () => '当前工作流',
            description: () => '查看当前会话的工作流、验证结果和审批。',
          },
        ],
      }),
    );
    scope.slots.inject('sidebar.right.pane.tab', () =>
      scope.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: 'dsh-sihq',
          inject: (sessionId) => ({ sessionId }),
        },
        Body,
      ),
    );
    scope.effect(() => {
      navigation = scope.sidebarRight;
      return () => {
        navigation = undefined;
      };
    });
  });
  return (sessionId, target, params = {}) => {
    if (!navigation || navigation.mounted.getSnapshot() !== sessionId) return false;
    const active = navigation.active();
    navigation.openResource(prefix + target, {
      kind,
      params,
      ...(active?.kind === kind && { replaceTab: active.id }),
    });
    return true;
  };
}
