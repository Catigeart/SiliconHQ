import { button, h, panelStyle, preStyle } from './ui.js';

// Preserve empty arguments, whitespace and quotes when displaying the argv sent to the host.
export function displayCommand(argv) {
  return argv
    .map((arg) => (/^[\p{L}\p{N}_.:/@+-]+$/u.test(arg) ? arg : JSON.stringify(arg)))
    .join(' ');
}

export function verificationSummary(step) {
  return step.name + ' · ' + displayCommand(step.argv) + ' · 超时 ' + step.timeoutMs / 1000 + ' 秒';
}

export function VerificationFields({ value, change }) {
  const argv = value?.argv?.length ? value.argv : [''];
  const timeoutMs = value?.timeoutMs ?? 120000;
  const setArgs = (args) => change({ argv: args, timeoutMs });
  const setArg = (index, text) => setArgs(argv.map((arg, i) => (i === index ? text : arg)));
  return h(
    'fieldset',
    { style: panelStyle },
    h('legend', null, '验证命令'),
    h(
      'label',
      null,
      '可执行文件 ',
      h('input', {
        value: argv[0],
        required: true,
        placeholder: '例如 node',
        onChange: (e) => setArg(0, e.target.value),
      }),
    ),
    h('small', null, '每项参数单独传递，含空格的参数可直接填写。'),
    ...argv.slice(1).map((arg, i) =>
      h(
        'div',
        { key: i },
        h(
          'label',
          null,
          '参数 ' + (i + 1) + ' ',
          h('textarea', {
            rows: 1,
            value: arg,
            onChange: (e) => setArg(i + 1, e.target.value),
          }),
        ),
        button('删除参数 ' + (i + 1), () => setArgs(argv.filter((_, index) => index !== i + 1))),
      ),
    ),
    button('添加参数', () => setArgs([...argv, '']), argv.length >= 256),
    h(
      'label',
      null,
      '超时（秒） ',
      h('input', {
        type: 'number',
        value: timeoutMs ? timeoutMs / 1000 : '',
        required: true,
        min: 1,
        max: 3600,
        step: 0.001,
        onChange: (e) => change({ argv, timeoutMs: Math.round(Number(e.target.value) * 1000) }),
      }),
    ),
    h(
      'small',
      null,
      '命令在本次工作目录执行。退出码为 0 表示通过；可为非零退出设置退回目标或处理分支。',
    ),
  );
}

export function VerificationEvidence({ report }) {
  return h(
    'section',
    { 'aria-label': '命令验证结果', style: panelStyle },
    h('strong', null, report.outcome === 'passed' ? '命令验证通过' : '命令验证未通过'),
    h('div', null, '工作目录 · ', h('code', null, report.cwd)),
    h('div', null, '程序与参数 · ', h('code', null, displayCommand(report.argv))),
    h(
      'div',
      null,
      report.exitCode == null ? '未取得退出码' : '退出码 · ' + report.exitCode,
      report.durationMs != null && ' · 耗时 ' + report.durationMs / 1000 + ' 秒',
    ),
    report.hostErrorCode && h('div', null, '宿主错误码 · ', h('code', null, report.hostErrorCode)),
    report.timedOut && h('div', null, '命令已超时。'),
    report.cancelled && h('div', null, '命令已取消。'),
    (report.reason || report.summary) && h('div', null, report.reason || report.summary),
    report.stdout &&
      h('div', null, h('strong', null, '标准输出'), h('pre', { style: preStyle }, report.stdout)),
    report.stderr &&
      h('div', null, h('strong', null, '标准错误'), h('pre', { style: preStyle }, report.stderr)),
    report.stdoutTruncated && h('small', null, '标准输出已截断。'),
    report.stderrTruncated && h('small', null, '标准错误已截断。'),
  );
}
