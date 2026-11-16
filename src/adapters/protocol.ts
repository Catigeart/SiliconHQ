import { fault } from '../runtime/faults.js';

export const testedCodexProtocol = '0.169';
export function assertCodexProtocol(userAgent: unknown): void {
  const version =
    typeof userAgent === 'string'
      ? /codex[^/\s]*\/(\d+\.\d+)\.\d+/.exec(userAgent)?.[1]
      : undefined;
  if (version !== testedCodexProtocol && process.env.SIHQ_ALLOW_UNTESTED_CODEX !== '1')
    throw fault(
      'configuration',
      'PROTOCOL_VERSION',
      `Codex 协议版本未验证：${String(userAgent)}；当前验证版本 ${testedCodexProtocol}.x。升级适配测试后再使用；显式兼容试验可设置 SIHQ_ALLOW_UNTESTED_CODEX=1。`,
    );
}
