import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

const JIRA_KEY = /[A-Z][A-Z0-9]+-\d+/;

async function git(cwd: string, args: string[], maxBuffer = 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer });
    return stdout;
  } catch {
    return '';
  }
}

export async function getBranch(cwd: string): Promise<string | undefined> {
  const out = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return out || undefined;
}

/** Current HEAD commit sha, used to detect when a new commit lands. */
export async function getHeadSha(cwd: string): Promise<string | undefined> {
  const out = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  return out || undefined;
}

/** Extract a Jira key like PROJ-123 from a branch name (feature/PROJ-123-foo). */
export function parseJiraKey(branch: string | undefined): string | undefined {
  if (!branch) {
    return undefined;
  }
  return branch.match(JIRA_KEY)?.[0];
}

export interface GitEvidence {
  branch?: string;
  statText: string;
  commits: string;
  diff: string;
}

/**
 * Gather the evidence the LLM will summarize: a stat of working-tree changes,
 * recent commits within the session window, and a (truncated) unified diff.
 */
export async function collectEvidence(cwd: string, sinceMinutes: number): Promise<GitEvidence> {
  const branch = await getBranch(cwd);
  const statText = (await git(cwd, ['diff', '--stat', 'HEAD'])).trim();
  const commits = (
    await git(cwd, ['log', `--since=${sinceMinutes} minutes ago`, '--pretty=format:%h %s'])
  ).trim();
  const rawDiff = await git(cwd, ['diff', 'HEAD'], 8 * 1024 * 1024);
  const diff = rawDiff.length > 24000 ? rawDiff.slice(0, 24000) + '\n…(diff truncated)…' : rawDiff;
  return { branch, statText, commits, diff };
}

export interface CommitRef {
  sha: string;
  shortSha: string;
  subject: string;
  url?: string;
}

/** Converts a git remote URL into a web URL for a specific commit, if recognizable. */
function webUrlForCommit(remote: string, sha: string): string | undefined {
  let host: string | undefined;
  let path: string | undefined;

  const ssh = remote.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  const https = remote.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (ssh) {
    host = ssh[1];
    path = ssh[2];
  } else if (https) {
    host = https[1];
    path = https[2];
  }
  if (!host || !path) {
    return undefined;
  }
  // Bitbucket uses /commits/<sha>; GitHub/GitLab use /commit/<sha>.
  const segment = host.includes('bitbucket') ? 'commits' : 'commit';
  return `https://${host}/${path}/${segment}/${sha}`;
}

/** Returns the HEAD commit's sha, short sha, subject and (if a remote exists) a web link. */
export async function getCommitRef(cwd: string): Promise<CommitRef | undefined> {
  const sha = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  if (!sha) {
    return undefined;
  }
  const shortSha = (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim() || sha.slice(0, 7);
  const subject = (await git(cwd, ['log', '-1', '--pretty=format:%s'])).trim();
  const remote = (await git(cwd, ['config', '--get', 'remote.origin.url'])).trim();
  const url = remote ? webUrlForCommit(remote, sha) : undefined;
  return { sha, shortSha, subject, url };
}

/** Evidence for the single most recent commit (message + diffstat + patch). */
export async function collectLastCommitEvidence(cwd: string): Promise<GitEvidence> {
  const branch = await getBranch(cwd);
  const commits = (await git(cwd, ['log', '-1', '--pretty=format:%h %s%n%b'])).trim();
  const statText = (await git(cwd, ['show', 'HEAD', '--stat', '--format='])).trim();
  const rawDiff = await git(cwd, ['show', 'HEAD', '--patch', '--format='], 8 * 1024 * 1024);
  const diff = rawDiff.length > 24000 ? rawDiff.slice(0, 24000) + '\n…(diff truncated)…' : rawDiff;
  return { branch, statText, commits, diff };
}
