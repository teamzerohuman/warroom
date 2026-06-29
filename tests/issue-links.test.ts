import { describe, expect, it } from 'vitest';
import { ownerRepoFromText } from '../src/lib/issue-links.js';

describe('ownerRepoFromText', () => {
  it('reads a bare "Owner repo" line', () => {
    expect(ownerRepoFromText('Owner repo: TeamFloPay/backend')).toBe('TeamFloPay/backend');
  });

  it('reads a bold, backtick-wrapped "Owner repo" line', () => {
    expect(ownerRepoFromText('**Owner repo:** `TeamFloPay/sdk`')).toBe('TeamFloPay/sdk');
  });

  it('drops a trailing sentence period from the captured slug', () => {
    // Regression: triage notes routinely end the line with a period, e.g.
    // "Owner repo: TeamFloPay/dashboard." — the trailing "." must not be
    // captured or the slug never matches repos.yaml's `github` entries.
    expect(ownerRepoFromText('Owner repo: TeamFloPay/dashboard.')).toBe('TeamFloPay/dashboard');
  });

  it('preserves dots inside a repo name', () => {
    expect(ownerRepoFromText('Owner repo: TeamFloPay/next.js')).toBe('TeamFloPay/next.js');
    expect(ownerRepoFromText('Owner repo: TeamFloPay/next.js.')).toBe('TeamFloPay/next.js');
  });

  it('falls back to the "implementation should happen in" phrasing', () => {
    expect(ownerRepoFromText('implementation should happen in TeamFloPay/dashboard.')).toBe(
      'TeamFloPay/dashboard'
    );
  });

  it('returns null when no owner repo is present', () => {
    expect(ownerRepoFromText('No mapping here.')).toBeNull();
    expect(ownerRepoFromText(undefined)).toBeNull();
  });
});
