import * as vscode from 'vscode';
import * as path from 'path';
import { ActivityTracker } from '../services/activityTracker';
import { findRepoRoot, getHeadSha } from '../services/gitInfo';

/** Legacy single-repo key — migrated to a per-repo key on first run. */
const LEGACY_ACTIVE_TICKET_KEY = 'worklog.activeTicket';
const ACTIVE_TICKET_PREFIX = 'worklog.activeTicket::';

/** One tracked git repository in the current workspace. */
export interface RepoState {
  /** Normalized repo root (forward slashes, no trailing slash). */
  root: string;
  /** Display name — the repo folder's basename. */
  name: string;
  /** Per-repo activity clock (idle gaps excluded). */
  tracker: ActivityTracker;
  /** HEAD sha as last seen, so the reminder can detect a fresh commit per repo. */
  lastHeadSha?: string;
}

/**
 * Normalize a filesystem path for prefix comparison and stable map keys: forward slashes,
 * no trailing slash, and an upper-cased drive letter. The drive-letter step matters on
 * Windows — git's `--show-toplevel` and VS Code's `fsPath` can disagree on its case, which
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
 * Discovers and tracks every git repo in the workspace, keeping per-repo state:
 * an active ticket, an activity clock, and a commit pointer. This is what makes
 * Worklog Buddy work in a multi-root workspace (or a "wonky" layout where the repo
 * isn't the opened folder) — each repo is tracked independently, and the "current"
 * repo follows the active editor.
 *
 * The registry owns the *single* set of activity-event subscriptions and routes each
 * event to the right repo's tracker, so time is charged to the repo you're editing.
 */
export class RepoRegistry implements vscode.Disposable {
  private readonly repos = new Map<string, RepoState>();
  private lastActiveRoot?: string;
  private migrated = false;

  private readonly _onUpdated = new vscode.EventEmitter<void>();
  /** Fires when repos are (re)discovered or an active ticket changes. */
  readonly onUpdated = this._onUpdated.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly idleTimeoutMinutes: number,
  ) {}

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

    // (a) Walk up from each workspace folder — handles opening a *subfolder* of a repo.
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = await findRepoRoot(folder.uri.fsPath);
      if (root) {
        roots.add(norm(root));
      }
    }

    // (b) Find repos *below* the opened folder(s) — handles multiple / nested repos.
    // `.git/HEAD` exists for every ordinary repo; its grandparent dir is the repo root.
    try {
      const heads = await vscode.workspace.findFiles('**/.git/HEAD', '**/node_modules/**');
      for (const uri of heads) {
        roots.add(norm(path.dirname(path.dirname(uri.fsPath))));
      }
    } catch {
      // findFiles can reject if no workspace is open; folder-based discovery still applies.
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
   * The repo the user is "on": the active editor's repo, else the last one they were in,
   * else the sole repo when there's only one. Undefined when no repo is known.
   */
  current(): RepoState | undefined {
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

  /** Force the current repo (used by the reminder before nudging, and the panel switcher). */
  setCurrent(root: string): void {
    const n = norm(root);
    if (this.repos.has(n)) {
      this.lastActiveRoot = n;
    }
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
