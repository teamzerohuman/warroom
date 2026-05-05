import { buildProgram } from '../src/cli.js';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runAbort } from '../src/commands/abort.js';
import { runAlliesStatus } from '../src/commands/allies.js';
import { runBootstrap } from '../src/commands/bootstrap.js';
import { runCampaignStatusCheck } from '../src/commands/campaign.js';
import { runCommitCreate } from '../src/commands/commit-create.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runDevStatus } from '../src/commands/dev-link.js';
import { getAdapterInvocation, getEnvStatus } from '../src/lib/env.js';
import { runMapsAssign } from '../src/commands/maps-assign.js';
import { runMapsStudy } from '../src/commands/maps-study.js';
import { runSync } from '../src/commands/sync.js';

const workspaceRoot = new URL('..', import.meta.url).pathname;

describe('phase-1 CLI', () => {
  it('loads the repo map', () => {
    const repos = runMapsStudy(workspaceRoot);
    expect(repos.map((repo) => repo.id)).toEqual([
      'sdk',
      'backend',
      'infra',
      'demo',
      'docs',
      'dashboard',
      'landing',
    ]);
  });

  it('loads ally workspace status', () => {
    const result = runAlliesStatus(workspaceRoot);

    expect(result.ok).toBe(true);
    expect(result.allies.map((ally) => ally.id)).toEqual(['clicktech']);
    expect(result.allies[0]?.issue_repo.github).toBe('TeamFloPay/ally-clicktech');
    expect(result.allies[0]?.envExampleExists).toBe(true);
    expect(result.allies[0]?.labels.missing).toEqual([]);
  });

  it('passes the skeleton doctor check', () => {
    expect(runDoctor(workspaceRoot).ok).toBe(true);
  }, 30000);

  it('sees the Campaign Map status options', () => {
    const result = runCampaignStatusCheck();

    expect(result.missing).toEqual([]);
    expect(result.options.map((option) => option.name)).toEqual([
      'needs-triage',
      'ready-to-engage',
      'battlefield-active',
      'skirmish',
      'blockaded',
      'victory',
    ]);
  }, 30000);

  it('validates campaign atlas generation state', () => {
    const result = runMapsAssign(workspaceRoot, { check: true });

    expect(result.resourceReferencesOk).toBe(true);
    expect(result.atlasMatches).toBe(true);
  });

  it('prints maps study output', async () => {
    const lines: string[] = [];
    const program = buildProgram({ cwd: workspaceRoot, output: (line) => lines.push(line) });

    await program.parseAsync(['node', 'warroom', 'maps', 'study']);

    expect(lines.some((line) => line.includes('TeamFloPay/sdk'))).toBe(true);
    expect(lines.some((line) => line.includes('TeamFloPay/demo'))).toBe(true);
  });

  it('prints allies status output', async () => {
    const lines: string[] = [];
    const program = buildProgram({ cwd: workspaceRoot, output: (line) => lines.push(line) });

    await program.parseAsync(['node', 'warroom', 'allies', 'status']);

    expect(lines.some((line) => line.includes('Allies: ok'))).toBe(true);
    expect(lines.some((line) => line.includes('clicktech: active'))).toBe(true);
  });

  it('selects a ready issue and creates a PR engagement handoff', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const input = Readable.from(['1\n']);
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line), input, interactive: true });

      await program.parseAsync(['node', 'warroom', 'issue', 'next']);

      expect(lines).toContain('Issues with Campaign status ready-to-engage: 1');
      expect(lines.some((line) => line.startsWith('1. TeamFloPay/sdk#7'))).toBe(true);
      expect(lines).toContain('Engaging TeamFloPay/sdk#7');
      expect(lines).toContain('PR engage: launched');
      expect(lines.some((line) => line.startsWith('Adapter: codex exec --cd '))).toBe(true);
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#7 -> battlefield-active');
      expect(lines.some((line) => line.includes('War Room implementation handoff for TeamFloPay/sdk#7'))).toBe(true);
      expect(lines.some((line) => line.includes('Title: Build the selector'))).toBe(true);
      expect(lines.some((line) => line.includes('Feature branch: warroom/7-build-the-selector'))).toBe(true);
      expect(lines.some((line) => line.includes('Do not stop after writing a plan'))).toBe(true);
      expect(lines.some((line) => line.includes('Triage complete: build the feature directly.'))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('can submit PR engagement through Codex Cloud adapter', async () => {
    const root = makeDevFixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeGhFixture(bin);
    writeCodexFixture(bin);
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex-cloud\nCODEX_COMMAND=codex\nCODEX_CLOUD_ENV_SDK=env_fixture\n');

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;

    try {
      const lines: string[] = [];
      const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

      await program.parseAsync(['node', 'warroom', 'pr', 'engage', '--issue', 'TeamFloPay/sdk#7', '--launch', '--confirm-status']);

      expect(lines).toContain('Preparing implementation for TeamFloPay/sdk#7...');
      expect(lines).toContain('PR engage: launched');
      expect(lines.some((line) => line.includes('Adapter: codex cloud exec --env env_fixture <prompt>'))).toBe(true);
      expect(lines).toContain('Campaign status: updated TeamFloPay/sdk#7 -> battlefield-active');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('explains incomplete Codex Cloud setup when the environment id is missing', () => {
    const root = makeDevFixture();
    const home = path.join(root, 'home');
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex-cloud\nCODEX_COMMAND=codex\n');
    writeFileSync(
      path.join(home, '.codex', '.codex-global-state.json'),
      JSON.stringify({ 'electron-persisted-atom-state': { codexCloudAccess: 'enabled_needs_setup' } })
    );

    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const result = getEnvStatus(root);

      expect(result.notes.some((note) => note.includes('CODEX_CLOUD_ENV or repo-specific CODEX_CLOUD_ENV_<REPO_ID>'))).toBe(true);
      expect(result.notes.some((note) => note.includes('Codex Cloud is enabled but still needs setup'))).toBe(true);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('requires the owning repo Codex Cloud environment for mapped launches', () => {
    const root = makeDevFixture();
    writeFileSync(path.join(root, '.env.local'), 'LLM_ADAPTER=codex-cloud\nCODEX_COMMAND=codex\nCODEX_CLOUD_ENV_BACKEND=env_backend\n');

    expect(() => getAdapterInvocation(root, root, { repoId: 'sdk' })).toThrow(/CODEX_CLOUD_ENV_SDK is required/);
    expect(getAdapterInvocation(root, root, { repoId: 'backend' }).display).toContain('codex cloud exec --env env_backend <prompt>');
  });

  it('reports SDK-to-demo link state from sibling checkouts', () => {
    const root = makeDevFixture();

    const status = runDevStatus(root);

    expect(status.sdk.checkedOut).toBe(true);
    expect(status.sdk.source).toBe('sibling');
    expect(status.demo.checkedOut).toBe(true);
    expect(status.linked).toBe(true);
    expect(status.packages.map((pkg) => [pkg.name, pkg.linked])).toEqual([
      ['@flopay/shared', true],
      ['@flopay/js', true],
      ['@flopay/react', true],
      ['@flopay/node', true],
    ]);
  });

  it('prints dev status output', async () => {
    const root = makeDevFixture();
    const lines: string[] = [];
    const program = buildProgram({ cwd: root, output: (line) => lines.push(line) });

    await program.parseAsync(['node', 'warroom', 'dev', 'status']);

    expect(lines.some((line) => line.includes('SDK-to-demo dev link: linked'))).toBe(true);
    expect(lines.some((line) => line.includes('Demo Playwright core:'))).toBe(true);
    expect(lines.some((line) => line.includes('NODE_OPTIONS=--preserve-symlinks'))).toBe(false);
  });

  it('previews bootstrap without cloning sibling checkouts', () => {
    const root = makeDevFixture();

    const result = runBootstrap(root, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.repos.map((repo) => repo.state)).toEqual(['sibling-present', 'sibling-present']);
  });

  it('reports sync state without mutating repos', () => {
    const root = makeDevFixture();

    const result = runSync(root, { report: true });

    expect(result.reportOnly).toBe(true);
    expect(result.repos).toHaveLength(2);
  });

  it('prints preservation-first abort recovery output', () => {
    const root = makeDevFixture();

    const result = runAbort(root);

    expect(result.mutated).toBe(false);
    expect(result.repos.map((repo) => repo.repo)).toEqual(['TeamFloPay/sdk', 'TeamFloPay/demo']);
  });

  it('preflights commit creation with validation artifacts', () => {
    const { root, sdk } = makeCommitFixture();
    mkdirSync(path.join(sdk, 'docs'), { recursive: true });
    writeFileSync(path.join(sdk, 'docs', 'note.md'), 'Commit notes.\n');

    const result = runCommitCreate(root, {
      repo: 'sdk',
      validate: ['node -e "console.log(42)"'],
      writeArtifact: true,
    });

    expect(result.blocked).toEqual([]);
    expect(result.committed).toBe(false);
    expect(result.suggestedMessage).toBe('docs(sdk): update war room workflow');
    expect(result.changes.map((change) => [change.path, change.unstaged])).toEqual([['docs/note.md', true]]);
    expect(result.validation).toHaveLength(1);
    expect(result.validation[0]?.ok).toBe(true);
    expect(result.validation[0]?.stdout).toBe('42');
    expect(result.artifact).toBeDefined();
    expect(existsSync(path.join(result.artifact!.runDir, 'summary.md'))).toBe(true);
    expect(readFileSync(path.join(result.artifact!.runDir, 'summary.md'), 'utf8')).toContain('ok node -e "console.log(42)"');
  });

  it('blocks confirmed commit creation when changes are unstaged and --all is absent', () => {
    const { root, sdk } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');

    expect(() => runCommitCreate(root, { repo: 'sdk', confirm: true })).toThrow(/No staged changes/);
  });

  it('blocks commit creation when validation fails', () => {
    const { root, sdk } = makeCommitFixture();
    writeFileSync(path.join(sdk, 'index.ts'), 'export const value = 1;\n');

    const result = runCommitCreate(root, { repo: 'sdk', validate: ['node -e "process.exit(7)"'] });

    expect(result.validation[0]?.ok).toBe(false);
    expect(result.validation[0]?.status).toBe(7);
    expect(result.blocked).toContain('Validation failed: node -e "process.exit(7)"');
  });
});

function makeDevFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'warroom-dev-'));
  const root = path.join(base, 'warroom');
  const sdk = path.join(base, 'sdk');
  const demo = path.join(base, 'demo');

  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, 'maps', 'repos'), { recursive: true });
  mkdirSync(path.join(sdk, '.git'), { recursive: true });
  mkdirSync(path.join(demo, '.git'), { recursive: true });
  mkdirSync(path.join(demo, 'node_modules', '@flopay'), { recursive: true });

  writeFileSync(
    path.join(root, 'repos.yaml'),
    `version: 1
defaults:
  owner: TeamFloPay
  clone_protocol: ssh
  default_branch: main
  local_root: maps/repos
repos:
  - id: sdk
    name: sdk
    github: TeamFloPay/sdk
    ssh_url: git@github.com:TeamFloPay/sdk.git
    local_path: maps/repos/sdk
    status: active
    owner: sdk
    description: SDK packages.
    specialist:
      name: SDK Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
  - id: demo
    name: demo
    github: TeamFloPay/demo
    ssh_url: git@github.com:TeamFloPay/demo.git
    local_path: maps/repos/demo
    status: active
    owner: demo
    description: Demo app.
    specialist:
      name: Demo Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
`
  );
  writeResourcesFixture(root);

  writeFileSync(path.join(sdk, 'package.json'), '{"packageManager":"pnpm@9.15.0"}\n');
  writeFileSync(path.join(demo, 'package.json'), '{"packageManager":"pnpm@9.15.0"}\n');

  for (const packageName of ['shared', 'js', 'react', 'node']) {
    const packagePath = path.join(sdk, 'packages', packageName);
    const mirrorPath = path.join(root, '.warroom', 'dev', 'sdk-packages', packageName);
    mkdirSync(path.join(packagePath, 'dist'), { recursive: true });
    mkdirSync(path.join(mirrorPath, 'dist'), { recursive: true });
    writeFileSync(path.join(packagePath, 'package.json'), `{"name":"@flopay/${packageName}"}\n`);
    writeFileSync(path.join(packagePath, 'dist', 'index.mjs'), '');
    writeFileSync(path.join(mirrorPath, 'package.json'), `{"name":"@flopay/${packageName}"}\n`);
    symlinkSync(mirrorPath, path.join(demo, 'node_modules', '@flopay', packageName), 'dir');
  }

  return root;
}

function makeCommitFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'warroom-commit-'));
  const root = path.join(base, 'warroom');
  const sdk = path.join(base, 'sdk');
  const demo = path.join(base, 'demo');

  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, 'maps', 'repos'), { recursive: true });
  initGitRepo(sdk);
  initGitRepo(demo);

  writeFileSync(
    path.join(root, 'repos.yaml'),
    `version: 1
defaults:
  owner: TeamFloPay
  clone_protocol: ssh
  default_branch: main
  local_root: maps/repos
repos:
  - id: sdk
    name: sdk
    github: TeamFloPay/sdk
    ssh_url: git@github.com:TeamFloPay/sdk.git
    local_path: maps/repos/sdk
    status: active
    owner: sdk
    description: SDK packages.
    specialist:
      name: SDK Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
  - id: demo
    name: demo
    github: TeamFloPay/demo
    ssh_url: git@github.com:TeamFloPay/demo.git
    local_path: maps/repos/demo
    status: active
    owner: demo
    description: Demo app.
    specialist:
      name: Demo Sergeant
      context:
        frameworks: []
        domains: []
        resources: []
`
  );
  writeResourcesFixture(root);

  return { root, sdk, demo };
}

function initGitRepo(repoPath: string) {
  mkdirSync(repoPath, { recursive: true });
  const init = spawnSync('git', ['init', '-b', 'main'], { cwd: repoPath, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.stderr);
  spawnSync('git', ['config', 'user.email', 'warroom@example.com'], { cwd: repoPath });
  spawnSync('git', ['config', 'user.name', 'War Room'], { cwd: repoPath });
}

function writeResourcesFixture(root: string) {
  writeFileSync(
    path.join(root, 'resources.yaml'),
    `version: 1
resources:
  - id: github-cli
    type: cli
    name: GitHub CLI
    description: Fixture GitHub CLI resource.
  - id: typescript-docs
    type: docs
    name: TypeScript Documentation
    description: Fixture TypeScript docs resource.
`
  );
}

function writeGhFixture(bin: string) {
  const ghPath = path.join(bin, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);

function json(value) {
  process.stdout.write(JSON.stringify(value));
}

if (args[0] === 'project' && args[1] === 'item-list') {
  json({
    items: [
      {
        id: 'PVTI_ready',
        title: 'Build the selector',
        status: 'ready-to-engage',
        labels: ['ready-to-engage'],
        content: {
          repository: 'TeamFloPay/sdk',
          number: 7,
          title: 'Build the selector',
          url: 'https://github.com/TeamFloPay/sdk/issues/7'
        }
      }
    ]
  });
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
  json({
    title: 'Build the selector',
    body: 'Allow operators to pick a ready issue and start PR engagement.',
    url: 'https://github.com/TeamFloPay/sdk/issues/7',
    comments: [
      {
        author: { login: 'andrewslack' },
        body: 'Triage complete: build the feature directly.',
        createdAt: '2026-05-05T00:00:00Z'
      }
    ]
  });
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'view') {
  json({ id: 'PVT_campaign', title: 'Campaign Map' });
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'field-list') {
  json({
    fields: [
      {
        id: 'PVTSSF_status',
        name: 'Status',
        type: 'ProjectV2SingleSelectField',
        options: [
          { id: 'status_needs', name: 'needs-triage' },
          { id: 'status_ready', name: 'ready-to-engage' },
          { id: 'status_active', name: 'battlefield-active' },
          { id: 'status_skirmish', name: 'skirmish' },
          { id: 'status_blockaded', name: 'blockaded' },
          { id: 'status_victory', name: 'victory' }
        ]
      }
    ]
  });
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'item-edit') {
  process.exit(0);
}

console.error('Unexpected gh fixture call: ' + args.join(' '));
process.exit(1);
`
  );
  chmodSync(ghPath, 0o755);
}

function writeCodexFixture(bin: string) {
  const codexPath = path.join(bin, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);

if (args[0] === 'cloud' && args[1] === 'exec' && args[2] === '--env' && args[3]) {
  if (!args[4]) {
    console.error('missing prompt');
    process.exit(1);
  }
  console.log('submitted cloud task');
  process.exit(0);
}

process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`
  );
  chmodSync(codexPath, 0o755);
}
