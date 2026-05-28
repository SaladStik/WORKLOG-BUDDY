import * as vscode from 'vscode';
import { ActivityTracker, ActivitySnapshot } from '../services/activityTracker';

const ACTIVE_TICKET_KEY = 'worklog.activeTicket';

/**
 * Owns the active-ticket selection, the activity tracker, and the status-bar item.
 * Fires `onUpdated` whenever the ticket changes or an update is posted/reset, so the
 * reminder service can clear its snooze and the panel can refresh.
 */
export class SessionManager implements vscode.Disposable {
  private readonly _onUpdated = new vscode.EventEmitter<void>();
  readonly onUpdated = this._onUpdated.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly tracker: ActivityTracker,
    private readonly status: vscode.StatusBarItem,
  ) {}

  getActiveTicket(): string | undefined {
    return this.context.workspaceState.get<string>(ACTIVE_TICKET_KEY);
  }

  async setActiveTicket(key: string | undefined): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_TICKET_KEY, key);
    this.tracker.reset(); // count time from "now" against the new ticket
    this.refreshStatus();
    this._onUpdated.fire();
  }

  /** Start a fresh window after posting so reminders/evidence cover only new work. */
  markUpdated(): void {
    this.tracker.reset();
    this.refreshStatus();
    this._onUpdated.fire();
  }

  resetSession(): void {
    this.tracker.reset();
    this.refreshStatus();
    this._onUpdated.fire();
  }

  snapshot(): ActivitySnapshot {
    return this.tracker.snapshot();
  }

  refreshStatus(): void {
    const ticket = this.getActiveTicket();
    const mins = Math.round(this.tracker.snapshot().activeSeconds / 60);
    if (ticket) {
      this.status.text = `$(git-commit) ${ticket} · ${mins}m`;
      this.status.tooltip = `Worklog: ${mins} active min since last update on ${ticket}. Click to write an update.`;
      this.status.command = 'worklog.updateNow';
    } else {
      this.status.text = '$(question) Worklog: set ticket';
      this.status.tooltip = 'Worklog: click to pick the Jira ticket you are working on.';
      this.status.command = 'worklog.startTicket';
    }
  }

  dispose(): void {
    this._onUpdated.dispose();
  }
}
