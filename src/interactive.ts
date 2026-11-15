import { spawn } from "node:child_process";

// argv 前两项是 Node 和入口文件；其余参数原样交给 Codex。
export function startInteractive(): void {
  const child = spawn("codex", process.argv.slice(2), {
    // 共享终端输入、输出和错误输出，由 Codex 绘制原生交互界面。
    stdio: "inherit",
    // 默认继承当前工作目录和环境变量，不经过 shell 解析参数。
    shell: false,
  });

  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  function removeSignalHandlers(): void {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  }

  child.on("error", (error: NodeJS.ErrnoException) => {
    removeSignalHandlers();
    if (error.code === "ENOENT") {
      console.error("llm-coder: 未找到 codex，请先安装 Codex CLI 并确保它在 PATH 中。");
      process.exitCode = 127;
    } else {
      console.error(`llm-coder: 无法启动 Codex：${error.message}`);
      process.exitCode = 1;
    }
  });

  child.on("exit", (code, signal) => {
    removeSignalHandlers();
    if (signal) {
      // 保留被信号终止的语义。
      process.kill(process.pid, signal);
    } else {
      process.exitCode = code ?? 1;
    }
  });
}
