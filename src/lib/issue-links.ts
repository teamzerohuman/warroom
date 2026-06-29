// The repo segment must end in an alphanumeric character: GitHub repo names
// cannot end with a period, so a trailing `.`/`-`/`_` is always sentence
// punctuation (e.g. "Owner repo: TeamFloPay/dashboard.") and must not be
// captured — otherwise the slug fails to match repos.yaml's `github` entries.
const OWNER_REPO = String.raw`([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]*[A-Za-z0-9])`;

export function ownerRepoFromText(value: string | undefined) {
  const ownerRepo = value?.match(
    new RegExp(String.raw`(?:^|\n)\s*(?:#+\s*|[-*]\s*)?(?:\*\*)?Owner repo[\s\S]{0,60}?\`?${OWNER_REPO}\`?`, 'i')
  )?.[1];
  if (ownerRepo) return ownerRepo;

  return value?.match(new RegExp(String.raw`implementation should happen in\s+\`?${OWNER_REPO}\`?`, 'i'))?.[1] ?? null;
}

export function closingIssueRefFromText(defaultRepo: string, value: string | undefined) {
  const keyword = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
  const explicit = value?.match(new RegExp(`${keyword}\\s+([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#(\\d+)`, 'i'));
  if (explicit?.[1] && explicit[2]) return `${explicit[1]}#${explicit[2]}`;

  const local = value?.match(new RegExp(`${keyword}\\s+#(\\d+)`, 'i'));
  if (local?.[1]) return `${defaultRepo}#${local[1]}`;

  return null;
}
