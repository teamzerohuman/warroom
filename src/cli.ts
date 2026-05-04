#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  linkSdkToDemo,
  runDevStatus,
  type DevActionResult,
  type DevStatus,
  unlinkSdkFromDemo,
} from './commands/dev-link.js';
import { runDoctor } from './commands/doctor.js';
import { runMapsStudy } from './commands/maps-study.js';

type Output = (text: string) => void;

function printJson(output: Output, value: unknown) {
  output(JSON.stringify(value, null, 2));
}

function printNotImplemented(output: Output, command: string, issue: string) {
  output(`${command} is not implemented in phase 1. Track it in ${issue}.`);
}

function formatRepoLine(label: string, repo: DevStatus['sdk']) {
  const checkout = repo.checkedOut ? 'present' : 'missing';
  const source = repo.source === 'sibling' ? ', sibling fallback' : repo.source === 'manifest' ? ', manifest path' : '';
  const dirty = repo.clean === false ? ', dirty' : repo.clean === true ? ', clean' : '';
  return `${label}: ${checkout}${source}${dirty} -> ${repo.resolvedPath}`;
}

function printDevStatus(output: Output, result: DevStatus) {
  output(formatRepoLine('SDK checkout', result.sdk));
  output(formatRepoLine('Demo checkout', result.demo));
  output(`Demo dependencies: ${result.demo.nodeModules ? 'installed' : 'missing node_modules'}`);
  for (const tool of result.tools) {
    output(`${tool.name}: ${tool.available ? 'ok' : 'missing'}${tool.detail ? ` (${tool.detail})` : ''}`);
  }

  const linkState = result.linked
    ? 'linked'
    : result.partiallyLinked
      ? 'partially linked'
      : result.legacyDirectLinked
        ? 'legacy direct links'
        : 'unlinked';
  output(`SDK-to-demo dev link: ${linkState}`);
  for (const packageLink of result.packages) {
    const build = packageLink.buildOutputExists ? 'built' : 'missing dist';
    if (packageLink.linked) {
      output(`ok ${packageLink.name} -> ${packageLink.targetPath} (${build})`);
    } else if (packageLink.legacyDirectLinked) {
      output(`legacy-direct ${packageLink.name} -> ${packageLink.sdkPackagePath} (${build})`);
    } else if (packageLink.exists) {
      output(`published ${packageLink.name} (${packageLink.isSymlink ? packageLink.actualTarget : 'not a symlink'}, ${build})`);
    } else {
      output(`missing ${packageLink.name} (${build})`);
    }
  }

  output('');
  output('Recommended linked workflow:');
  output(`SDK watch: ${result.recommended.sdkWatch}`);
  output(`Demo dev: ${result.recommended.demoDev}`);
  output(`Demo build: ${result.recommended.demoBuild}`);
  output(`Demo typecheck: ${result.recommended.demoTypecheck}`);
  output(`Demo Playwright core: ${result.recommended.demoPlaywrightCore}`);
}

function printDevAction(output: Output, action: DevActionResult) {
  for (const message of action.messages) output(message);
  printDevStatus(output, action.status);
}

export function buildProgram(options: { cwd?: string; output?: Output } = {}) {
  const workspaceRoot = options.cwd ?? process.cwd();
  const output = options.output ?? console.log;
  const program = new Command();

  program
    .name('warroom')
    .description('TeamFloPay local command center and cross-repo orchestration workspace.')
    .version('0.1.0');

  program
    .command('doctor')
    .description('Validate the phase-1 War Room skeleton.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { json?: boolean }) => {
      const result = runDoctor(workspaceRoot);
      if (opts.json) {
        printJson(output, result);
        return;
      }

      output(`War Room doctor: ${result.ok ? 'ok' : 'needs attention'}`);
      output(`Repos mapped: ${result.repoCount} (${result.activeRepoCount} active, ${result.plannedRepoCount} planned)`);
      for (const file of result.files) {
        output(`${file.exists ? 'ok' : 'missing'} ${file.file}`);
      }
    });

  const maps = program.command('maps').description('Inspect and maintain the repo map.');

  maps
    .command('study')
    .description('Show local repo map health and specialist assignments.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { json?: boolean }) => {
      const repos = runMapsStudy(workspaceRoot);
      if (opts.json) {
        printJson(output, repos);
        return;
      }

      for (const repo of repos) {
        const checkoutState = repo.checkedOut ? 'checked out' : repo.status === 'planned' ? 'planned' : 'missing';
        output(`${repo.github} [${repo.status}, ${checkoutState}] -> ${repo.local_path} (${repo.specialist.name})`);
      }
    });

  maps
    .command('assign')
    .description('Stub for interactive repo specialist/resource assignment.')
    .action(() => printNotImplemented(output, 'warroom maps assign', 'TeamFloPay/infra#4'));

  program
    .command('bootstrap')
    .description('Stub for cloning missing child repos and checking required tools.')
    .action(() => printNotImplemented(output, 'warroom bootstrap', 'TeamFloPay/infra#4'));

  program
    .command('sync')
    .description('Stub for fetching/pulling clean child repos.')
    .action(() => printNotImplemented(output, 'warroom sync', 'TeamFloPay/infra#4'));

  const issue = program.command('issue').description('Issue workflow commands.');
  issue.command('triage').description('Stub for issue triage handoffs.').action(() => printNotImplemented(output, 'warroom issue triage', 'TeamFloPay/infra#4'));
  issue.command('next').description('Stub for listing ready implementation issues.').action(() => printNotImplemented(output, 'warroom issue next', 'TeamFloPay/infra#4'));

  const pr = program.command('pr').description('Pull request workflow commands.');
  pr.command('engage').description('Stub for PR engagement preflight.').action(() => printNotImplemented(output, 'warroom pr engage', 'TeamFloPay/infra#4'));
  pr.command('review').description('Stub for PR review loops.').action(() => printNotImplemented(output, 'warroom pr review', 'TeamFloPay/infra#4'));
  pr.command('merge').description('Stub for PR merge cleanup.').action(() => printNotImplemented(output, 'warroom pr merge', 'TeamFloPay/infra#4'));

  const commit = program.command('commit').description('Commit workflow commands.');
  commit.command('create').description('Stub for shared commit creation.').action(() => printNotImplemented(output, 'warroom commit create', 'TeamFloPay/infra#4'));

  program
    .command('abort')
    .description('Stub for preservation-first abort/recovery workflow.')
    .action(() => printNotImplemented(output, 'warroom abort', 'TeamFloPay/infra#4'));

  const dev = program.command('dev').description('Local development orchestration commands.');
  dev
    .command('status')
    .description('Show SDK-to-demo local dev-link state and prerequisites.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { json?: boolean }) => {
      const result = runDevStatus(workspaceRoot);
      if (opts.json) {
        printJson(output, result);
        return;
      }

      printDevStatus(output, result);
    });

  dev
    .command('link')
    .description('Link local SDK packages into the standalone demo checkout.')
    .option('--skip-build', 'Do not build SDK packages before linking.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { skipBuild?: boolean; json?: boolean }) => {
      const result = linkSdkToDemo(workspaceRoot, { skipBuild: opts.skipBuild });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printDevAction(output, result);
    });

  dev
    .command('unlink')
    .description('Remove local SDK package links and restore demo published-package install.')
    .option('--skip-install', 'Do not run pnpm install after removing local links.')
    .option('--json', 'Print machine-readable output.')
    .action((opts: { skipInstall?: boolean; json?: boolean }) => {
      const result = unlinkSdkFromDemo(workspaceRoot, { skipInstall: opts.skipInstall });
      if (opts.json) {
        printJson(output, result);
        return;
      }
      printDevAction(output, result);
    });

  return program;
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (path.resolve(currentFile) === invokedFile) {
  buildProgram().parse();
}
