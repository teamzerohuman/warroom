import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type EnvStatus = {
  exampleExists: boolean;
  examplePath: string;
  localExists: boolean;
  adapter: string | null;
  adapterSupported: boolean;
  notes: string[];
};

export type AdapterInvocation = {
  command: string;
  args: string[];
  display: string;
  cwd: string;
  mode: 'foreground' | 'task';
};

export type AdapterRunResult = {
  launched: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  invocation: AdapterInvocation;
};

export type AdapterInvocationOptions = {
  repoId?: string | null;
};

export type AdapterRunOptions = AdapterInvocationOptions & {
  cwd?: string;
};

function parseEnv(raw: string) {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return values;
}

function codexCloudSetupNote() {
  const home = process.env.HOME;
  if (home) {
    const statePath = path.join(home, '.codex', '.codex-global-state.json');
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
        'electron-persisted-atom-state'?: { codexCloudAccess?: string };
      };
      const access = state['electron-persisted-atom-state']?.codexCloudAccess;
      if (access === 'enabled_needs_setup') {
        return 'Codex Cloud is enabled but still needs setup; open Codex Desktop, create or connect a Cloud environment for the target repo, then set CODEX_CLOUD_ENV to that environment id.';
      }
    } catch {
      // The local Codex app state is optional; fall back to the generic setup hint.
    }
  }

  return 'Run `codex cloud` to browse configured environments. If no environment id is shown, finish Codex Cloud environment setup in Codex Desktop first.';
}

function repoEnvSuffix(repoId: string | null | undefined) {
  const suffix = repoId?.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return suffix || null;
}

function codexCloudEnvVar(repoId: string | null | undefined) {
  const suffix = repoEnvSuffix(repoId);
  return suffix ? `CODEX_CLOUD_ENV_${suffix}` : 'CODEX_CLOUD_ENV';
}

function hasAnyCodexCloudEnv(...sources: Array<Map<string, string>>) {
  return sources.some((source) =>
    Array.from(source.entries()).some(([key, value]) => (key === 'CODEX_CLOUD_ENV' || key.startsWith('CODEX_CLOUD_ENV_')) && Boolean(value))
  );
}

function missingCodexCloudEnvMessage(repoId?: string | null) {
  const envVar = codexCloudEnvVar(repoId);
  const scope = repoId ? ` for repo ${repoId}` : '';
  return `${envVar} is required when LLM_ADAPTER=codex-cloud${scope}. ${codexCloudSetupNote()}`;
}

export function getEnvStatus(workspaceRoot: string): EnvStatus {
  const examplePath = path.join(workspaceRoot, '.env.local.example');
  const localPath = path.join(workspaceRoot, '.env.local');
  const exampleExists = existsSync(examplePath);
  const localExists = existsSync(localPath);
  const notes: string[] = [];
  const example = exampleExists ? parseEnv(readFileSync(examplePath, 'utf8')) : new Map<string, string>();
  const local = localExists ? parseEnv(readFileSync(localPath, 'utf8')) : new Map<string, string>();
  const adapter = local.get('LLM_ADAPTER') ?? example.get('LLM_ADAPTER') ?? null;
  const adapterSupported = adapter === 'codex' || adapter === 'codex-cloud' || adapter === 'claude';

  if (!localExists) notes.push('.env.local is optional but needed before launching LLM adapters.');
  if (!adapterSupported) notes.push('LLM_ADAPTER should be codex, codex-cloud, or claude.');
  if (adapter === 'codex-cloud' && !hasAnyCodexCloudEnv(local, example)) {
    notes.push(
      `CODEX_CLOUD_ENV or repo-specific CODEX_CLOUD_ENV_<REPO_ID> values are required when LLM_ADAPTER=codex-cloud. ${codexCloudSetupNote()}`
    );
  }

  return {
    exampleExists,
    examplePath,
    localExists,
    adapter,
    adapterSupported,
    notes,
  };
}

export function getAdapterCommand(workspaceRoot: string, options: AdapterInvocationOptions = {}) {
  return getAdapterInvocation(workspaceRoot, workspaceRoot, options).display;
}

export function getAdapterInvocation(
  workspaceRoot: string,
  cwd = workspaceRoot,
  options: AdapterInvocationOptions = {}
): AdapterInvocation {
  const examplePath = path.join(workspaceRoot, '.env.local.example');
  const localPath = path.join(workspaceRoot, '.env.local');
  const example = existsSync(examplePath) ? parseEnv(readFileSync(examplePath, 'utf8')) : new Map<string, string>();
  const local = existsSync(localPath) ? parseEnv(readFileSync(localPath, 'utf8')) : new Map<string, string>();
  const adapter = local.get('LLM_ADAPTER') ?? example.get('LLM_ADAPTER') ?? 'codex';
  if (adapter === 'claude') {
    const command = local.get('CLAUDE_COMMAND') ?? example.get('CLAUDE_COMMAND') ?? 'claude';
    return { command, args: [], display: command, cwd, mode: 'foreground' };
  }

  if (adapter === 'codex-cloud') {
    const command = local.get('CODEX_COMMAND') ?? example.get('CODEX_COMMAND') ?? 'codex';
    const envVar = codexCloudEnvVar(options.repoId);
    const env = local.get(envVar) ?? example.get(envVar);
    if (!env) throw new Error(missingCodexCloudEnvMessage(options.repoId));
    const args = ['cloud', 'exec', '--env', env];
    return { command, args, display: [command, ...args, '<prompt>'].join(' '), cwd, mode: 'task' };
  }

  const command = local.get('CODEX_COMMAND') ?? example.get('CODEX_COMMAND') ?? 'codex';
  const args = ['exec', '--cd', cwd, '-'];
  return { command, args, display: [command, ...args].join(' '), cwd, mode: 'foreground' };
}

export function runAdapter(workspaceRoot: string, prompt: string, options: AdapterRunOptions = {}): AdapterRunResult {
  const invocation = getAdapterInvocation(workspaceRoot, options.cwd ?? workspaceRoot, options);
  const taskMode = invocation.mode === 'task';
  process.stderr.write(`${taskMode ? 'Submitting adapter task' : 'Launching adapter'}: ${invocation.display}\n`);
  const result = spawnSync(invocation.command, taskMode ? [...invocation.args, prompt] : invocation.args, {
    cwd: invocation.cwd,
    input: taskMode ? undefined : prompt,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf8',
  });
  const error =
    result.error?.message ??
    (result.status === 0 ? null : `Adapter exited with status ${result.status ?? 'unknown'}.`);

  return {
    launched: result.status === 0,
    status: result.status,
    signal: result.signal,
    error,
    invocation,
  };
}
