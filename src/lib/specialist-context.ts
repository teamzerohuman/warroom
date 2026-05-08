import { resolveAllyIssueRepo } from './allies.js';
import { loadRepoManifest, type RepoEntry } from './repos.js';
import { loadResourcesManifest, type ResourceEntry } from './resources.js';

function formatList(values: string[]) {
  return values.length ? values.map((value) => `- ${value}`).join('\n') : '- none';
}

function formatResources(resources: ResourceEntry[]) {
  if (resources.length === 0) return '- none';
  return resources
    .map((resource) => {
      const docs = resource.docs_url ? ` (${resource.docs_url})` : '';
      return `- ${resource.id}: ${resource.name} [${resource.type}]${docs} - ${resource.description}`;
    })
    .join('\n');
}

export function repoForGitHub(workspaceRoot: string, githubRepo: string): RepoEntry | null {
  const manifest = loadRepoManifest(workspaceRoot);
  return manifest.repos.find((repo) => repo.github === githubRepo) ?? null;
}

export function buildSpecialistContext(workspaceRoot: string, githubRepo: string) {
  const repo = repoForGitHub(workspaceRoot, githubRepo);
  if (!repo) {
    const allyIssueRepo = resolveAllyIssueRepo(workspaceRoot, githubRepo);
    if (allyIssueRepo) {
      return [
        `Ally issue repo context for ${githubRepo}`,
        `Ally: ${allyIssueRepo.ally.name} (${allyIssueRepo.ally.id})`,
        `Local checkout: ${allyIssueRepo.issueRepoPath}${allyIssueRepo.issueRepoCheckedOut ? '' : ' (missing)'}`,
        `Sync: ${allyIssueRepo.ally.issue_repo.sync} from ${allyIssueRepo.ally.issue_repo.client_system}`,
        '- This is an ally issue repo, not product source. Keep triage scoped to safe issue context and avoid committing client data, secrets, or private endpoints.',
      ].join('\n');
    }

    return `Repo specialist context for ${githubRepo}:\n- No mapped repo found in repos.yaml. Confirm owner repo before editing.`;
  }

  const resources = loadResourcesManifest(workspaceRoot);
  const allowedResources = repo.specialist.context.resources
    .map((resourceId) => resources.resources.find((resource) => resource.id === resourceId))
    .filter((resource): resource is ResourceEntry => Boolean(resource));

  return [
    `Repo specialist context for ${repo.github}`,
    `Sergeant: ${repo.specialist.name}`,
    `Owner: ${repo.owner}`,
    `Description: ${repo.description}`,
    '',
    'Frameworks:',
    formatList(repo.specialist.context.frameworks),
    '',
    'Domains:',
    formatList(repo.specialist.context.domains),
    '',
    'Allowed resources:',
    formatResources(allowedResources),
  ].join('\n');
}
