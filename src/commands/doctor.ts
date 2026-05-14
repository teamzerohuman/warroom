import { existsSync } from 'node:fs';
import path from 'node:path';
import { getRepoHealth, loadRepoManifest } from '../lib/repos.js';
import { getEnvStatus } from '../lib/env.js';
import { loadResourcesManifest, validateResourceReferences } from '../lib/resources.js';
import { checkGithubAuth, checkTool } from '../lib/tools.js';
import { checkCampaignLabels, checkCampaignStatusOptions } from '../lib/campaign.js';
import { runAlliesStatus } from './allies.js';

function adapterToolChecks(adapter: string | null) {
  if (adapter === 'claude') return [checkTool('claude', 'claude', ['--version'])];
  if (adapter === 'codex' || adapter === 'codex-cloud') return [checkTool('codex', 'codex', ['--version'])];
  return [];
}

const requiredFiles = [
  'AGENTS.md',
  'README.md',
  '.env.local.example',
  'allies.yaml',
  'repos.yaml',
  'resources.yaml',
  'maps/campaign-atlas.md',
  'maps/issue-territory.md',
];

export function runDoctor(workspaceRoot: string) {
  const files = requiredFiles.map((file) => ({
    file,
    exists: existsSync(path.join(workspaceRoot, file)),
  }));

  const manifest = loadRepoManifest(workspaceRoot);
  const resources = loadResourcesManifest(workspaceRoot);
  const resourceReferences = validateResourceReferences(manifest, resources);
  const repos = manifest.repos.map((repo) => getRepoHealth(workspaceRoot, repo));
  const env = getEnvStatus(workspaceRoot);
  const tools = [
    checkTool('git', 'git', ['--version']),
    checkTool('gh', 'gh', ['--version']),
    checkGithubAuth(),
    checkTool('node', 'node', ['--version']),
    checkTool('npm', 'npm', ['--version']),
    ...adapterToolChecks(env.adapter),
  ];
  const campaignLabels = checkCampaignLabels(manifest);
  const campaignStatuses = checkCampaignStatusOptions();
  const allies = runAlliesStatus(workspaceRoot);

  const structuralOk =
    files.every((file) => file.exists) &&
    manifest.repos.length > 0 &&
    allies.ok &&
    resourceReferences.ok &&
    env.adapterSupported;

  return {
    ok: structuralOk,
    files,
    tools,
    env,
    resources: {
      count: resources.resources.length,
      referencesOk: resourceReferences.ok,
      missingReferences: resourceReferences.missing,
    },
    campaignLabels,
    campaignStatuses,
    allies,
    repos,
    repoCount: manifest.repos.length,
    activeRepoCount: manifest.repos.filter((repo) => repo.status === 'active').length,
    plannedRepoCount: manifest.repos.filter((repo) => repo.status === 'planned').length,
  };
}
