import { getAllyHealth, loadAlliesManifest, type AllyHealth } from '../lib/allies.js';

export type AlliesStatus = {
  ok: boolean;
  allies: AllyHealth[];
  allyCount: number;
  activeAllyCount: number;
  plannedAllyCount: number;
};

export function runAlliesStatus(workspaceRoot: string): AlliesStatus {
  const manifest = loadAlliesManifest(workspaceRoot);
  const allies = manifest.allies.map((ally) => getAllyHealth(workspaceRoot, ally));

  return {
    ok: allies.every((ally) => ally.structuralOk),
    allies,
    allyCount: allies.length,
    activeAllyCount: allies.filter((ally) => ally.status === 'active').length,
    plannedAllyCount: allies.filter((ally) => ally.status === 'planned').length,
  };
}
