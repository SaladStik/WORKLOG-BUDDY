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

/**
 * Resolve the root of the git repository that contains `startDir` (walks up via
 * `--show-toplevel`). Returns undefined when `startDir` is not inside a repo.
 */
export async function findRepoRoot(startDir: string): Promise<string | undefined> {
  const out = (await git(startDir, ['rev-parse', '--show-toplevel'])).trim();
  return out || undefined;
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

export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  relative: string;
}

/** List recent commits (newest first) for the commit picker. */
export async function listRecentCommits(cwd: string, limit = 30): Promise<CommitSummary[]> {
  // Unit-separated fields, newline-separated records.
  const out = await git(cwd, ['log', `-n${limit}`, '--pretty=format:%H%x1f%h%x1f%s%x1f%cr']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, subject, relative] = line.split('\x1f');
      return { sha, shortSha, subject, relative };
    });
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

/** Returns a commit's sha, short sha, subject and (if a remote exists) a web link. Defaults to HEAD. */
export async function getCommitRef(cwd: string, ref = 'HEAD'): Promise<CommitRef | undefined> {
  const sha = (await git(cwd, ['rev-parse', ref])).trim();
  if (!sha) {
    return undefined;
  }
  const shortSha = (await git(cwd, ['rev-parse', '--short', ref])).trim() || sha.slice(0, 7);
  const subject = (await git(cwd, ['log', '-1', '--pretty=format:%s', sha])).trim();
  const remote = (await git(cwd, ['config', '--get', 'remote.origin.url'])).trim();
  const url = remote ? webUrlForCommit(remote, sha) : undefined;
  return { sha, shortSha, subject, url };
}

/** Evidence for a single commit (message + diffstat + patch). Defaults to HEAD. */
export async function collectCommitEvidence(cwd: string, ref = 'HEAD'): Promise<GitEvidence> {
  const branch = await getBranch(cwd);
  const commits = (await git(cwd, ['log', '-1', '--pretty=format:%h %s%n%b', ref])).trim();
  const statText = (await git(cwd, ['show', ref, '--stat', '--format='])).trim();
  const rawDiff = await git(cwd, ['show', ref, '--patch', '--format='], 8 * 1024 * 1024);
  const diff = rawDiff.length > 24000 ? rawDiff.slice(0, 24000) + '\n…(diff truncated)…' : rawDiff;
  return { branch, statText, commits, diff };
}

/** Evidence for the single most recent commit (message + diffstat + patch). */
export function collectLastCommitEvidence(cwd: string): Promise<GitEvidence> {
  return collectCommitEvidence(cwd, 'HEAD');
}
