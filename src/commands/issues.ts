import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRunArtifact, type RunArtifact } from '../lib/artifacts.js';
import { resolveAllyIssueRepo } from '../lib/allies.js';
import { listCampaignIssuesByStatus, setCampaignStatus, type CampaignStatusSetResult } from '../lib/campaign.js';
import { getInteractiveAdapterInvocation, runInteractiveAdapter } from '../lib/env.js';
import { getRepoHealth, loadRepoManifest } from '../lib/repos.js';
import { buildSpecialistContext } from '../lib/specialist-context.js';

export type IssueRef = {
  repo: string;
  number: number;
};

export type IssueSummary = IssueRef & {
  title: string;
  url: string;
  labels: string[];
  status?: string | null;
  projectItemId?: string;
};

export type IssueListResult = {
  label?: string;
  status?: string;
  repo?: string;
  source: 'campaign' | 'labels';
  issues: IssueSummary[];
};

export type IssueHandoffResult = {
  prompt: string;
  artifact: RunArtifact | null;
  launched: boolean;
  adapterCommand: string;
  campaignStatus: CampaignStatusSetResult | null;
  contextSummary: {
    promptCharacters: number;
    changedFiles?: number;
    comments?: number;
    reviews?: number;
    checks?: number;
    checkInMinutes?: number;
  };
  launchError?: string | null;
};

export type IssueTriageOptions = {
  issue?: string;
  label?: string;
  markReady?: boolean;
  confirmStatus?: boolean;
  dryRun?: boolean;
  writeArtifact?: boolean;
};

export type IssueNextOptions = {
  label?: string;
  currentPath?: string;
  allRepos?: boolean;
};

function ghJson<T>(args: string[], fallback: T): T {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return fallback;
  return JSON.parse(result.stdout) as T;
}

export function parseIssueRef(value: string): IssueRef {
  const match = value.match(/^([^#]+)#(\d+)$/);
  if (!match) throw new Error('Issue references must use owner/repo#number, for example TeamFloPay/infra#4.');
  return { repo: match[1], number: Number(match[2]) };
}

function labelsFromGh(labels: Array<{ name?: string }>) {
  return labels.map((label) => label.name).filter((label): label is string => Boolean(label));
}

function truncateText(value: string | undefined, limit = 6000) {
  if (!value) return '(not available)';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[Truncated by War Room to keep the handoff scoped. Re-run with direct GitHub inspection if more issue body context is needed.]`;
}

function containsPath(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function repoForCurrentPath(workspaceRoot: string, currentPath: string | undefined) {
  if (!currentPath) return null;

  const resolved = path.resolve(currentPath);
  return loadRepoManifest(workspaceRoot).repos
    .map((entry) => getRepoHealth(workspaceRoot, entry))
    .filter((repo) => repo.checkedOut && containsPath(repo.resolvedPath, resolved))
    .sort((left, right) => right.resolvedPath.length - left.resolvedPath.length)[0] ?? null;
}

export function listIssuesByLabel(workspaceRoot: string, label: string, repoFilter: string | null = null): IssueListResult {
  const manifest = loadRepoManifest(workspaceRoot);
  const issues: IssueSummary[] = [];

  for (const repo of manifest.repos.filter((entry) => !repoFilter || entry.github === repoFilter)) {
    const rows = ghJson<Array<{ number: number; title: string; url: string; labels: Array<{ name?: string }> }>>(
      ['issue', 'list', '--repo', repo.github, '--state', 'open', '--label', label, '--json', 'number,title,url,labels'],
      []
    );
    for (const row of rows) {
      issues.push({
        repo: repo.github,
        number: row.number,
        title: row.title,
        url: row.url,
        labels: labelsFromGh(row.labels),
      });
    }
  }

  return { label, repo: repoFilter ?? undefined, source: 'labels', issues };
}

function issueContext(ref: IssueRef) {
  return ghJson<{ title?: string; body?: string; url?: string; labels?: Array<{ name?: string }> }>(
    ['issue', 'view', String(ref.number), '--repo', ref.repo, '--json', 'title,body,url,labels'],
    {}
  );
}

function buildTriagePrompt(workspaceRoot: string, ref: IssueRef) {
  const issue = issueContext(ref);
  const labels = labelsFromGh(issue.labels ?? []);
  return [
    `War Room issue triage handoff for ${ref.repo}#${ref.number}`,
    '',
    `Title: ${issue.title ?? 'unknown'}`,
    `URL: ${issue.url ?? `https://github.com/${ref.repo}/issues/${ref.number}`}`,
    `Labels: ${labels.length ? labels.join(', ') : 'none'}`,
    '',
    buildSpecialistContext(workspaceRoot, ref.repo),
    '',
    'Triage mode contract:',
    '- This is planning and issue triage only. Do not implement code.',
    '- Do not edit repository files, create branches, commit changes, open pull requests, run formatters, or create implementation artifacts.',
    '- Use read-only inspection only: GitHub issue/PR context, docs, safe logs, and read-only provider/API checks when credentials are available.',
    '- Treat client data, secrets, payment details, private URLs, and raw PII as confidential. Do not copy them into GitHub comments or local files.',
    '- If Codex offers a Plan mode, stay in Plan mode for this session. Do not switch into implementation mode.',
    '',
    'Interactive triage workflow:',
    '- Use @grill-me: ask blocking clarification questions one at a time and wait for the user answer before finalizing the plan.',
    '- If a question can be answered safely by read-only investigation, do that investigation and summarize only non-sensitive facts.',
    '- Stop when the issue has a clear owner repo, problem statement, acceptance criteria, risks, dependencies, and validation commands.',
    '',
    'Goal:',
    '- Produce a compact implementation-ready battle plan, but do not implement it.',
    '- Post the final triage notes back to this GitHub issue using [@github](plugin://github@openai-curated) or `gh issue comment`.',
    '- The GitHub issue comment must include: owner repo, diagnosis or remaining unknowns, acceptance criteria, implementation plan, validation commands, dependencies/blockers, and a concise safe client-facing summary when relevant.',
    '- After posting the issue comment, tell the user whether the issue is ready to move to `ready-to-engage` or what blocker remains.',
    '- Keep context scoped; ask for more information if needed.',
    '',
    'Issue body:',
    truncateText(issue.body),
  ].join('\n');
}

function repoEntryForGitHub(workspaceRoot: string, githubRepo: string) {
  const manifest = loadRepoManifest(workspaceRoot);
  return manifest.repos.find((entry) => entry.github === githubRepo) ?? null;
}

function repoWorkspaceForGitHub(workspaceRoot: string, githubRepo: string) {
  const repo = repoEntryForGitHub(workspaceRoot, githubRepo);
  if (repo) {
    const health = getRepoHealth(workspaceRoot, repo);
    return health.checkedOut ? health.resolvedPath : workspaceRoot;
  }

  const allyIssueRepo = resolveAllyIssueRepo(workspaceRoot, githubRepo);
  return allyIssueRepo?.issueRepoCheckedOut ? allyIssueRepo.issueRepoPath : workspaceRoot;
}

export function runIssueNext(workspaceRoot: string, options: IssueNextOptions | string = {}) {
  const label = typeof options === 'string' ? options : options.label ?? 'ready-to-engage';
  const currentRepo = typeof options === 'string' || options.allRepos ? null : repoForCurrentPath(workspaceRoot, options.currentPath);
  const repoFilter = currentRepo?.github ?? null;
  const campaignIssues = listIssuesByCampaignStatus('ready-to-engage');
  const issues = campaignIssues.filter((issue) => !repoFilter || issue.repo === repoFilter);
  if (campaignIssues.length > 0) return { status: 'ready-to-engage', repo: repoFilter ?? undefined, source: 'campaign' as const, issues };
  return listIssuesByLabel(workspaceRoot, label, repoFilter);
}

function listIssuesByCampaignStatus(status: 'needs-triage' | 'ready-to-engage') {
  return listCampaignIssuesByStatus(status).map((issue) => ({
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    labels: issue.labels,
    status: issue.status,
    projectItemId: issue.projectItemId,
  }));
}

export function runIssueTriage(workspaceRoot: string, options: IssueTriageOptions = {}): IssueListResult | IssueHandoffResult {
  const label = options.label ?? 'needs-triage';
  if (!options.issue) {
    const issues = listIssuesByCampaignStatus('needs-triage');
    if (issues.length > 0) return { status: 'needs-triage', source: 'campaign' as const, issues };
    return listIssuesByLabel(workspaceRoot, label);
  }

  const ref = parseIssueRef(options.issue);
  const prompt = buildTriagePrompt(workspaceRoot, ref);
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'issue-triage', {
        'prompt.md': prompt,
        'input.json': JSON.stringify({ issue: options.issue, label }, null, 2),
      })
    : null;
  const adapterCwd = repoWorkspaceForGitHub(workspaceRoot, ref.repo);
  const adapterCommand = getInteractiveAdapterInvocation(workspaceRoot, adapterCwd).display;
  const campaignStatus = options.markReady
    ? setCampaignStatus(options.issue, 'ready-to-engage', { confirm: options.confirmStatus })
    : null;
  const contextSummary = { promptCharacters: prompt.length };

  if (options.dryRun !== false) {
    return { prompt, artifact, launched: false, adapterCommand, campaignStatus, contextSummary };
  }

  const launch = runInteractiveAdapter(workspaceRoot, prompt, { cwd: adapterCwd });
  return { prompt, artifact, launched: launch.launched, adapterCommand: launch.invocation.display, campaignStatus, contextSummary, launchError: launch.error };
}
