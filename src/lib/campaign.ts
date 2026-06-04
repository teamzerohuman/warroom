import { spawnSync } from 'node:child_process';
import { parseRepoRef } from './refs.js';
import { getProjectConfig, parseCampaignProjectEnv } from './repos.js';
import { findWarRoomWorkspace } from './workspace.js';

// The campaign GitHub Project owner/number come from repos.yaml `defaults`
// (campaign_owner falls back to the repo owner; project number defaults to 1),
// overridable via WARROOM_CAMPAIGN_OWNER / WARROOM_CAMPAIGN_PROJECT.
export function campaignTarget(): { owner: string; project: number } {
  const env = process.env;
  const envOwner = env.WARROOM_CAMPAIGN_OWNER;
  const envProject = parseCampaignProjectEnv(env.WARROOM_CAMPAIGN_PROJECT);
  if (envOwner && envProject !== undefined) return { owner: envOwner, project: envProject };
  try {
    const config = getProjectConfig(findWarRoomWorkspace());
    return {
      owner: envOwner ?? config.campaignOwner,
      project: envProject ?? config.campaignProjectNumber,
    };
  } catch {
    return { owner: envOwner ?? 'your-org', project: envProject ?? 1 };
  }
}

const PROJECT_ITEM_LIST_RECENT_LIMIT = '200';
const PROJECT_ITEM_LIST_FALLBACK_LIMIT = '2000';
const RATE_LIMIT_RETRY_DELAY_MS = 30_000;

export const CAMPAIGN_STATUSES = [
  { name: 'needs-triage', color: 'GRAY', description: 'Blurry territory that needs planning before execution.' },
  { name: 'ready-to-engage', color: 'GREEN', description: 'Planned territory ready for implementation.' },
  { name: 'battlefield-active', color: 'BLUE', description: 'Work is actively being implemented.' },
  { name: 'skirmish', color: 'YELLOW', description: 'PR review, CodeRabbit feedback, or follow-up changes are being handled.' },
  { name: 'blockaded', color: 'RED', description: 'Work is blocked by an external dependency, decision, access issue, or prerequisite.' },
  { name: 'victory', color: 'PURPLE', description: 'Work is merged, cleaned up, and reported.' },
] as const;

export type CampaignStatusName = (typeof CAMPAIGN_STATUSES)[number]['name'];

export type CampaignStatusReport = {
  checked: boolean;
  expected: typeof CAMPAIGN_STATUSES;
  missing: string[];
  unexpected: string[];
  options: Array<{ id: string; name: string }>;
  projectId: string | null;
  statusFieldId: string | null;
  errors: string[];
};

export type CampaignStatusSetResult = {
  issue: string;
  status: CampaignStatusName;
  projectItemId: string | null;
  optionId: string;
  applied: boolean;
  added: boolean;
  reason: string | null;
};

export type CampaignProjectIssue = {
  repo: string;
  number: number;
  title: string;
  url: string;
  status: string | null;
  labels: string[];
  projectItemId: string;
};

type ProjectItem = {
  id: string;
  title?: string;
  status?: string;
  labels?: string[];
  content?: {
    repository?: string;
    number?: number;
    title?: string;
    url?: string;
  };
};

type CampaignCache = {
  contextKey?: string;
  projectView?: { id?: string; title?: string };
  statusField?: {
    id: string;
    name: string;
    type: string;
    options?: Array<{ id: string; name: string }>;
  } | null;
  items?: { items: ProjectItem[]; scope: 'recent' | 'fallback' };
};

let cache: CampaignCache = {};

// The cache lives for the process but must invalidate when either the gh
// environment or the campaign target changes. PATH is part of the key because
// the test suite swaps a fake `gh` binary onto PATH per test and relies on each
// test getting a fresh cache; owner/project are part of the key so pointing at a
// different project mid-process never returns another project's metadata. Note
// that only *successful* gh lookups are ever cached (see projectView etc.), so a
// transient failure is retried on the next call rather than poisoning the run.
function cacheContextKey(): string {
  const target = campaignTarget();
  return `${process.env.PATH ?? ''} :: ${target.owner}#${target.project}`;
}

function ensureCacheForContext() {
  const key = cacheContextKey();
  if (cache.contextKey !== key) {
    cache = { contextKey: key };
  }
}

export function resetCampaignCache() {
  cache = {};
}

function isRateLimitError(stderr: string) {
  const lower = stderr.toLowerCase();
  return lower.includes('api rate limit') || lower.includes('secondary rate limit') || lower.includes('rate limit exceeded');
}

function sleepSyncMs(ms: number) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function ghRun(args: string[]): { status: number | null; stdout: string; stderr: string } {
  let result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0 && isRateLimitError(result.stderr ?? '')) {
    process.stderr.write(`gh rate limit hit; waiting ${Math.round(RATE_LIMIT_RETRY_DELAY_MS / 1000)}s before retry...\n`);
    sleepSyncMs(RATE_LIMIT_RETRY_DELAY_MS);
    result = spawnSync('gh', args, { encoding: 'utf8' });
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// Returns the parsed JSON on success, or an error string on failure. A failure
// surfaces the gh stderr (e.g. "missing required scopes [read:project]") so
// callers can report the real reason instead of a vague "could not load".
// Callers decide whether to cache — successful results only — so a transient gh
// failure self-heals on the next call rather than poisoning the run.
function ghJson<T>(args: string[]): { ok: true; data: T } | { ok: false; error: string } {
  const result = ghRun(args);
  if (result.status !== 0 || !result.stdout.trim()) {
    const raw = result.stderr || result.stdout || `gh exited with status ${result.status}`;
    return { ok: false, error: raw.replace(/\s+/g, ' ').trim() };
  }
  return { ok: true, data: JSON.parse(result.stdout) as T };
}

function projectView(): { view: { id?: string; title?: string }; error: string | null } {
  ensureCacheForContext();
  if (cache.projectView !== undefined) return { view: cache.projectView, error: null };
  const target = campaignTarget();
  const result = ghJson<{ id?: string; title?: string }>([
    'project',
    'view',
    String(target.project),
    '--owner',
    target.owner,
    '--format',
    'json',
  ]);
  if (!result.ok) return { view: {}, error: result.error };
  cache.projectView = result.data;
  return { view: result.data, error: null };
}

function projectStatusField(): { field: CampaignCache['statusField']; error: string | null } {
  ensureCacheForContext();
  if (cache.statusField !== undefined) return { field: cache.statusField, error: null };
  const target = campaignTarget();
  const result = ghJson<{
    fields?: Array<{
      id: string;
      name: string;
      type: string;
      options?: Array<{ id: string; name: string }>;
    }>;
  }>(['project', 'field-list', String(target.project), '--owner', target.owner, '--format', 'json']);
  if (!result.ok) return { field: null, error: result.error };

  // A successful lookup with no Status field is a real negative, not a transient
  // failure, so caching null here is correct.
  const field = result.data.fields?.find((entry) => entry.name === 'Status' && entry.type === 'ProjectV2SingleSelectField') ?? null;
  cache.statusField = field;
  return { field, error: null };
}

function fetchProjectItems(scope: 'recent' | 'fallback'): { items: ProjectItem[]; error: string | null } {
  const limit = scope === 'recent' ? PROJECT_ITEM_LIST_RECENT_LIMIT : PROJECT_ITEM_LIST_FALLBACK_LIMIT;
  const target = campaignTarget();
  const args = ['project', 'item-list', String(target.project), '--owner', target.owner, '--format', 'json', '--limit', limit];
  const result = ghJson<{ items?: ProjectItem[] }>(args);
  if (!result.ok) return { items: [], error: result.error };
  return { items: result.data.items ?? [], error: null };
}

function projectItems(scope: 'recent' | 'fallback' = 'recent'): ProjectItem[] {
  ensureCacheForContext();
  if (cache.items && (cache.items.scope === scope || cache.items.scope === 'fallback')) {
    return cache.items.items;
  }
  const result = fetchProjectItems(scope);
  // Don't cache a failed fetch — leave the cache empty so the next call retries.
  if (result.error) return result.items;
  cache.items = { items: result.items, scope };
  return result.items;
}

export function checkCampaignStatusOptions(): CampaignStatusReport {
  const errors: string[] = [];
  const { view, error: viewError } = projectView();
  const { field, error: fieldError } = projectStatusField();

  if (!view.id) {
    const target = campaignTarget();
    errors.push(`Could not load ${target.owner} Project ${target.project}.${viewError ? ` (${viewError})` : ''}`);
  }
  if (!field) errors.push(`Could not load Campaign Map Status field.${fieldError ? ` (${fieldError})` : ''}`);

  const options = field?.options ?? [];
  const optionNames = new Set(options.map((option) => option.name));
  const expectedNames = CAMPAIGN_STATUSES.map((status) => status.name);

  return {
    checked: errors.length === 0,
    expected: CAMPAIGN_STATUSES,
    missing: expectedNames.filter((name) => !optionNames.has(name)),
    unexpected: options.map((option) => option.name).filter((name) => !expectedNames.includes(name as CampaignStatusName)),
    options,
    projectId: view.id ?? null,
    statusFieldId: field?.id ?? null,
    errors,
  };
}

export function parseIssueRef(value: string) {
  const ref = parseRepoRef(value);
  return { ...ref, label: `${ref.repo}#${ref.number}` };
}

function projectItemForIssue(issue: string) {
  const ref = parseIssueRef(issue);
  const match = (items: ProjectItem[]) =>
    items.find((item) => item.content?.repository === ref.repo && item.content?.number === ref.number) ?? null;

  const recent = match(projectItems('recent'));
  if (recent) return recent;
  if (cache.items?.scope === 'fallback') return null;
  return match(projectItems('fallback'));
}

export function listCampaignIssuesByStatus(status: CampaignStatusName, repo: string | null = null): CampaignProjectIssue[] {
  const matchesRepo = (item: ProjectItem) => !repo || item.content?.repository === repo;
  const filtered = (items: ProjectItem[]) =>
    items.filter((item) => item.status === status && item.content?.repository && item.content?.number && matchesRepo(item));

  let items = filtered(projectItems('recent'));
  if (items.length === 0 && repo && cache.items?.scope !== 'fallback') {
    items = filtered(projectItems('fallback'));
  }

  return items.map((item) => ({
    repo: item.content?.repository ?? '',
    number: item.content?.number ?? 0,
    title: item.content?.title ?? item.title ?? '',
    url: item.content?.url ?? `https://github.com/${item.content?.repository}/issues/${item.content?.number}`,
    status: item.status ?? null,
    labels: item.labels ?? [],
    projectItemId: item.id,
  }));
}

function ensureProjectItem(issue: string): { item: { id: string; content: { repository: string; number: number; url: string } }; added: boolean } {
  const existing = projectItemForIssue(issue);
  if (existing) {
    const ref = parseIssueRef(issue);
    return {
      item: {
        id: existing.id,
        content: {
          repository: existing.content?.repository ?? ref.repo,
          number: existing.content?.number ?? ref.number,
          url: existing.content?.url ?? `https://github.com/${ref.repo}/issues/${ref.number}`,
        },
      },
      added: false,
    };
  }

  const ref = parseIssueRef(issue);
  const url = `https://github.com/${ref.repo}/issues/${ref.number}`;
  const target = campaignTarget();
  const result = ghJson<{ id?: string }>([
    'project',
    'item-add',
    String(target.project),
    '--owner',
    target.owner,
    '--url',
    url,
    '--format',
    'json',
  ]);
  if (!result.ok || !result.data.id) {
    throw new Error(`Could not add ${issue} to Campaign Map.${result.ok ? '' : ` ${result.error}`}`);
  }
  cache.items = undefined;
  return {
    item: { id: result.data.id, content: { repository: ref.repo, number: ref.number, url } },
    added: true,
  };
}

export function setCampaignStatus(issue: string, status: CampaignStatusName, options: { confirm?: boolean; reason?: string | null } = {}): CampaignStatusSetResult {
  if (!CAMPAIGN_STATUSES.some((entry) => entry.name === status)) {
    throw new Error(`Unknown Campaign Map status "${status}".`);
  }
  if (status === 'blockaded' && !options.reason) {
    throw new Error('Moving work to blockaded requires a human-readable --reason.');
  }

  const report = checkCampaignStatusOptions();
  if (report.errors.length > 0 || report.missing.length > 0 || !report.projectId || !report.statusFieldId) {
    throw new Error(`Campaign Map status field is not ready: ${[...report.errors, ...report.missing].join(', ')}`);
  }

  const option = report.options.find((entry) => entry.name === status);
  if (!option) throw new Error(`Campaign Map status option missing: ${status}`);

  const { item, added } = ensureProjectItem(issue);

  if (options.confirm) {
    const result = ghRun([
      'project',
      'item-edit',
      '--id',
      item.id,
      '--project-id',
      report.projectId,
      '--field-id',
      report.statusFieldId,
      '--single-select-option-id',
      option.id,
    ]);
    if (result.status !== 0) throw new Error(`${result.stderr || result.stdout}`.trim());
    if (cache.items) {
      const cached = cache.items.items.find((entry) => entry.id === item.id);
      if (cached) cached.status = status;
    }
  }

  return {
    issue,
    status,
    projectItemId: item.id,
    optionId: option.id,
    applied: options.confirm ?? false,
    added,
    reason: options.reason ?? null,
  };
}
