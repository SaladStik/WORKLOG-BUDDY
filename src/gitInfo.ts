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

/** Evidence for the single most recent commit (message + diffstat + patch). */
export async function collectLastCommitEvidence(cwd: string): Promise<GitEvidence> {
  const branch = await getBranch(cwd);
  const commits = (await git(cwd, ['log', '-1', '--pretty=format:%h %s%n%b'])).trim();
  const statText = (await git(cwd, ['show', 'HEAD', '--stat', '--format='])).trim();
  const rawDiff = await git(cwd, ['show', 'HEAD', '--patch', '--format='], 8 * 1024 * 1024);
  const diff = rawDiff.length > 24000 ? rawDiff.slice(0, 24000) + '\n…(diff truncated)…' : rawDiff;
  return { branch, statText, commits, diff };
}
