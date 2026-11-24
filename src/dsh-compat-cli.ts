import { runCli } from './commands/main.js';
import { ProjectScope } from './commands/project-scope.js';

void runCli(new ProjectScope(process.cwd()));
