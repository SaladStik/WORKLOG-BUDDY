import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ActivityTracker } from '../services/activityTracker';
import { findRepoRoot, getHeadSha } from '../services/gitInfo';

/** Legacy single-repo key - migrated to a per-repo key on first run. */
const LEGACY_ACTIVE_TICKET_KEY = 'worklog.activeTicket';
const ACTIVE_TICKET_PREFIX = 'worklog.activeTicket::';
/** Roots the user has un-checked in the picker (default is "tracked"). */
const EXCLUDED_REPOS_KEY = 'worklog.excludedRepos';
/** How many directory levels below a workspace folder to scan for nested repos. */
const MAX_SCAN_DEPTH = 5;

/** One tracked git repository in the current workspace. */
export interface RepoState {
  /** Normalized repo root (forward slashes, no trailing slash). */
  root: string;
  /** Display name - the repo folder's basename. */
  name: string;
  /** Per-repo activity clock (idle gaps excluded). */
  tracker: ActivityTracker;
  /** HEAD sha as last seen, so the reminder can detect a fresh commit per repo. */
  lastHeadSha?: string;
}

/**
 * Normalize a filesystem path for prefix comparison and stable map keys: forward slashes,
 * no trailing slash, and an upper-cased drive letter. The drive-letter step matters on
 * Windows - git's `--show-toplevel` and VS Code's `fsPath` can disagree on its case, which
 * would otherwise register the same repo twice.
 */
function norm(p: string): string {
  let n = p.replace(/\\/g, '/');
  if (n.length > 1 && n.endsWith('/')) {
    n = n.slice(0, -1);
  }
  if (/^[a-z]:/.test(n)) {
    n = n[0].toUpperCase() + n.slice(1);
  }
  return n;
}

/** Case-insensitive on Windows (drive letters / NTFS), case-sensitive elsewhere. */
function sameOrInside(file: string, root: string): boolean {
  const f = process.platform === 'win32' ? file.toLowerCase() : file;
  const r = process.platform === 'win32' ? root.toLowerCase() : root;
  return f === r || f.startsWith(r + '/');
}

/**
 * Recursively collect git repo roots at or below `dir`. A directory holding a
 * `.git` entry (a folder for normal repos, a file for submodules/worktrees) is a
 * repo root; we don't descend into it further. Skips node_modules and other
 * dot-directories, and bails on unreadable dirs.
 */
async function scanForRepos(dir: string, depth: number, roots: Set<string>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable (permissions, removed, not a directory)
  }
  if (entries.some((e) => e.name === '.git')) {
    roots.add(norm(dir));
    return;
  }
  if (depth <= 0) {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) {
      continue;
    }
    await scanForRepos(path.join(dir, e.name), depth - 1, roots);
  }
}

/**
 * Discovers and tracks every git repo in the workspace, keeping per-repo state:
 * an active ticket, an activity clock, and a commit pointer. This is what makes
 * Worklog Buddy work in a multi-root workspace (or a "wonky" layout where the repo
 * isn't the opened folder) - each repo is tracked independently, and the "current"
 * repo follows the active editor.
 *
 * The registry owns the *single* set of activity-event subscriptions and routes each
 * event to the right repo's tracker, so time is charged to the repo you're editing.
 */
export class RepoRegistry implements vscode.Disposable {
  private readonly repos = new Map<string, RepoState>();
  /** Auto-follow memory: the repo of the most recent active editor. */
  private lastActiveRoot?: string;
  /** User-pinned repo. When set, it is the current repo regardless of the active editor. */
  private pinnedRoot?: string;
  /** Repos the user has excluded from tracking (time nudges + batch updates). */
  private readonly excluded: Set<string>;
  private migrated = false;

  private readonly _onUpdated = new vscode.EventEmitter<void>();
  /** Fires when repos are (re)discovered, a ticket changes, or selection/focus changes. */
  readonly onUpdated = this._onUpdated.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly idleTimeoutMinutes: number,
  ) {
    this.excluded = new Set(context.workspaceState.get<string[]>(EXCLUDED_REPOS_KEY, []));
  }

  /** Wire the activity-event subscriptions (one set for the whole workspace). */
  start(): void {
    this.disposables.push(
      // Strong signal: actual edits → charged to the repo that owns the file.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0 || e.document.uri.scheme !== 'file') {
          return;
        }
        const fsPath = e.document.uri.fsPath;
        const repo = this.repoForFile(fsPath);
        repo?.tracker.recordEdit(fsPath);
      }),
      // Weak signals: presence/navigation keep the *current* repo's session alive.
      vscode.window.onDidChangeTextEditorSelection(() => this.current()?.tracker.recordPresence()),
      vscode.workspace.onDidSaveTextDocument(() => this.current()?.tracker.recordPresence()),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // Follow the editor: the repo it belongs to becomes the current repo.
        const uri = editor?.document.uri;
        if (uri?.scheme === 'file') {
          const repo = this.repoForFile(uri.fsPath);
          if (repo) {
            this.lastActiveRoot = repo.root;
          }
        }
        this.current()?.tracker.recordPresence();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        for (const repo of this.repos.values()) {
          repo.tracker.setFocused(s.focused);
        }
      }),
    );
  }

  /**
   * Discover repos in the workspace and reconcile state: add new repos (priming their
   * commit pointer), drop ones that disappeared. Safe to call repeatedly.
   */
  async refresh(): Promise<void> {
    const roots = await this.discoverRoots();

    // Drop repos that are no longer present.
    for (const root of [...this.repos.keys()]) {
      if (!roots.has(root)) {
        this.repos.delete(root);
      }
    }

    // Add newly-discovered repos.
    const focused = vscode.window.state.focused;
    for (const root of roots) {
      if (this.repos.has(root)) {
        continue;
      }
      const state: RepoState = {
        root,
        name: path.basename(root) || root,
        tracker: new ActivityTracker(this.idleTimeoutMinutes, focused),
      };
      this.repos.set(root, state);
      // Prime the commit pointer so the first reminder tick can't false-fire.
      state.lastHeadSha = await getHeadSha(root);
    }

    await this.migrateLegacyTicket();
    this._onUpdated.fire();
  }

  /** Union of (a) the repo each workspace folder lives in and (b) repos nested below. */
  private async discoverRoots(): Promise<Set<string>> {
    const roots = new Set<string>();

    // (a) Walk up from each workspace folder - handles opening a *subfolder* of a repo.
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = await findRepoRoot(folder.uri.fsPath);
      if (root) {
        roots.add(norm(root));
      }
    }

    // (b) Find repos *below* the opened folder(s) - handles multiple / nested repos,
    // and the common case where the opened folder isn't a repo but contains some.
    // We scan the tree ourselves rather than using vscode.workspace.findFiles: a
    // `**/.git/**` glob comes up empty because `.git` is in VS Code's default
    // files.exclude and its search service won't descend into it.
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await scanForRepos(folder.uri.fsPath, MAX_SCAN_DEPTH, roots);
    }

    return roots;
  }

  /** All tracked repos, in a stable order (by name). */
  all(): RepoState[] {
    return [...this.repos.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(root: string): RepoState | undefined {
    return this.repos.get(norm(root));
  }

  /** The repo that owns a file, by longest matching root prefix. */
  repoForFile(fsPath: string): RepoState | undefined {
    const file = norm(fsPath);
    let best: RepoState | undefined;
    for (const repo of this.repos.values()) {
      if (sameOrInside(file, repo.root) && (!best || repo.root.length > best.root.length)) {
        best = repo;
      }
    }
    return best;
  }

  /**
   * The repo the user is focused on: a user pin wins (and sticks across editor changes),
   * else the active editor's repo, else the last one they were in, else the sole repo.
   * Undefined when no repo is known.
   */
  current(): RepoState | undefined {
    if (this.pinnedRoot) {
      const pinned = this.repos.get(this.pinnedRoot);
      if (pinned) {
        return pinned;
      }
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file') {
      const repo = this.repoForFile(active.fsPath);
      if (repo) {
        return repo;
      }
    }
    if (this.lastActiveRoot) {
      const repo = this.repos.get(this.lastActiveRoot);
      if (repo) {
        return repo;
      }
    }
    return this.repos.size === 1 ? this.repos.values().next().value : undefined;
  }

  get isPinned(): boolean {
    return !!this.pinnedRoot && this.repos.has(this.pinnedRoot);
  }

  /**
   * Toggle the user pin for a repo. Pinning makes it the current repo and keeps it there
   * even as you switch files; clicking the already-pinned repo clears the pin (back to
   * following the active editor).
   */
  togglePin(root: string): void {
    const n = norm(root);
    if (!this.repos.has(n)) {
      return;
    }
    this.pinnedRoot = this.pinnedRoot === n ? undefined : n;
    this._onUpdated.fire();
  }

  /** Pin focus to a repo (no toggle) - used after the user explicitly chooses one. */
  pin(root: string): void {
    const n = norm(root);
    if (this.repos.has(n)) {
      this.pinnedRoot = n;
      this._onUpdated.fire();
    }
  }

  /** Is a repo tracked (included in time nudges + batch updates)? Default true. */
  isIncluded(root: string): boolean {
    return !this.excluded.has(norm(root));
  }

  /** Tracked repos - the ones time nudges and "write for all" act on. */
  included(): RepoState[] {
    return this.all().filter((r) => !this.excluded.has(r.root));
  }

  /** Check/uncheck a repo for tracking, and persist the choice. */
  async setIncluded(root: string, included: boolean): Promise<void> {
    const n = norm(root);
    if (included) {
      this.excluded.delete(n);
    } else {
      this.excluded.add(n);
    }
    await this.context.workspaceState.update(EXCLUDED_REPOS_KEY, [...this.excluded]);
    this._onUpdated.fire();
  }

  /** The active ticket for a repo (defaults to the current repo). */
  activeTicket(root?: string): string | undefined {
    const key = root ? norm(root) : this.current()?.root;
    if (!key) {
      return undefined;
    }
    return this.context.workspaceState.get<string>(ACTIVE_TICKET_PREFIX + key);
  }

  /** Set a repo's active ticket (defaults to the current repo) and reset its clock. */
  async setActiveTicket(key: string | undefined, root?: string): Promise<void> {
    const repoRoot = root ? norm(root) : this.current()?.root;
    if (!repoRoot) {
      return;
    }
    await this.context.workspaceState.update(ACTIVE_TICKET_PREFIX + repoRoot, key);
    this.repos.get(repoRoot)?.tracker.reset(); // count time from "now" against the new ticket
    this._onUpdated.fire();
  }

  /**
   * One-time migration: an upgrade from the single-repo version stored the ticket under
   * a flat key. Move it to the current (or only) repo so users don't lose their selection.
   */
  private async migrateLegacyTicket(): Promise<void> {
    if (this.migrated) {
      return;
    }
    const legacy = this.context.workspaceState.get<string>(LEGACY_ACTIVE_TICKET_KEY);
    if (legacy) {
      const target = this.current() ?? this.all()[0];
      if (target) {
        await this.context.workspaceState.update(ACTIVE_TICKET_PREFIX + target.root, legacy);
        await this.context.workspaceState.update(LEGACY_ACTIVE_TICKET_KEY, undefined);
        this.migrated = true;
      }
    } else {
      this.migrated = true;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onUpdated.dispose();
  }
}
