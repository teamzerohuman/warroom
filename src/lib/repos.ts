import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { z } from 'zod';

const SpecialistSchema = z.object({
  name: z.string(),
  context: z.object({
    frameworks: z.array(z.string()).default([]),
    domains: z.array(z.string()).default([]),
    resources: z.array(z.string()).default([]),
  }),
});

const ChangelogSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean().default(true),
    format: z.enum(['keep-a-changelog', 'openchangelog']).default('keep-a-changelog'),
    path: z.string().optional(),
    url: z.string().url().optional(),
  }),
]);

const BumpSchema = z.union([
  z.boolean(),
  z.string(),
  z.object({
    enabled: z.boolean().default(true),
    command: z.string().optional(),
  }),
]);

const PostMergeSchema = z.union([
  z.boolean(),
  z.string(),
  z.object({
    enabled: z.boolean().default(true),
    command: z.string().optional(),
  }),
]);

const MergeSchema = z.object({
  playwright: z.boolean().default(false),
  bump: BumpSchema.default(false),
  changelog: ChangelogSchema.default(false),
  post_merge: PostMergeSchema.default(false),
});

const RawRepoSchema = z.object({
  id: z.string(),
  name: z.string(),
  github: z.string(),
  ssh_url: z.string(),
  local_path: z.string(),
  status: z.enum(['active', 'planned']),
  planned_by: z.string().optional(),
  merge: MergeSchema.default({}),
  merge_playwright: z.boolean().optional(),
  owner: z.string(),
  description: z.string(),
  specialist: SpecialistSchema,
});

const RepoSchema = RawRepoSchema.transform(({ merge, merge_playwright, ...repo }) => ({
  ...repo,
  merge: {
    playwright: merge.playwright ?? merge_playwright ?? false,
    bump: normalizeBumpConfig(merge.bump ?? false),
    changelog: normalizeChangelogConfig(merge.changelog ?? false),
    postMerge: normalizePostMergeConfig(merge.post_merge ?? false),
  },
}));

const RepoManifestSchema = z.object({
  version: z.number(),
  defaults: z.object({
    owner: z.string(),
    clone_protocol: z.string(),
    default_branch: z.string(),
    local_root: z.string(),
  }),
  repos: z.array(RepoSchema),
});

export type RepoEntry = z.infer<typeof RepoSchema>;
export type RepoManifest = z.infer<typeof RepoManifestSchema>;
export type RepoSource = 'manifest' | 'sibling' | 'missing';

export type RepoHealth = RepoEntry & {
  configuredPath: string;
  resolvedPath: string;
  absolutePath: string;
  source: RepoSource;
  checkedOut: boolean;
  manifestCheckedOut: boolean;
  clean: boolean | null;
  statusLines: string[];
  branch: string | null;
  headSha: string | null;
  upstream: string | null;
  packageManager: string | null;
  nodeModules: boolean;
};

function normalizeChangelogConfig(changelog: z.infer<typeof ChangelogSchema>) {
  if (typeof changelog === 'boolean') {
    return {
      enabled: changelog,
      format: 'keep-a-changelog' as const,
      path: 'CHANGELOG.md',
      url: null as string | null,
    };
  }

  return {
    enabled: changelog.enabled,
    format: changelog.format,
    path: changelog.path ?? (changelog.format === 'openchangelog' ? 'release-notes' : 'CHANGELOG.md'),
    url: changelog.url ?? null,
  };
}

function normalizeBumpConfig(bump: z.infer<typeof BumpSchema>) {
  if (typeof bump === 'boolean') {
    return {
      enabled: bump,
      command: null as string | null,
    };
  }

  if (typeof bump === 'string') {
    return {
      enabled: true,
      command: bump,
    };
  }

  return {
    enabled: bump.enabled,
    command: bump.command ?? null,
  };
}

function normalizePostMergeConfig(postMerge: z.infer<typeof PostMergeSchema>) {
  if (typeof postMerge === 'boolean') {
    return {
      enabled: postMerge,
      command: null as string | null,
    };
  }

  if (typeof postMerge === 'string') {
    return {
      enabled: true,
      command: postMerge,
    };
  }

  return {
    enabled: postMerge.enabled,
    command: postMerge.command ?? null,
  };
}

export function loadRepoManifest(workspaceRoot: string): RepoManifest {
  const manifestPath = path.join(workspaceRoot, 'repos.yaml');
  const raw = readFileSync(manifestPath, 'utf8');
  return RepoManifestSchema.parse(YAML.parse(raw));
}

export function writeRepoManifest(workspaceRoot: string, manifest: RepoManifest) {
  const manifestPath = path.join(workspaceRoot, 'repos.yaml');
  writeFileSync(manifestPath, YAML.stringify(manifest));
}

export function absolutePath(workspaceRoot: string, maybeRelativePath: string) {
  return path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.resolve(workspaceRoot, maybeRelativePath);
}

export function isGitCheckout(repoPath: string) {
  return existsSync(path.join(repoPath, '.git'));
}

export function getSiblingRepoPath(workspaceRoot: string, repo: RepoEntry) {
  return path.resolve(workspaceRoot, '..', repo.name);
}

export function resolveRepo(workspaceRoot: string, repo: RepoEntry) {
  const configuredPath = absolutePath(workspaceRoot, repo.local_path);
  if (isGitCheckout(configuredPath)) {
    return { configuredPath, resolvedPath: configuredPath, source: 'manifest' as const };
  }

  const siblingPath = getSiblingRepoPath(workspaceRoot, repo);
  if (isGitCheckout(siblingPath)) {
    return { configuredPath, resolvedPath: siblingPath, source: 'sibling' as const };
  }

  return { configuredPath, resolvedPath: configuredPath, source: 'missing' as const };
}

export function runGit(repoPath: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function readPackageManager(repoPath: string) {
  const packageJsonPath = path.join(repoPath, 'package.json');
  if (!existsSync(packageJsonPath)) return null;

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { packageManager?: unknown };
    return typeof packageJson.packageManager === 'string' ? packageJson.packageManager : null;
  } catch {
    return null;
  }
}

export function getGitStatus(repoPath: string) {
  if (!isGitCheckout(repoPath)) {
    return { clean: null, statusLines: [] };
  }

  const result = runGit(repoPath, ['status', '--short', '--untracked-files=all']);
  if (result.status !== 0) {
    return { clean: null, statusLines: [`git status failed with exit ${result.status ?? 'unknown'}`] };
  }

  const statusLines = result.stdout.split(/\r?\n/).filter(Boolean);
  return { clean: statusLines.length === 0, statusLines };
}

function gitValue(repoPath: string, args: string[]) {
  if (!isGitCheckout(repoPath)) return null;
  const result = runGit(repoPath, args);
  return result.status === 0 && result.stdout ? result.stdout : null;
}

export function getRepoHealth(workspaceRoot: string, repo: RepoEntry): RepoHealth {
  const resolution = resolveRepo(workspaceRoot, repo);
  const gitStatus = getGitStatus(resolution.resolvedPath);

  return {
    ...repo,
    configuredPath: resolution.configuredPath,
    resolvedPath: resolution.resolvedPath,
    absolutePath: resolution.resolvedPath,
    source: resolution.source,
    checkedOut: isGitCheckout(resolution.resolvedPath),
    manifestCheckedOut: isGitCheckout(resolution.configuredPath),
    clean: gitStatus.clean,
    statusLines: gitStatus.statusLines,
    branch: gitValue(resolution.resolvedPath, ['branch', '--show-current']),
    headSha: gitValue(resolution.resolvedPath, ['rev-parse', '--short', 'HEAD']),
    upstream: gitValue(resolution.resolvedPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    packageManager: readPackageManager(resolution.resolvedPath),
    nodeModules: existsSync(path.join(resolution.resolvedPath, 'node_modules')),
  };
}

export function getRepoById(workspaceRoot: string, id: string) {
  const manifest = loadRepoManifest(workspaceRoot);
  const repo = manifest.repos.find((entry) => entry.id === id);
  if (!repo) throw new Error(`repos.yaml does not define repo "${id}".`);
  return repo;
}
