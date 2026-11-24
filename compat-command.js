import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./dist/dsh-compat-cli.js', import.meta.url));
export const commandHelp = [
  '/sihq · 选择工作流  /sihq run "流程名" "任务"',
  '/sihq workflow "开发需求" [--max-repairs 0|1|2]',
  '/sihq workflow templates  ·  workflow --template <模板 ID> "需求"',
  '/sihq workflow list|status|resume|retry …',
  '/sihq workflow continue <流程 ID> [--inherit-reports] "新任务"（内置开发流程可选择继承各角色报告）',
  '/sihq workflow reassign <流程 ID> <失败尝试 ID> <目标命名实例 ID> --confirm',
  '/sihq workflow return <流程 ID> <确认 ID> <目标步骤 ID> "退回理由"',
  '输入 /sihq 选择「本会话运行记录」，可查看历史报告或处理等待中的人工确认。',
  '/sihq providers  ·  角色设置位于「插件 → dsh-sihq」',
  '/sihq run|plan "任务"  ·  implement|review <id>  ·  resume <id> "指令"',
  '/sihq list  ·  chat list  ·  kernel --help',
  '带空格的参数请加双引号，也可以输入 JSON 字符串数组。',
].join('\n');

export function argumentsOf(input) {
  if (input.startsWith('[')) {
    const args = JSON.parse(input);
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))
      throw new Error('参数必须是字符串数组');
    return args;
  }
  const args = [];
  const tokens = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?=\s|$)/gy;
  let match;
  while (tokens.lastIndex < input.length) {
    match = tokens.exec(input);
    if (!match) throw new Error('参数引号不匹配，可改用 JSON 数组');
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

export async function executeCompatCommand(parsed, args, cwd, signal) {
  if (parsed.kind === 'interactive' || (parsed.kind === 'chat' && parsed.action !== 'list'))
    throw new Error('交互式对话请在终端使用 sihq chat。\n' + commandHelp);
  if (args[0] === 'kernel' && (args[1] === 'worker' || args.includes('--follow')))
    throw new Error('请使用 kernel logs <id> 查看日志');
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_NO_WARNINGS: '1',
      },
      signal,
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-64000);
      });
    }
    child.once('error', reject);
    child.once('close', (code, reason) =>
      resolve({
        kind: code === 0 ? 'success' : 'error',
        text: output.trim() || (code === 0 ? '已完成' : '进程退出 ' + (reason ?? code)),
      }),
    );
  });
}
