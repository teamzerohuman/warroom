import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AdapterInvocation, AdapterReportedUsage } from './env.js';

export type LlmUsageContext = {
  issue?: string | null;
  command: string;
  stage: string;
  repo?: string | null;
  runDir?: string | null;
  commandRunId?: string | null;
  taskTitle?: string | null;
};

export type LlmUsageEntry = {
  id: string;
  timestamp: string;
  taskTitle: string | null;
  issue: string | null;
  command: string;
  stage: string;
  repo: string | null;
  cwd: string | null;
  adapter: string;
  model: string | null;
  reasoningEffort: string | null;
  mode: 'foreground' | 'interactive';
  commandDisplay: string;
  commandRunId: string | null;
  runDir: string | null;
  status: 'succeeded' | 'failed';
  exitStatus: number | null;
  signal: string | null;
  error: string | null;
  promptCharacters: number;
  outputCharacters: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimated: boolean;
  usageSource: 'adapter' | 'estimated' | 'mixed';
  costUsd: number | null;
  adapterReportedCostUsd: number | null;
  sessionId: string | null;
  costUnavailableReason: string | null;
  migratedFromRunDir?: string | null;
};

export type LlmUsageLedger = {
  schemaVersion: 1;
  issue: string;
  updatedAt: string;
  entries: LlmUsageEntry[];
};

export type LlmRunUsageFile = {
  schemaVersion: 1;
  updatedAt: string;
  entries: LlmUsageEntry[];
};

export type LlmUsageSummary = {
  issue: string;
  ledgerPath: string;
  summaryPath: string;
  entries: number;
  failedEntries: number;
  estimatedEntries: number;
  unknownOutputEntries: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  knownTotalTokens: number;
  totalTokensExact: boolean;
  costUsd: number | null;
  costUnavailableReasons: string[];
  models: string[];
};

type PricingModel = {
  inputPerMillion?: number | null;
  cachedInputPerMillion?: number | null;
  outputPerMillion?: number | null;
  notes?: string;
};

type PricingFile = {
  currency?: string;
  effectiveDate?: string;
  models?: Record<string, PricingModel | undefined>;
};

type ParsedTokenUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  found: boolean;
};

const SCHEMA_VERSION = 1 as const;

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '');
}

export function createUsageCommandRunId(command: string) {
  return `${safeTimestamp()}-${command}-${Math.random().toString(36).slice(2, 8)}`;
}

export function issueUsageKey(issue: string) {
  return issue.replace(/[^A-Za-z0-9]+/g, '__').replace(/^_+|_+$/g, '') || 'unknown';
}

export function issueUsagePaths(workspaceRoot: string, issue: string) {
  const dir = path.join(workspaceRoot, '.warroom', 'runs', 'issues', issueUsageKey(issue));
  return {
    dir,
    ledgerPath: path.join(dir, 'usage-ledger.json'),
    summaryPath: path.join(dir, 'usage-summary.md'),
  };
}

export function llmUsageTaskTitle(context: LlmUsageContext) {
  return context.taskTitle ?? `[${context.issue ?? 'pending-issue'}] ${context.command}/${context.stage}`;
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseTokenNumber(raw: string) {
  const value = raw.trim().replace(/\s+/g, '');
  if (!value) return null;
  if (/^\d{1,3}([.,]\d{3})+$/.test(value)) {
    return Number(value.replace(/[.,]/g, ''));
  }
  const normalized = value.replace(/,/g, '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function firstTokenNumber(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const parsed = match?.[1] ? parseTokenNumber(match[1]) : null;
    if (parsed !== null) return parsed;
  }
  return null;
}

function codexTokenUsageLine(text: string) {
  return text.match(/Token usage:[^\r\n]*/i)?.[0] ?? '';
}

function parseAdapterUsage(text: string): ParsedTokenUsage {
  const codexUsage = codexTokenUsageLine(text);
  const inputTokens = firstTokenNumber(text, [
    /\binput=([\d.,]+)/i,
    /\binput\s+tokens?\b[^0-9]*([\d.,]+)/i,
    /\bprompt\s+tokens?\b[^0-9]*([\d.,]+)/i,
  ]);
  const cachedInputTokens = firstTokenNumber(codexUsage, [
    /\(\+\s*([\d.,]+)\s+cached\)/i,
    /\bcached=([\d.,]+)/i,
  ]) ?? firstTokenNumber(text, [
    /\bcached\s+input\s+tokens?\b[^0-9]*([\d.,]+)/i,
    /\bcached\s+tokens?\b[^0-9]*([\d.,]+)/i,
  ]);
  const outputTokens = firstTokenNumber(text, [
    /\boutput=([\d.,]+)/i,
    /\boutput\s+tokens?\b[^0-9]*([\d.,]+)/i,
    /\bcompletion\s+tokens?\b[^0-9]*([\d.,]+)/i,
  ]);
  const totalTokens = firstTokenNumber(text, [
    /\btotal=([\d.,]+)/i,
    /\btotal\s+tokens?\b[^0-9]*([\d.,]+)/i,
    /\btokens\s+used\b[^0-9]*([\d.,]+)/i,
  ]);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    found: [inputTokens, cachedInputTokens, outputTokens, totalTokens].some((value) => value !== null),
  };
}

function estimateTokensFromCharacters(value: string | null | undefined) {
  if (!value) return null;
  return Math.ceil(value.length / 4);
}

function adapterModel(invocation: AdapterInvocation) {
  const index = invocation.args.indexOf('--model');
  return index === -1 ? null : invocation.args[index + 1] ?? null;
}

function adapterReasoningEffort(invocation: AdapterInvocation) {
  const config = invocation.args.find((arg) => arg.startsWith('model_reasoning_effort='));
  return config?.replace(/^model_reasoning_effort=/, '').replace(/^"|"$/g, '') ?? null;
}

function adapterName(invocation: AdapterInvocation) {
  return path.basename(invocation.command);
}

function pricingPath(workspaceRoot: string) {
  return path.join(workspaceRoot, 'config', 'llm-pricing.json');
}

function readPricing(workspaceRoot: string): PricingFile {
  return readJson<PricingFile>(pricingPath(workspaceRoot), { models: {} });
}

function entryCost(workspaceRoot: string, entry: Omit<LlmUsageEntry, 'costUsd' | 'costUnavailableReason'>) {
  if (entry.adapterReportedCostUsd != null) {
    return { costUsd: Number(entry.adapterReportedCostUsd.toFixed(6)), costUnavailableReason: null };
  }
  const pricing = readPricing(workspaceRoot);
  const model = entry.model;
  if (!model) return { costUsd: null, costUnavailableReason: 'model unknown' };
  const price = pricing.models?.[model];
  if (!price) return { costUsd: null, costUnavailableReason: `pricing missing for ${model}` };

  let cost = 0;
  let pricedBuckets = 0;
  const reasons: string[] = [];

  if (entry.inputTokens === null) {
    reasons.push('input token count unknown');
  } else if (typeof price.inputPerMillion === 'number') {
    cost += (entry.inputTokens / 1_000_000) * price.inputPerMillion;
    pricedBuckets += 1;
  } else {
    reasons.push(`input pricing missing for ${model}`);
  }

  if (entry.cachedInputTokens !== null) {
    const cachedRate =
      typeof price.cachedInputPerMillion === 'number'
        ? price.cachedInputPerMillion
        : typeof price.inputPerMillion === 'number'
          ? price.inputPerMillion
          : null;
    if (cachedRate === null) {
      reasons.push(`cached input pricing missing for ${model}`);
    } else {
      cost += (entry.cachedInputTokens / 1_000_000) * cachedRate;
      pricedBuckets += 1;
    }
  }

  if (entry.outputTokens === null) {
    reasons.push('output token count unknown');
  } else if (typeof price.outputPerMillion === 'number') {
    cost += (entry.outputTokens / 1_000_000) * price.outputPerMillion;
    pricedBuckets += 1;
  } else {
    reasons.push(`output pricing missing for ${model}`);
  }

  if (pricedBuckets === 0) {
    return { costUsd: null, costUnavailableReason: reasons.join('; ') || 'no priced token counts' };
  }

  return {
    costUsd: Number(cost.toFixed(6)),
    costUnavailableReason: reasons.length > 0 ? `partial cost; ${reasons.join('; ')}` : null,
  };
}

function entryWithCurrentCost(workspaceRoot: string, entry: LlmUsageEntry): LlmUsageEntry {
  const normalized: LlmUsageEntry = {
    ...entry,
    taskTitle: entry.taskTitle ?? llmUsageTaskTitle(entry),
    adapterReportedCostUsd: entry.adapterReportedCostUsd ?? null,
    sessionId: entry.sessionId ?? null,
  };
  return {
    ...normalized,
    ...entryCost(workspaceRoot, normalized),
  };
}

function entriesWithCurrentCosts(workspaceRoot: string, entries: LlmUsageEntry[]) {
  return entries.map((entry) => entryWithCurrentCost(workspaceRoot, entry));
}

function buildEntry(
  workspaceRoot: string,
  context: LlmUsageContext,
  invocation: AdapterInvocation,
  prompt: string,
  result: {
    status: number | null;
    signal: NodeJS.Signals | null;
    error: string | null;
    stdout: string | null;
    stderr: string | null;
    outputText: string | null;
    adapterReportedUsage: AdapterReportedUsage | null;
  }
): LlmUsageEntry {
  const timestamp = new Date().toISOString();
  const outputText = [result.stdout, result.stderr, result.outputText].filter((value): value is string => Boolean(value)).join('\n');
  const parsed = parseAdapterUsage(outputText);
  const reported = result.adapterReportedUsage;
  const reportedFound =
    reported !== null &&
    (reported.inputTokens !== null ||
      reported.outputTokens !== null ||
      reported.cachedInputTokens !== null ||
      reported.totalTokens !== null ||
      reported.costUsd !== null);
  const estimatedInputTokens = estimateTokensFromCharacters(prompt);
  const estimatedOutputTokens = estimateTokensFromCharacters(outputText || null);
  const inputTokens = reported?.inputTokens ?? parsed.inputTokens ?? estimatedInputTokens;
  const cachedInputTokens = reported?.cachedInputTokens ?? parsed.cachedInputTokens;
  const outputTokens = reported?.outputTokens ?? parsed.outputTokens ?? estimatedOutputTokens;
  const totalTokens =
    reported?.totalTokens ??
    parsed.totalTokens ??
    (inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens + (cachedInputTokens ?? 0)
      : null);
  const adapterFound = parsed.found || reportedFound;
  const estimated =
    !adapterFound ||
    (reported?.inputTokens ?? parsed.inputTokens) === null ||
    ((reported?.outputTokens ?? parsed.outputTokens) === null && outputTokens !== null) ||
    ((reported?.totalTokens ?? parsed.totalTokens) === null && totalTokens !== null);
  const usageSource: LlmUsageEntry['usageSource'] = !adapterFound ? 'estimated' : estimated ? 'mixed' : 'adapter';
  const baseEntry: Omit<LlmUsageEntry, 'costUsd' | 'costUnavailableReason'> = {
    id: `${timestamp}-${context.command}-${context.stage}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp,
    taskTitle: llmUsageTaskTitle(context),
    issue: context.issue ?? null,
    command: context.command,
    stage: context.stage,
    repo: context.repo ?? null,
    cwd: invocation.cwd ?? null,
    adapter: adapterName(invocation),
    model: reported?.model ?? adapterModel(invocation),
    reasoningEffort: adapterReasoningEffort(invocation),
    mode: invocation.mode,
    commandDisplay: invocation.display,
    commandRunId: context.commandRunId ?? null,
    runDir: context.runDir ?? null,
    status: result.status === 0 ? 'succeeded' : 'failed',
    exitStatus: result.status,
    signal: result.signal,
    error: result.error,
    promptCharacters: prompt.length,
    outputCharacters: outputText ? outputText.length : null,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    estimated,
    usageSource,
    adapterReportedCostUsd: reported?.costUsd ?? null,
    sessionId: reported?.sessionId ?? null,
  };
  return {
    ...baseEntry,
    ...entryCost(workspaceRoot, baseEntry),
  };
}

function readIssueLedger(workspaceRoot: string, issue: string): LlmUsageLedger {
  const paths = issueUsagePaths(workspaceRoot, issue);
  return readJson<LlmUsageLedger>(paths.ledgerPath, {
    schemaVersion: SCHEMA_VERSION,
    issue,
    updatedAt: new Date().toISOString(),
    entries: [],
  });
}

function writeIssueLedger(workspaceRoot: string, ledger: LlmUsageLedger) {
  const paths = issueUsagePaths(workspaceRoot, ledger.issue);
  const updated = {
    ...ledger,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries: entriesWithCurrentCosts(workspaceRoot, ledger.entries),
  };
  writeJson(paths.ledgerPath, updated);
  writeFileSync(paths.summaryPath, `${formatLlmUsageSummary(summarizeIssueUsage(workspaceRoot, ledger.issue)).join('\n')}\n`);
}

function appendEntriesToIssueLedger(workspaceRoot: string, issue: string, entries: LlmUsageEntry[]) {
  if (entries.length === 0) return;
  const ledger = readIssueLedger(workspaceRoot, issue);
  const existingIds = new Set(ledger.entries.map((entry) => entry.id));
  const nextEntries = [
    ...ledger.entries,
    ...entries
      .filter((entry) => !existingIds.has(entry.id))
      .map((entry) => ({ ...entry, issue })),
  ];
  writeIssueLedger(workspaceRoot, { ...ledger, issue, entries: nextEntries });
}

function runUsagePath(runDir: string) {
  return path.join(runDir, 'usage.json');
}

function readRunUsage(runDir: string): LlmRunUsageFile {
  return readJson<LlmRunUsageFile>(runUsagePath(runDir), {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries: [],
  });
}

function writeRunUsage(runDir: string, entries: LlmUsageEntry[]) {
  writeJson(runUsagePath(runDir), {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries,
  } satisfies LlmRunUsageFile);
}

export function recordLlmAdapterUsage(
  workspaceRoot: string,
  context: LlmUsageContext | undefined,
  invocation: AdapterInvocation,
  prompt: string,
  result: {
    status: number | null;
    signal: NodeJS.Signals | null;
    error: string | null;
    stdout: string | null;
    stderr: string | null;
    outputText: string | null;
    adapterReportedUsage?: AdapterReportedUsage | null;
  }
) {
  if (!context) return { entry: null as LlmUsageEntry | null, warning: null as string | null };
  try {
    const entry = buildEntry(workspaceRoot, context, invocation, prompt, {
      ...result,
      adapterReportedUsage: result.adapterReportedUsage ?? null,
    });
    if (context.runDir) {
      const runUsage = readRunUsage(context.runDir);
      writeRunUsage(context.runDir, [...runUsage.entries, entry]);
    }
    if (context.issue) appendEntriesToIssueLedger(workspaceRoot, context.issue, [entry]);
    return {
      entry,
      warning: context.issue || context.runDir ? null : 'LLM usage: not attached to an issue; pass --issue <owner/repo#number> to include it in lifecycle totals.',
    };
  } catch (error) {
    return { entry: null, warning: `LLM usage tracking failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function attachRunUsageToIssue(workspaceRoot: string, runDir: string | null | undefined, issue: string) {
  if (!runDir) return { attached: 0, warning: null as string | null };
  try {
    const runUsage = readRunUsage(runDir);
    const migrated = runUsage.entries.map((entry) => {
      const taskTitle =
        !entry.taskTitle || entry.taskTitle.startsWith('[pending-issue]')
          ? llmUsageTaskTitle({ ...entry, issue, taskTitle: null })
          : entry.taskTitle;
      return {
        ...entry,
        taskTitle,
        issue,
        migratedFromRunDir: entry.migratedFromRunDir ?? runDir,
      };
    });
    writeRunUsage(runDir, migrated);
    appendEntriesToIssueLedger(workspaceRoot, issue, migrated);
    return { attached: migrated.length, warning: null };
  } catch (error) {
    return { attached: 0, warning: `LLM usage migration failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function usageEntriesForCommandRun(workspaceRoot: string, issue: string | null | undefined, commandRunId: string) {
  if (!issue) return [];
  return readIssueLedger(workspaceRoot, issue).entries.filter((entry) => entry.commandRunId === commandRunId);
}

export function refreshIssueUsageLedgerCosts(workspaceRoot: string, issue: string) {
  const paths = issueUsagePaths(workspaceRoot, issue);
  const ledger = readIssueLedger(workspaceRoot, issue);
  const entries = entriesWithCurrentCosts(workspaceRoot, ledger.entries);
  const changed = entries.some((entry, index) => {
    const previous = ledger.entries[index];
    return (
      previous?.taskTitle !== entry.taskTitle ||
      previous?.costUsd !== entry.costUsd ||
      previous?.costUnavailableReason !== entry.costUnavailableReason
    );
  });
  if (!changed) return false;

  const updated = { ...ledger, schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), entries };
  writeJson(paths.ledgerPath, updated);
  writeFileSync(paths.summaryPath, `${formatLlmUsageSummary(summarizeIssueUsage(workspaceRoot, issue)).join('\n')}\n`);
  return true;
}

export function summarizeIssueUsage(workspaceRoot: string, issue: string): LlmUsageSummary {
  const paths = issueUsagePaths(workspaceRoot, issue);
  const ledger = readIssueLedger(workspaceRoot, issue);
  const entries = entriesWithCurrentCosts(workspaceRoot, ledger.entries);
  const inputTokens = entries.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0);
  const cachedInputTokens = entries.reduce((sum, entry) => sum + (entry.cachedInputTokens ?? 0), 0);
  const outputTokens = entries.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0);
  const unknownOutputEntries = entries.filter((entry) => entry.outputTokens === null).length;
  const knownTotalTokens = entries.reduce((sum, entry) => {
    if (entry.totalTokens !== null) return sum + entry.totalTokens;
    return sum + (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0);
  }, 0);
  const costUnavailableReasons = Array.from(
    new Set(entries.map((entry) => entry.costUnavailableReason).filter((reason): reason is string => Boolean(reason)))
  );
  const knownCostEntries = entries.filter((entry) => entry.costUsd !== null);
  const costUsd =
    knownCostEntries.length > 0
      ? Number(knownCostEntries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0).toFixed(6))
      : null;
  return {
    issue,
    ledgerPath: paths.ledgerPath,
    summaryPath: paths.summaryPath,
    entries: entries.length,
    failedEntries: entries.filter((entry) => entry.status === 'failed').length,
    estimatedEntries: entries.filter((entry) => entry.estimated).length,
    unknownOutputEntries,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    knownTotalTokens,
    totalTokensExact: unknownOutputEntries === 0 && entries.every((entry) => entry.totalTokens !== null),
    costUsd,
    costUnavailableReasons,
    models: Array.from(new Set(entries.map((entry) => entry.model).filter((model): model is string => Boolean(model)))).sort(),
  };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function estimatedLabel(summary: LlmUsageSummary) {
  return summary.estimatedEntries > 0 ? ' estimated' : '';
}

export function formatLlmUsageSummary(summary: LlmUsageSummary) {
  const outputDetail = summary.unknownOutputEntries
    ? ` (${summary.unknownOutputEntries} entr${summary.unknownOutputEntries === 1 ? 'y has' : 'ies have'} unknown output)`
    : '';
  const totalPrefix = summary.totalTokensExact ? '' : 'at least ';
  let cost: string;
  if (summary.costUsd !== null && summary.costUnavailableReasons.length > 0) {
    cost = `Cost: at least $${summary.costUsd.toFixed(6)}; ${summary.costUnavailableReasons.join('; ')}`;
  } else if (summary.costUsd !== null) {
    cost = `Cost: $${summary.costUsd.toFixed(6)}`;
  } else {
    cost = `Cost: unavailable${
      summary.costUnavailableReasons.length ? `; ${summary.costUnavailableReasons.join('; ')}` : '; no usage recorded'
    }`;
  }
  return [
    `War Room LLM usage for ${summary.issue}:`,
    `- Entries: ${formatNumber(summary.entries)}${summary.failedEntries ? ` (${summary.failedEntries} failed)` : ''}`,
    `- Input tokens: ${formatNumber(summary.inputTokens)}${estimatedLabel(summary)}`,
    summary.cachedInputTokens > 0 ? `- Cached input tokens: ${formatNumber(summary.cachedInputTokens)}${estimatedLabel(summary)}` : null,
    `- Output tokens: ${formatNumber(summary.outputTokens)}${estimatedLabel(summary)}${outputDetail}`,
    `- Total tokens: ${totalPrefix}${formatNumber(summary.knownTotalTokens)}${estimatedLabel(summary)}`,
    `- ${cost}`,
    summary.models.length ? `- Models: ${summary.models.join(', ')}` : '- Models: none recorded',
    `- Ledger: ${summary.ledgerPath}`,
  ].filter((line): line is string => line !== null);
}
