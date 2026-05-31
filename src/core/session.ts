import * as vscode from 'vscode';
import { ActivitySnapshot } from '../services/activityTracker';
import { RepoRegistry } from './repos';

const EMPTY_SNAPSHOT: ActivitySnapshot = {
  activeSeconds: 0,
  editCount: 0,
  filesTouched: [],
  lastActivity: 0,
};

/**
 * Facade over the *current* repo in the {@link RepoRegistry}. The rest of the extension
 * (ticket picker, draft service, panel, reminders) talks to one "active ticket" and one
 * activity clock through this object — the registry decides which repo that maps to based
 * on the active editor, so multi-root workspaces work without each caller knowing about
 * repos. Fires `onUpdated` when the ticket changes or an update is posted/reset.
 */
export class SessionManager implements vscode.Disposable {
  private readonly _onUpdated = new vscode.EventEmitter<void>();
  readonly onUpdated = this._onUpdated.event;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly registry: RepoRegistry,
    private readonly status: vscode.StatusBarItem,
  ) {
    // Re-emit registry changes (repos discovered, ticket set) as session updates.
    this.sub = registry.onUpdated(() => {
      this.refreshStatus();
      this._onUpdated.fire();
    });
  }

  /** Resolve a repo by root, or fall back to the current repo. */
  private repoOf(root?: string) {
    return root ? this.registry.get(root) : this.registry.current();
  }

  getActiveTicket(root?: string): string | undefined {
    return this.registry.activeTicket(root);
  }

  async setActiveTicket(key: string | undefined, root?: string): Promise<void> {
    await this.registry.setActiveTicket(key, root);
    this.refreshStatus();
    this._onUpdated.fire();
  }

  /** Repo root that git commands should run against — the current repo. */
  currentRepoFolder(): string | undefined {
    return this.registry.current()?.root;
  }

  /** Start a fresh window after posting so reminders/evidence cover only new work. */
  markUpdated(root?: string): void {
    this.repoOf(root)?.tracker.reset();
    this.refreshStatus();
    this._onUpdated.fire();
  }

  resetSession(root?: string): void {
    this.repoOf(root)?.tracker.reset();
    this.refreshStatus();
    this._onUpdated.fire();
  }

  snapshot(root?: string): ActivitySnapshot {
    return this.repoOf(root)?.tracker.snapshot() ?? EMPTY_SNAPSHOT;
  }

  refreshStatus(): void {
    const repo = this.registry.current();
    const ticket = this.registry.activeTicket();
    const mins = Math.round((repo?.tracker.snapshot().activeSeconds ?? 0) / 60);
    // Only disambiguate by repo name when more than one repo is in play.
    const prefix = this.registry.all().length > 1 && repo ? `${repo.name} · ` : '';
    if (ticket) {
      this.status.text = `$(git-commit) ${prefix}${ticket} · ${mins}m`;
      this.status.tooltip = `Worklog: ${mins} active min since last update on ${ticket}${
        repo ? ` (${repo.name})` : ''
      }. Click to write an update.`;
      this.status.command = 'worklog.updateNow';
    } else {
      this.status.text = `$(question) ${prefix}Worklog: set ticket`;
      this.status.tooltip = 'Worklog: click to pick the Jira ticket you are working on.';
      this.status.command = 'worklog.startTicket';
    }
  }

  dispose(): void {
    this.sub.dispose();
    this._onUpdated.dispose();
  }
}
