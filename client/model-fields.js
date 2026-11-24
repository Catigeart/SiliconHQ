import { agentName, backendKey } from '../dist/workflow/rules.js';
import { h } from './ui.js';
import { instanceSummary } from './workflow-model.js';
import React from 'react';

export function ProviderPicker({ value, set, providers, readOnly, title = '执行者' }) {
  value = backendKey(value);
  const active = providers.some((p) => p.name === value);
  return h(
    'label',
    { style: { display: 'grid', gap: 4 } },
    title,
    h(
      'select',
      { value, onChange: (e) => set(e.target.value) },
      !active && h('option', { value, disabled: true }, value + '（尚未检测到）'),
      providers.map((p) => {
        const usable = readOnly ? p.read : p.develop;
        const detail =
          p.registered === false
            ? '未注册'
            : usable
              ? readOnly
                ? '只读'
                : '开发'
              : readOnly
                ? p.readRestriction || '无法强制只读'
                : p.restriction || '仅支持只读';
        return h(
          'option',
          { key: p.name, value: p.name, disabled: !usable },
          (p.instance ? '实例 · ' + p.instance.name : agentName(p.name)) + ' · ' + detail,
        );
      }),
    ),
  );
}

// One request per selected route. A response from a previous selection is never displayed.
function useChoices(load, backend, provider, model, enabled, productCatalog = false) {
  const [result, setResult] = React.useState(null);
  const key = JSON.stringify([backend, provider, model, productCatalog]);
  React.useEffect(() => {
    if (!enabled) return;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      load({ backend, provider, model, productCatalog })
        .then((data) => {
          if (current === generation) setResult({ key, ...data });
        })
        .catch((err) => {
          if (current === generation) setResult({ key, error: err.message });
        });
    };
    const unsubscribe = !productCatalog ? load.subscribe?.(refresh) : undefined;
    refresh();
    return () => {
      generation++;
      unsubscribe?.();
    };
  }, [load, key, enabled]);
  return enabled && result?.key === key ? result : {};
}

function Choice({
  label,
  value = '',
  choices = [],
  onChange,
  manual = false,
  disabled = false,
  hint = '沿用默认设置',
}) {
  const [typing, setTyping] = React.useState(false);
  const custom = typing || (!!value && !choices.some((c) => c.id === value));
  return h(
    'label',
    { style: { display: 'grid', gap: 3 } },
    label,
    h(
      'select',
      {
        value: custom ? '$custom' : value,
        disabled: disabled && !value,
        onChange: (e) => {
          if (e.target.value === '$custom') {
            setTyping(true);
            return;
          }
          setTyping(false);
          onChange(e.target.value);
        },
      },
      h('option', { value: '' }, hint),
      choices.map((c) => h('option', { key: c.id, value: c.id }, c.name || c.id)),
      (manual || custom) &&
        h('option', { value: '$custom' }, manual ? '手动输入 ID' : '已配置：' + value),
    ),
    custom &&
      manual &&
      h('input', {
        value,
        onChange: (e) => onChange(e.target.value),
        placeholder: label + ' ID',
      }),
  );
}

export function ModelFields({
  backend,
  providers,
  provider = '',
  model = '',
  reasoningEffort = '',
  instanceEditor = false,
  patch,
  load,
}) {
  backend = backendKey(backend);
  const base = providers.find((p) => p.name === backend);
  const product = instanceEditor && base?.product;
  const canSet = !base?.instance && !!(base?.modelOverride || product);
  const cli = backend === 'sihq-codex-readonly' || !!product;
  const available = useChoices(load, backend, undefined, undefined, canSet, cli);
  const defaults = base?.routeDefaults;
  const effectiveProvider = provider || defaults?.provider;
  const effectiveModel = model || defaults?.model;
  const models = useChoices(
    load,
    backend,
    effectiveProvider,
    undefined,
    canSet && !cli && !!effectiveProvider,
  );
  const route = useChoices(
    load,
    backend,
    effectiveProvider,
    effectiveModel,
    canSet && !cli && !!effectiveProvider && !!effectiveModel,
  );
  if (base?.instance) return h('small', null, '实例设置：' + instanceSummary(base.instance));
  if (!canSet)
    return h(
      'small',
      null,
      '模型和思考强度沿用执行者「' + backend + '」的实例配置。',
      (provider || model || reasoningEffort) &&
        h(
          'button',
          {
            type: 'button',
            onClick: () => patch({ provider: '', model: '', reasoningEffort: '' }),
          },
          '清除原有模型覆盖',
        ),
    );
  const choices = cli ? available.models : models.models;
  const efforts =
    product === 'claude-code' && model
      ? available.efforts
      : cli
        ? choices?.find((c) => c.id === model)?.efforts
        : route.efforts;
  const error = available.error || models.error || route.error;
  return h(
    React.Fragment,
    null,
    !cli &&
      h(Choice, {
        label: '模型供应商',
        value: provider,
        choices: available.providers,
        hint: defaults ? '后端默认 · ' + defaults.provider : undefined,
        manual: true,
        onChange: (v) => patch({ provider: v, model: '', reasoningEffort: '' }),
      }),
    h(Choice, {
      key: backend + ':' + provider,
      label: '模型',
      value: model,
      hint: defaults ? '后端默认 · ' + defaults.model : undefined,
      choices,
      manual: true,
      onChange: (v) => patch({ model: v, reasoningEffort: '' }),
    }),
    h(Choice, {
      key: backend + ':' + provider + ':' + model,
      label: '思考强度',
      value: reasoningEffort,
      choices: efforts,
      disabled:
        !effectiveModel ||
        (!available.manual && !efforts?.length && !reasoningEffort && !(cli && model && !efforts)),
      manual: (!!available.manual || cli) && !!model && !efforts,
      hint: efforts?.length
        ? '沿用默认强度'
        : effectiveModel && efforts
          ? '该模型未提供可选强度'
          : '选择具体模型后可设置',
      onChange: (v) => patch({ reasoningEffort: v }),
    }),
    available.manual && h('small', null, '此后端管理自己的模型。可手填 ID，并用实际委派验证。'),
    product === 'claude-code' &&
      h('small', null, '可输入完整模型 ID。可用强度取决于 Claude 模型及账户。'),
    !error &&
      (available.partial || models.partial) &&
      h('small', { role: 'status' }, '部分 DSH 模型供应商暂时不可用。'),
    error && h('small', { role: 'status' }, '读取模型目录失败：' + error),
  );
}
