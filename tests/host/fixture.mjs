import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { LlmAdapter } = await import(pathToFileURL(process.env.SIHQ_TEST_LLM_MODULE).href);
export const inject = [
  'llm',
  'workspaceRegistry',
  'commands',
  'workingDirectory',
  'systemPrompt',
  'tools',
];

class LocalAdapter extends LlmAdapter {
  async listModels(provider) {
    return ['quick', 'deep', 'revised'].map((id) => ({ provider, id, name: id }));
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: ['low', 'high'].map((id) => ({ id, name: id })) },
    };
  }

  async *stream(request) {
    const input = JSON.stringify(request.messages);
    const schema = request.tools?.find((tool) => tool.name === 'structured_output')?.parameters;
    const tag = input.match(/SMOKE_[A-Z]+/)?.[0] ?? 'chat';
    const props = schema?.properties;
    const record = (event) =>
      appendFileSync(
        join(process.env.SIHQ_TEST_DIR, 'model.jsonl'),
        JSON.stringify({
          event,
          tag,
          structured: !!props,
          model: request.model,
          effort: request.reasoningEffort,
          at: Date.now(),
        }) + '\n',
      );
    record('start');
    if (!props) {
      yield {
        type: 'text-delta',
        index: 0,
        text: input.includes('SIHQ_OK') ? 'SIHQ_OK' : '已记录聊天背景。',
      };
      yield { type: 'finish', reason: 'stop' };
    } else {
      const incomplete = input.includes('SMOKE_INCOMPLETE');
      let report;
      if (props.evidence) {
        report = {
          summary: tag + ' summary',
          evidence:
            tag === 'SMOKE_REASSIGN' && request.model === 'quick'
              ? []
              : [
                  tag + ' evidence',
                  ...(input.includes('SIHQ_DOC_ORIGINAL') && request.model === 'quick'
                    ? ['SIHQ_DOC_ORIGINAL']
                    : []),
                  ...(tag === 'SMOKE_READ' ? ['long '.repeat(14500) + 'END_OF_EVIDENCE'] : []),
                ],
        };
      } else if (
        props.suggestions &&
        request.model === 'deep' &&
        input.includes('SIHQ_DOC_ORIGINAL') &&
        !input.includes('SIHQ_DOC_CHANGED')
      ) {
        report = {
          verdict: 'changes_requested',
          summary: '已核对入口',
          criteria: [{ criterion: '文档约定端到端验收', result: 'passed', evidence: '回车可用' }],
          findings: [],
          checks: [],
          limitations: [],
          suggestions: [
            {
              severity: 'P2',
              location: 'README.md',
              problem: '合并重复的入口说明',
              evidence: '两处相同描述',
              requestedChange: '保留一处说明',
            },
          ],
        };
      } else if (props.outcome) {
        if (input.includes('SMOKE_FIX') && input.includes('first test failed'))
          writeFileSync(
            join(process.env.SIHQ_TEST_DIR, 'project', 'checkout', 'repair-smoke.marker'),
            'fixed',
          );
        report = {
          summary: tag,
          outcome: incomplete ? 'incomplete' : 'implemented',
          changes: [],
          validations: [],
          remaining: incomplete ? ['missing result'] : [],
        };
      } else {
        throw new Error('Unsupported smoke report schema');
      }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: randomUUID(),
        name: 'structured_output',
        argumentsDelta: JSON.stringify(report),
      };
      yield { type: 'finish', reason: 'tool-calls' };
    }
    record('end');
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['sihq-test'], new LocalAdapter());
  ctx.commands.register({
    name: 'smoke-checkout',
    description: 'Switch this test session to a different checkout',
    async handler({ agent }) {
      await ctx.workingDirectory.set(agent, join(process.env.SIHQ_TEST_DIR, 'project/checkout'));
      appendFileSync(join(process.env.SIHQ_TEST_DIR, 'checkout.log'), 'moved\n');
      return { kind: 'success', text: '已切换到测试 checkout' };
    },
  });
  for (const background of [false, true])
    ctx.commands.register({
      name: background ? 'smoke-stop-shell' : 'smoke-native-shell',
      description: 'Probe the unmodified DSH shell independently of SIHQ',
      async handler({ agent, signal }) {
        const tool = process.platform === 'win32' ? 'pwsh' : 'bash';
        const input = {
          description: 'Inspect the isolated DSH test shell',
          workdir: join(process.env.SIHQ_TEST_DIR, 'project/checkout'),
          command: background
            ? tool === 'pwsh'
              ? 'Start-Sleep -Seconds 30'
              : 'sleep 30'
            : tool === 'pwsh'
              ? "Write-Output 'SMOKE_NATIVE_TOOL'"
              : 'echo SMOKE_NATIVE_TOOL',
          ...(background && { run_in_background: true }),
          timeoutMs: 5000,
        };
        const assembly = await ctx.systemPrompt.assemble({ scope: agent, signal });
        const direct = assembly.tools.some((t) => t.name === tool);
        const call = {
          type: 'tool-call',
          id: randomUUID(),
          name: direct ? tool : 'run_code',
          arguments: JSON.stringify(
            direct
              ? input
              : {
                  description: input.description,
                  code: 'return await tools.' + tool + '(' + JSON.stringify(input) + ')',
                },
          ),
        };
        const result = await ctx.tools.execute({ calls: [call], agent, signal });
        if (background) {
          const toolResult = result.results[0]?.result;
          const handle = direct ? toolResult?.value : toolResult?.value?.result;
          const output = join(process.env.SIHQ_TEST_DIR, 'native-stop.json');
          try {
            if (handle?.kind !== 'background') throw Error(JSON.stringify(toolResult));
            const file = join(
              process.env.DSH_HOME,
              'profiles/test/node_modules/dsh-sihq/verification-command.js',
            );
            const { stopVerificationJob } = await import(pathToFileURL(file).href);
            await stopVerificationJob(ctx, agent, handle.jobId);
            writeFileSync(output, JSON.stringify({ jobId: handle.jobId }));
          } catch (error) {
            writeFileSync(output, JSON.stringify({ error: String(error) }));
          }
          return { kind: 'success', text: '已记录原生 shell 取消结果' };
        }
        writeFileSync(
          join(process.env.SIHQ_TEST_DIR, 'native-shell.json'),
          JSON.stringify({ call, result }, null, 2),
        );
        return { kind: 'success', text: '已记录 DSH 原生命令结果' };
      },
    });
  for (const [folder, name] of [
    ['project', 'SIHQ 测试项目'],
    ['other', 'SIHQ 隔离项目'],
  ]) {
    const path = join(process.env.SIHQ_TEST_DIR, folder);
    ctx.workspaceRegistry
      .resolveByPath(path)
      .then((found) => found ?? ctx.workspaceRegistry.create(path, name));
  }
}
