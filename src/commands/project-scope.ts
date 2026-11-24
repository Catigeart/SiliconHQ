import { sameProjectDirectory } from '../storage/project-path.js';

/** A chat command can operate on records belonging to the project selected at submission. */
export class ProjectScope {
  constructor(readonly cwd: string) {}

  includes(directory: string): boolean {
    return sameProjectDirectory(this.cwd, directory);
  }

  require(directory: string): void {
    if (!this.includes(directory)) throw new Error('此命令仅能访问当前 DSH 项目的记录和目录。');
  }
}
