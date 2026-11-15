export type RoleName = 'planner' | 'developer' | 'reviewer';
export type RunPurpose = 'developer_feedback' | 'planner_summary';
export type ImplementationOutcome = 'implemented' | 'incomplete';
export type ReviewVerdict = 'passed' | 'changes_requested' | 'blocked';

export type RoleContext = {
  instruction: string;
  snapshot?: unknown;
  git?: unknown;
};
export type RoleResult = {
  artifact: unknown;
  outcome?: ImplementationOutcome;
  verdict?: ReviewVerdict;
};

// 角色定义只有数据和纯函数。执行器负责 I/O、生命周期和结果落盘。
export type RoleDefinition = {
  artifactName: string;
  snapshotFile?: string;
  gitBaseline?: 'git-before' | 'git-review';
  label: string;
  sandboxMode: 'read-only' | 'workspace-write';
  outputSchema: unknown;
  displayMessages?: boolean;
  buildPrompt(context: RoleContext): string;
  parseResult(answer: string, context: RoleContext): RoleResult;
};
