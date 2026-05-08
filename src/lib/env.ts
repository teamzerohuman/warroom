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
  mode: 'foreground' | 'interactive';
};

export type AdapterRunResult = {
  launched: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  stdout: string | null;
  invocation: AdapterInvocation;
};

export type AdapterRunOptions = {
  cwd?: string;
  outputLastMessagePath?: string;
  captureStdout?: boolean;
};

function parseEnv(raw: string) {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim().replace(/^export\s+/, '');
    values.set(key, parseEnvValue(trimmed.slice(separator + 1)));
  }
  return values;
}

function parseEnvValue(raw: string) {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    if (quote === '"') return inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return inner.replace(/\\'/g, "'");
  }
  return value;
}

function readEnvMap(filePath: string) {
  return existsSync(filePath) ? parseEnv(readFileSync(filePath, 'utf8')) : new Map<string, string>();
}

function localProcessEnv(workspaceRoot: string) {
  const localPath = path.join(workspaceRoot, '.env.local');
  return Object.fromEntries(readEnvMap(localPath));
}

function codexModelArgs(local: Map<string, string>, example: Map<string, string>, prefix = 'CODEX') {
  const model = local.get(`${prefix}_MODEL`) ?? example.get(`${prefix}_MODEL`) ?? local.get('CODEX_MODEL') ?? example.get('CODEX_MODEL') ?? 'gpt-5.5';
  const reasoningEffort =
    local.get(`${prefix}_REASONING_EFFORT`) ?? example.get(`${prefix}_REASONING_EFFORT`) ?? local.get('CODEX_REASONING_EFFORT') ?? example.get('CODEX_REASONING_EFFORT') ?? 'xhigh';
  const fastMode = local.get(`${prefix}_FAST_MODE`) ?? example.get(`${prefix}_FAST_MODE`) ?? local.get('CODEX_FAST_MODE') ?? example.get('CODEX_FAST_MODE') ?? 'false';
  return [
    '--model',
    model,
    '-c',
    `model_reasoning_effort="${reasoningEffort}"`,
    ...(fastMode === 'true' ? [] : ['--disable', 'fast_mode']),
  ];
}

export function getEnvStatus(workspaceRoot: string): EnvStatus {
  const examplePath = path.join(workspaceRoot, '.env.local.example');
  const localPath = path.join(workspaceRoot, '.env.local');
  const exampleExists = existsSync(examplePath);
  const localExists = existsSync(localPath);
  const notes: string[] = [];
  const example = readEnvMap(examplePath);
  const local = readEnvMap(localPath);
  const adapter = local.get('LLM_ADAPTER') ?? example.get('LLM_ADAPTER') ?? null;
  const adapterSupported = adapter === 'codex' || adapter === 'codex-cloud' || adapter === 'claude';

  if (!localExists) notes.push('.env.local is optional but needed before launching LLM adapters.');
  if (!adapterSupported) notes.push('LLM_ADAPTER should be codex or claude. Legacy codex-cloud is treated as codex.');
  if (adapter === 'codex-cloud') {
    notes.push('LLM_ADAPTER=codex-cloud is deprecated; War Room will run codex locally with codex exec. Set LLM_ADAPTER=codex to remove this note.');
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

export function getAdapterCommand(workspaceRoot: string) {
  return getAdapterInvocation(workspaceRoot, workspaceRoot).display;
}

export function getAdapterInvocation(workspaceRoot: string, cwd = workspaceRoot): AdapterInvocation {
  const examplePath = path.join(workspaceRoot, '.env.local.example');
  const localPath = path.join(workspaceRoot, '.env.local');
  const example = readEnvMap(examplePath);
  const local = readEnvMap(localPath);
  const adapter = local.get('LLM_ADAPTER') ?? example.get('LLM_ADAPTER') ?? 'codex';
  if (adapter === 'claude') {
    const command = local.get('CLAUDE_COMMAND') ?? example.get('CLAUDE_COMMAND') ?? 'claude';
    return { command, args: [], display: command, cwd, mode: 'foreground' };
  }

  const command = local.get('CODEX_COMMAND') ?? example.get('CODEX_COMMAND') ?? 'codex';
  const modelArgs = codexModelArgs(local, example);
  const args = ['exec', ...modelArgs, '--cd', cwd, '-'];
  return { command, args, display: [command, ...args].join(' '), cwd, mode: 'foreground' };
}

export function getInteractiveAdapterInvocation(workspaceRoot: string, cwd = workspaceRoot, prompt = '<prompt>'): AdapterInvocation {
  const examplePath = path.join(workspaceRoot, '.env.local.example');
  const localPath = path.join(workspaceRoot, '.env.local');
  const example = readEnvMap(examplePath);
  const local = readEnvMap(localPath);
  const adapter = local.get('LLM_ADAPTER') ?? example.get('LLM_ADAPTER') ?? 'codex';
  if (adapter === 'claude') {
    const command = local.get('CLAUDE_COMMAND') ?? example.get('CLAUDE_COMMAND') ?? 'claude';
    return { command, args: [prompt], display: `${command} <prompt>`, cwd, mode: 'interactive' };
  }

  const command = local.get('CODEX_COMMAND') ?? example.get('CODEX_COMMAND') ?? 'codex';
  const sandbox = local.get('CODEX_INTERACTIVE_SANDBOX') ?? example.get('CODEX_INTERACTIVE_SANDBOX') ?? 'workspace-write';
  const networkAccess = local.get('CODEX_INTERACTIVE_NETWORK_ACCESS') ?? example.get('CODEX_INTERACTIVE_NETWORK_ACCESS') ?? 'true';
  const modelArgs = codexModelArgs(local, example, 'CODEX_INTERACTIVE');
  const networkArgs = networkAccess === 'false' ? [] : ['-c', 'sandbox_workspace_write.network_access=true'];
  const args = [...modelArgs, '--sandbox', sandbox, ...networkArgs, '--cd', cwd, prompt];
  return {
    command,
    args,
    display: [command, ...modelArgs, '--sandbox', sandbox, ...networkArgs, '--cd', cwd, '<prompt>'].join(' '),
    cwd,
    mode: 'interactive',
  };
}

export function runAdapter(workspaceRoot: string, prompt: string, options: AdapterRunOptions = {}): AdapterRunResult {
  const invocation = withLastMessageOutput(
    getAdapterInvocation(workspaceRoot, options.cwd ?? workspaceRoot),
    options.outputLastMessagePath
  );
  const captureStdout = options.captureStdout === true;
  process.stderr.write(`Launching adapter: ${invocation.display}\n`);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    input: prompt,
    stdio: ['pipe', captureStdout ? 'pipe' : 'inherit', 'inherit'],
    encoding: 'utf8',
    env: {
      ...process.env,
      ...localProcessEnv(workspaceRoot),
    },
  });
  const error =
    result.error?.message ??
    (result.status === 0 ? null : `Adapter exited with status ${result.status ?? 'unknown'}.`);

  return {
    launched: result.status === 0,
    status: result.status,
    signal: result.signal,
    error,
    stdout: captureStdout ? result.stdout ?? '' : null,
    invocation,
  };
}

function withLastMessageOutput(invocation: AdapterInvocation, outputPath: string | undefined): AdapterInvocation {
  if (!outputPath || invocation.args[0] !== 'exec') return invocation;

  const args = ['exec', '-o', outputPath, ...invocation.args.slice(1)];
  return {
    ...invocation,
    args,
    display: [invocation.command, ...args].join(' '),
  };
}

export function runInteractiveAdapter(workspaceRoot: string, prompt: string, options: AdapterRunOptions = {}): AdapterRunResult {
  const invocation = getInteractiveAdapterInvocation(workspaceRoot, options.cwd ?? workspaceRoot, prompt);
  process.stderr.write(`Launching interactive adapter: ${invocation.display}\n`);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    stdio: 'inherit',
    encoding: 'utf8',
    env: {
      ...process.env,
      ...localProcessEnv(workspaceRoot),
    },
  });
  const error =
    result.error?.message ??
    (result.status === 0 ? null : `Adapter exited with status ${result.status ?? 'unknown'}.`);

  return {
    launched: result.status === 0,
    status: result.status,
    signal: result.signal,
    error,
    stdout: null,
    invocation,
  };
}
