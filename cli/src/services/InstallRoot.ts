import os from 'os';
import path from 'path';

/**
 * Where an install writes its output.
 *
 * - `project`: `<cwd>/.claude/...`, router in `<cwd>/AGENTS.md`. The historical
 *   and default behaviour.
 * - `user`: `~/.claude/...`, router appended to `~/.claude/CLAUDE.md`. Agents
 *   read that file for every project, so a single install applies everywhere.
 *   Note this is deliberately NOT `~/AGENTS.md`: nothing reads it.
 */
export type InstallScope = 'project' | 'user';

let currentScope: InstallScope = 'project';
let currentRoot: string | null = null;

/**
 * Root directory every install path is resolved against.
 *
 * Threading this through all ~36 `process.cwd()` call sites as a parameter
 * would touch a dozen services and their tests; the CLI resolves it once at
 * entry instead. Call `resetInstallRoot()` between tests.
 */
export function getInstallRoot(): string {
  return currentRoot ?? process.cwd();
}

export function getInstallScope(): InstallScope {
  return currentScope;
}

/**
 * User scope resolves to the home directory so that `.claude/skills` lands in
 * `~/.claude/skills` — the config dir agents already read.
 */
export function setInstallScope(scope: InstallScope, home = os.homedir()): void {
  currentScope = scope;
  currentRoot = scope === 'user' ? path.resolve(home) : null;
}

export function resetInstallRoot(): void {
  currentScope = 'project';
  currentRoot = null;
}
