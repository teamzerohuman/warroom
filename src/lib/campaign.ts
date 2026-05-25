import { spawnSync } from 'node:child_process';
import { parseRepoRef } from './refs.js';

export const CAMPAIGN_OWNER = 'TeamFloPay';
export const CAMPAIGN_PROJECT_NUMBER = 1;

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

function ghJson<T>(args: string[], fallback: T): T {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return fallback;
  return JSON.parse(result.stdout) as T;
}

function projectView() {
  return ghJson<{
    id?: string;
    title?: string;
  }>(['project', 'view', String(CAMPAIGN_PROJECT_NUMBER), '--owner', CAMPAIGN_OWNER, '--format', 'json'], {});
}

function projectStatusField() {
  const fields = ghJson<{
    fields?: Array<{
      id: string;
      name: string;
      type: string;
      options?: Array<{ id: string; name: string }>;
    }>;
  }>(['project', 'field-list', String(CAMPAIGN_PROJECT_NUMBER), '--owner', CAMPAIGN_OWNER, '--format', 'json'], {});

  return fields.fields?.find((field) => field.name === 'Status' && field.type === 'ProjectV2SingleSelectField') ?? null;
}

export function checkCampaignStatusOptions(): CampaignStatusReport {
  const errors: string[] = [];
  const project = projectView();
  const field = projectStatusField();

  if (!project.id) errors.push(`Could not load TeamFloPay Project ${CAMPAIGN_PROJECT_NUMBER}.`);
  if (!field) errors.push('Could not load Campaign Map Status field.');

  const options = field?.options ?? [];
  const optionNames = new Set(options.map((option) => option.name));
  const expectedNames = CAMPAIGN_STATUSES.map((status) => status.name);

  return {
    checked: errors.length === 0,
    expected: CAMPAIGN_STATUSES,
    missing: expectedNames.filter((name) => !optionNames.has(name)),
    unexpected: options.map((option) => option.name).filter((name) => !expectedNames.includes(name as CampaignStatusName)),
    options,
    projectId: project.id ?? null,
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
  const items = ghJson<{
    items?: Array<{
      id: string;
      content?: {
        repository?: string;
        number?: number;
        url?: string;
      };
    }>;
  }>(['project', 'item-list', String(CAMPAIGN_PROJECT_NUMBER), '--owner', CAMPAIGN_OWNER, '--format', 'json', '--limit', '100'], {});

  return items.items?.find((item) => item.content?.repository === ref.repo && item.content?.number === ref.number) ?? null;
}

export function listCampaignIssuesByStatus(status: CampaignStatusName): CampaignProjectIssue[] {
  const items = ghJson<{
    items?: Array<{
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
    }>;
  }>(['project', 'item-list', String(CAMPAIGN_PROJECT_NUMBER), '--owner', CAMPAIGN_OWNER, '--format', 'json', '--limit', '100'], {});

  return (items.items ?? [])
    .filter((item) => item.status === status && item.content?.repository && item.content?.number)
    .map((item) => ({
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
  const added = ghJson<{ id?: string }>(
    ['project', 'item-add', String(CAMPAIGN_PROJECT_NUMBER), '--owner', CAMPAIGN_OWNER, '--url', url, '--format', 'json'],
    {}
  );
  if (!added.id) throw new Error(`Could not add ${issue} to Campaign Map.`);
  return {
    item: { id: added.id, content: { repository: ref.repo, number: ref.number, url } },
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
    const result = spawnSync(
      'gh',
      [
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
      ],
      { encoding: 'utf8' }
    );
    if (result.status !== 0) throw new Error(`${result.stderr || result.stdout}`.trim());
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
