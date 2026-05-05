import { spawnSync } from 'node:child_process';
import { createRunArtifact, type RunArtifact } from '../lib/artifacts.js';
import { setCampaignStatus, type CampaignStatusSetResult } from '../lib/campaign.js';
import { getAdapterInvocation, runAdapter } from '../lib/env.js';
import { getRepoHealth, loadRepoManifest, runGit } from '../lib/repos.js';
import { buildSpecialistContext } from '../lib/specialist-context.js';
import { parseIssueRef } from './issues.js';

export type PrOptions = {
  issue?: string;
  pr?: string;
  dryRun?: boolean;
  writeArtifact?: boolean;
  confirm?: boolean;
  base?: string;
  confirmStatus?: boolean;
  summary?: string;
  postSummary?: boolean;
  confirmSummary?: boolean;
  cleanupLocal?: boolean;
  confirmCleanup?: boolean;
  checkInMinutes?: number;
  issueTitle?: string;
  issueUrl?: string;
};

export type MergeReadiness = {
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  isDraft: boolean | null;
  checks: Array<{
    name: string;
    state: string;
  }>;
  blocked: string[];
};

export type SummaryPostResult = {
  target: 'pr' | 'issue';
  ref: string;
  applied: boolean;
  url: string | null;
  reason: string | null;
  error: string | null;
};

export type LocalCleanupResult = {
  repo: string;
  path: string | null;
  currentBranch: string | null;
  targetBranch: string | null;
  clean: boolean | null;
  applied: boolean;
  blocked: string[];
  messages: string[];
};

export type PrPlanResult = {
  prompt: string;
  artifact: RunArtifact | null;
  launched: boolean;
  adapterCommand: string | null;
  action: 'engage' | 'review' | 'merge';
  campaignStatus: CampaignStatusSetResult | null;
  mergeReadiness?: MergeReadiness;
  summary?: string;
  summaryPosts?: SummaryPostResult[];
  merged?: boolean;
  localCleanup?: LocalCleanupResult | null;
  contextSummary?: {
    promptCharacters: number;
    changedFiles?: number;
    comments?: number;
    reviews?: number;
    checks?: number;
    checkInMinutes?: number;
  };
  adapterCwd?: string | null;
  launchError?: string | null;
};

function ghJson<T>(args: string[], fallback: T): T {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return fallback;
  return JSON.parse(result.stdout) as T;
}

function repoEntryForGitHub(workspaceRoot: string, githubRepo: string) {
  const manifest = loadRepoManifest(workspaceRoot);
  return manifest.repos.find((entry) => entry.github === githubRepo) ?? null;
}

function repoWorkspaceForGitHub(workspaceRoot: string, githubRepo: string) {
  const repo = repoEntryForGitHub(workspaceRoot, githubRepo);
  if (!repo) return workspaceRoot;

  const health = getRepoHealth(workspaceRoot, repo);
  return health.checkedOut ? health.resolvedPath : workspaceRoot;
}

function repoIdForGitHub(workspaceRoot: string, githubRepo: string) {
  return repoEntryForGitHub(workspaceRoot, githubRepo)?.id ?? null;
}

function parsePrRef(value: string) {
  const match = value.match(/^([^#]+)#(\d+)$/);
  if (!match) throw new Error('PR references must use owner/repo#number, for example TeamFloPay/sdk#12.');
  return { repo: match[1], number: Number(match[2]) };
}

function truncateText(value: string | undefined, limit = 6000) {
  if (!value) return '(not available)';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[Truncated by War Room to keep the handoff scoped. Re-run with direct GitHub inspection if more context is needed.]`;
}

function slugBranchPart(value: string | undefined, fallback: string) {
  const slug = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function featureBranchForIssue(ref: { repo: string; number: number }, title: string | undefined) {
  return `warroom/${ref.number}-${slugBranchPart(title, ref.repo.split('/').pop() ?? 'issue')}`;
}

function summarizeList<T>(values: T[] | undefined, map: (value: T) => string, limit = 12) {
  const rows = (values ?? []).slice(0, limit).map(map);
  if ((values ?? []).length > limit) rows.push(`[${(values ?? []).length - limit} more omitted]`);
  return rows.length ? rows.join('\n') : 'none';
}

function ghComment(args: string[]): { url: string | null; error: string | null } {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    return { url: null, error: result.stderr.trim() || `gh exited ${result.status ?? 'unknown'}` };
  }
  return { url: result.stdout.trim() || null, error: null };
}

function buildMergeReadiness(pr: {
  mergeStateStatus?: string;
  reviewDecision?: string;
  isDraft?: boolean;
  statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string; workflowName?: string }>;
}): MergeReadiness {
  const checks = (pr.statusCheckRollup ?? [])
    .filter((check) => check.name || check.status || check.conclusion || check.workflowName)
    .map((check) => ({
      name: check.workflowName ? `${check.name ?? 'unknown'} (${check.workflowName})` : (check.name ?? 'unknown'),
      state: check.conclusion ?? check.status ?? 'unknown',
    }));
  const blocked: string[] = [];
  const mergeStateStatus = pr.mergeStateStatus ?? null;
  const reviewDecision = pr.reviewDecision ?? null;

  if (pr.isDraft === true) blocked.push('PR is still marked as draft.');
  if (mergeStateStatus && ['BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN'].includes(mergeStateStatus)) {
    blocked.push(`Merge state is ${mergeStateStatus}.`);
  }
  if (reviewDecision && ['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(reviewDecision)) {
    blocked.push(`Review decision is ${reviewDecision}.`);
  }

  for (const check of checks) {
    if (['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'TIMED_OUT'].includes(check.state)) {
      blocked.push(`Check failed: ${check.name} (${check.state}).`);
    } else if (!['COMPLETED', 'SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.state)) {
      blocked.push(`Check is not complete: ${check.name} (${check.state}).`);
    }
  }

  return {
    mergeStateStatus,
    reviewDecision,
    isDraft: typeof pr.isDraft === 'boolean' ? pr.isDraft : null,
    checks,
    blocked,
  };
}

function buildVictorySummary(
  prRef: string,
  issueRef: string | undefined,
  pr: { title?: string; url?: string; headRefName?: string; baseRefName?: string },
  readiness: MergeReadiness,
  operatorSummary: string | undefined
) {
  const defaultOutcome =
    readiness.blocked.length === 0
      ? 'Ready for final merge and cleanup through `warroom pr merge`.'
      : 'Preflight is blocked. Resolve merge-readiness blockers before marking victory.';
  const lines = [
    '## Victory summary',
    '',
    `PR: ${prRef}`,
    `Title: ${pr.title ?? 'unknown'}`,
    `URL: ${pr.url ?? 'unknown'}`,
    `Branch: ${pr.headRefName ?? 'unknown'} -> ${pr.baseRefName ?? 'unknown'}`,
  ];

  if (issueRef) lines.push(`Linked issue: ${issueRef}`);

  lines.push(
    '',
    'Outcome:',
    operatorSummary ?? defaultOutcome,
    '',
    'Merge readiness:',
    readiness.blocked.length === 0 ? 'No blockers detected by War Room preflight.' : readiness.blocked.map((blocker) => `- ${blocker}`).join('\n'),
    '',
    'Checks:',
    readiness.checks.length === 0 ? 'No status checks were returned by GitHub.' : readiness.checks.map((check) => `- ${check.name}: ${check.state}`).join('\n')
  );

  return lines.join('\n');
}

function buildSummaryPostPlan(options: PrOptions, summary: string, readiness: MergeReadiness): SummaryPostResult[] {
  if (!options.pr || !options.postSummary) return [];

  const targets: Array<{ target: 'pr' | 'issue'; ref: string }> = [{ target: 'pr', ref: options.pr }];
  if (options.issue) targets.push({ target: 'issue', ref: options.issue });

  if (!options.confirmSummary) {
    return targets.map((target) => ({
      ...target,
      applied: false,
      url: null,
      reason: 'Pass --confirm-summary to post victory summary comments.',
      error: null,
    }));
  }

  if (readiness.blocked.length > 0) {
    return targets.map((target) => ({
      ...target,
      applied: false,
      url: null,
      reason: 'Merge readiness blockers are present.',
      error: null,
    }));
  }

  return targets.map((target) => {
    if (target.target === 'pr') {
      const ref = parsePrRef(target.ref);
      const result = ghComment(['pr', 'comment', String(ref.number), '--repo', ref.repo, '--body', summary]);
      return {
        ...target,
        applied: result.error === null,
        url: result.url,
        reason: null,
        error: result.error,
      };
    }

    const ref = parseIssueRef(target.ref);
    const result = ghComment(['issue', 'comment', String(ref.number), '--repo', ref.repo, '--body', summary]);
    return {
      ...target,
      applied: result.error === null,
      url: result.url,
      reason: null,
      error: result.error,
    };
  });
}

function planLocalCleanup(
  workspaceRoot: string,
  prRepo: string,
  headRefName: string | undefined,
  baseRefName: string | undefined,
  options: PrOptions
): LocalCleanupResult | null {
  if (!options.cleanupLocal) return null;

  const manifest = loadRepoManifest(workspaceRoot);
  const repoEntry = manifest.repos.find((entry) => entry.github === prRepo);
  const targetBranch = baseRefName ?? manifest.defaults.default_branch;

  if (!repoEntry) {
    return {
      repo: prRepo,
      path: null,
      currentBranch: null,
      targetBranch,
      clean: null,
      applied: false,
      blocked: [`No mapped child repo found for ${prRepo}.`],
      messages: [],
    };
  }

  const repo = getRepoHealth(workspaceRoot, repoEntry);
  const blocked: string[] = [];
  const messages: string[] = [];

  if (!repo.checkedOut) blocked.push(`Repo checkout is missing: ${repo.resolvedPath}`);
  if (repo.clean === false) blocked.push(`Repo checkout is dirty: ${repo.resolvedPath}`);
  if (!repo.branch) blocked.push('Repo current branch is unknown.');
  if (repo.branch && headRefName && repo.branch !== headRefName && repo.branch !== targetBranch) {
    blocked.push(`Repo is on ${repo.branch}, not PR branch ${headRefName} or target branch ${targetBranch}.`);
  }
  if (repo.branch === targetBranch) messages.push(`Already on ${targetBranch}.`);

  let applied = false;
  if (options.confirmCleanup && blocked.length === 0 && repo.branch !== targetBranch) {
    const switched = runGit(repo.resolvedPath, ['switch', targetBranch]);
    if (switched.status !== 0) {
      blocked.push(switched.stderr || `git switch ${targetBranch} failed with exit ${switched.status ?? 'unknown'}.`);
    } else {
      applied = true;
      messages.push(`Switched local checkout to ${targetBranch}.`);
    }
  } else if (!options.confirmCleanup && repo.branch !== targetBranch) {
    messages.push('Pass --confirm-cleanup to switch the local checkout when the preflight is clear.');
  }

  return {
    repo: repo.github,
    path: repo.resolvedPath,
    currentBranch: repo.branch,
    targetBranch,
    clean: repo.clean,
    applied,
    blocked,
    messages,
  };
}

export function runPrEngage(workspaceRoot: string, options: PrOptions): PrPlanResult {
  if (!options.issue) throw new Error('warroom pr engage requires --issue owner/repo#number.');
  const ref = parseIssueRef(options.issue);
  const issue = ghJson<{
    title?: string;
    body?: string;
    url?: string;
    comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
  }>(
    ['issue', 'view', String(ref.number), '--repo', ref.repo, '--json', 'title,body,url,comments'],
    {}
  );
  const title = issue.title ?? options.issueTitle ?? 'unknown';
  const featureBranch = featureBranchForIssue(ref, title);
  const issueComments = summarizeList(issue.comments, (comment) => {
    const author = comment.author?.login ?? 'unknown';
    return `- ${author} at ${comment.createdAt ?? 'unknown'}: ${truncateText(comment.body, 1000)}`;
  });
  const prompt = [
    `War Room implementation handoff for ${options.issue}`,
    '',
    `Title: ${title}`,
    `URL: ${issue.url ?? options.issueUrl ?? `https://github.com/${ref.repo}/issues/${ref.number}`}`,
    `Base branch: ${options.base ?? 'main'} (use stage only as the second target option after validation)`,
    `Feature branch: ${featureBranch}`,
    '',
    buildSpecialistContext(workspaceRoot, ref.repo),
    '',
    'Mission:',
    '- Implement the issue now. Do not stop after writing a plan, preflight, analysis note, or handoff markdown.',
    `- Start from ${options.base ?? 'main'} and create or switch to feature branch ${featureBranch}.`,
    '- Read and follow the repository AGENTS.md plus referenced development/testing instructions before editing.',
    '- Use the existing issue body and GitHub discussion as the accepted triage context.',
    '- Make the required code, test, and product documentation changes in this owning child repo.',
    '- Do not create standalone preflight, plan, or analysis markdown files unless the issue specifically asks for product documentation.',
    '- Run the most relevant validation commands for the changed surface; if the repo defines a full go/check command, run it before finishing when feasible.',
    '- Commit the implementation on the feature branch after validation passes. If validation cannot pass, leave the code changes in place and explain the blocker.',
    '- Do not merge. Do not open a PR unless the repository workflow explicitly requires it after a completed, validated commit.',
    '',
    'Issue body:',
    truncateText(issue.body),
    '',
    'GitHub discussion and triage comments:',
    issueComments,
  ].join('\n');
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-engage', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(options, null, 2),
      })
    : null;
  const adapterCwd = repoWorkspaceForGitHub(workspaceRoot, ref.repo);
  const adapterRepoId = repoIdForGitHub(workspaceRoot, ref.repo);
  const adapterCommand = getAdapterInvocation(workspaceRoot, adapterCwd, { repoId: adapterRepoId }).display;
  const campaignStatus = setCampaignStatus(options.issue, 'battlefield-active', { confirm: options.confirmStatus });

  const contextSummary = { promptCharacters: prompt.length, comments: issue.comments?.length ?? 0 };
  if (options.dryRun !== false) {
    return { prompt, artifact, launched: false, adapterCommand, action: 'engage', campaignStatus, contextSummary, adapterCwd };
  }
  const launch = runAdapter(workspaceRoot, prompt, { cwd: adapterCwd, repoId: adapterRepoId });
  return {
    prompt,
    artifact,
    launched: launch.launched,
    adapterCommand: launch.invocation.display,
    action: 'engage',
    campaignStatus,
    contextSummary,
    adapterCwd,
    launchError: launch.error,
  };
}

export function runPrReview(workspaceRoot: string, options: PrOptions): PrPlanResult {
  if (!options.pr) throw new Error('warroom pr review requires --pr owner/repo#number.');
  const ref = parsePrRef(options.pr);
  const pr = ghJson<{
    title?: string;
    body?: string;
    url?: string;
    headRefName?: string;
    baseRefName?: string;
    files?: Array<{ path?: string; additions?: number; deletions?: number }>;
    comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
    latestReviews?: Array<{ author?: { login?: string }; state?: string; body?: string; submittedAt?: string }>;
    statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string; workflowName?: string }>;
  }>(
    [
      'pr',
      'view',
      String(ref.number),
      '--repo',
      ref.repo,
      '--json',
      'title,body,url,headRefName,baseRefName,files,comments,latestReviews,statusCheckRollup',
    ],
    {}
  );
  const files = summarizeList(
    pr.files,
    (file) => `- ${file.path ?? 'unknown'} (+${file.additions ?? 0}/-${file.deletions ?? 0})`
  );
  const comments = summarizeList(pr.comments, (comment) => {
    const author = comment.author?.login ?? 'unknown';
    return `- ${author} at ${comment.createdAt ?? 'unknown'}: ${truncateText(comment.body, 500)}`;
  });
  const reviews = summarizeList(pr.latestReviews, (review) => {
    const author = review.author?.login ?? 'unknown';
    return `- ${review.state ?? 'UNKNOWN'} by ${author} at ${review.submittedAt ?? 'unknown'}: ${truncateText(review.body, 500)}`;
  });
  const checks = summarizeList(pr.statusCheckRollup, (check) => {
    const state = check.conclusion ?? check.status ?? 'unknown';
    const workflow = check.workflowName ? ` (${check.workflowName})` : '';
    return `- ${check.name ?? 'unknown'}${workflow}: ${state}`;
  });
  const checkInMinutes = options.checkInMinutes ?? 60;
  const prompt = [
    `War Room PR review handoff for ${options.pr}`,
    '',
    `Title: ${pr.title ?? 'unknown'}`,
    `URL: ${pr.url ?? `https://github.com/${ref.repo}/pull/${ref.number}`}`,
    `Branch: ${pr.headRefName ?? 'unknown'} -> ${pr.baseRefName ?? 'unknown'}`,
    '',
    buildSpecialistContext(workspaceRoot, ref.repo),
    '',
    'Required review loop:',
    '- Gather current GitHub and CodeRabbit feedback before editing.',
    '- Reply to each actionable comment with an outcome marker after handling it.',
    '- Pause on vague, repeated, or circular feedback.',
    '- Keep context scoped to changed files, comments, and repo instructions.',
    '- Use eyes-in-progress replies before starting comment-by-comment feedback work when posting is explicitly confirmed.',
    '- Reply with ✅ for completed feedback and ❌ plus a concise reason when feedback is not actionable.',
    `- Check back every ${checkInMinutes} minutes while the skirmish remains active, then continue or retreat through warroom abort.`,
    '- Use warroom abort for preservation-first recovery if the loop needs to stop.',
    '',
    'Changed files:',
    files,
    '',
    'Latest reviews:',
    reviews,
    '',
    'Comments:',
    comments,
    '',
    'Checks:',
    checks,
    '',
    'PR body:',
    truncateText(pr.body),
  ].join('\n');
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-review', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(options, null, 2),
      })
    : null;
  const adapterCwd = repoWorkspaceForGitHub(workspaceRoot, ref.repo);
  const adapterRepoId = repoIdForGitHub(workspaceRoot, ref.repo);
  const adapterCommand = getAdapterInvocation(workspaceRoot, adapterCwd, { repoId: adapterRepoId }).display;
  const campaignStatus = options.issue
    ? setCampaignStatus(options.issue, 'skirmish', { confirm: options.confirmStatus })
    : null;
  const contextSummary = {
    promptCharacters: prompt.length,
    changedFiles: pr.files?.length ?? 0,
    comments: pr.comments?.length ?? 0,
    reviews: pr.latestReviews?.length ?? 0,
    checks: pr.statusCheckRollup?.length ?? 0,
    checkInMinutes,
  };

  if (options.dryRun !== false) {
    return { prompt, artifact, launched: false, adapterCommand, action: 'review', campaignStatus, contextSummary, adapterCwd };
  }
  const launch = runAdapter(workspaceRoot, prompt, { cwd: adapterCwd, repoId: adapterRepoId });
  return {
    prompt,
    artifact,
    launched: launch.launched,
    adapterCommand: launch.invocation.display,
    action: 'review',
    campaignStatus,
    contextSummary,
    adapterCwd,
    launchError: launch.error,
  };
}

export function runPrMerge(workspaceRoot: string, options: PrOptions): PrPlanResult {
  if (!options.pr) throw new Error('warroom pr merge requires --pr owner/repo#number.');
  const ref = parsePrRef(options.pr);
  const pr = ghJson<{
    title?: string;
    url?: string;
    mergeStateStatus?: string;
    reviewDecision?: string;
    headRefName?: string;
    baseRefName?: string;
    isDraft?: boolean;
    statusCheckRollup?: Array<{ name?: string; status?: string; conclusion?: string; workflowName?: string }>;
  }>(
    [
      'pr',
      'view',
      String(ref.number),
      '--repo',
      ref.repo,
      '--json',
      'title,url,mergeStateStatus,reviewDecision,headRefName,baseRefName,isDraft,statusCheckRollup',
    ],
    {}
  );
  const readiness = buildMergeReadiness(pr);
  const summary = buildVictorySummary(options.pr, options.issue, pr, readiness, options.summary);
  const prompt = [
    `War Room PR merge preflight for ${options.pr}`,
    '',
    `Title: ${pr.title ?? 'unknown'}`,
    `URL: ${pr.url ?? `https://github.com/${ref.repo}/pull/${ref.number}`}`,
    `Branch: ${pr.headRefName ?? 'unknown'} -> ${pr.baseRefName ?? 'unknown'}`,
    `Merge state: ${pr.mergeStateStatus ?? 'unknown'}`,
    `Review decision: ${pr.reviewDecision ?? 'unknown'}`,
    `Draft: ${pr.isDraft === undefined ? 'unknown' : pr.isDraft ? 'yes' : 'no'}`,
    '',
    buildSpecialistContext(workspaceRoot, ref.repo),
    '',
    'Readiness blockers:',
    readiness.blocked.length ? readiness.blocked.map((blocker) => `- ${blocker}`).join('\n') : 'none',
    '',
    'Checks:',
    readiness.checks.length ? readiness.checks.map((check) => `- ${check.name}: ${check.state}`).join('\n') : 'none',
    '',
    'Required merge checks:',
    '- Confirm all review and CodeRabbit feedback loops are resolved.',
    '- Confirm validation status and target branch.',
    '- Merge only after explicit confirmation.',
    '- Post issue/PR summary and return local checkout to the default branch safely.',
    '',
    'Victory summary:',
    summary,
  ].join('\n');
  let merged = false;

  if (options.confirm) {
    if (readiness.blocked.length > 0) throw new Error(`PR is not merge-ready: ${readiness.blocked.join(' ')}`);
    const result = spawnSync(
      'gh',
      ['pr', 'merge', String(ref.number), '--repo', ref.repo, '--squash', '--delete-branch'],
      { stdio: 'inherit' }
    );
    if (result.status !== 0) throw new Error(`gh pr merge failed with exit ${result.status ?? 'unknown'}.`);
    merged = true;
  }

  const summaryPosts = buildSummaryPostPlan(options, summary, readiness);
  const localCleanup = planLocalCleanup(workspaceRoot, ref.repo, pr.headRefName, pr.baseRefName, options);
  const campaignStatus = options.issue
    ? setCampaignStatus(options.issue, 'victory', { confirm: options.confirmStatus && readiness.blocked.length === 0 })
    : null;
  const artifact = options.writeArtifact
    ? createRunArtifact(workspaceRoot, 'pr-merge', {
        'prompt.md': prompt,
        'input.json': JSON.stringify(options, null, 2),
        'pr.json': JSON.stringify(pr, null, 2),
        'readiness.json': JSON.stringify(readiness, null, 2),
        'summary.md': summary,
        'summary-posts.json': JSON.stringify(summaryPosts, null, 2),
        'local-cleanup.json': JSON.stringify(localCleanup, null, 2),
      })
    : null;

  return {
    prompt,
    artifact,
    launched: false,
    adapterCommand: null,
    action: 'merge',
    campaignStatus,
    mergeReadiness: readiness,
    summary,
    summaryPosts,
    merged,
    localCleanup,
    contextSummary: { promptCharacters: prompt.length, checks: readiness.checks.length },
  };
}
