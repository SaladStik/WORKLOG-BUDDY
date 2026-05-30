export interface ActivitySnapshot {
  /** Accumulated active seconds since the last reset (idle gaps excluded). */
  activeSeconds: number;
  /** Number of real edit events (text changes) since the last reset. */
  editCount: number;
  /** Absolute paths of files edited since the last reset. */
  filesTouched: string[];
  /** Timestamp (ms) of the last recorded heartbeat. */
  lastActivity: number;
}

/**
 * Tracks *real* editing activity rather than wall-clock time with VS Code open.
 *
 * Model (same idea as WakaTime): every meaningful event is a "heartbeat". When a
 * heartbeat arrives, the gap since the previous heartbeat is added to active time
 * only if that gap is below the idle timeout — so leaving the window open without
 * touching anything contributes nothing.
 *
 * Counters are cumulative until reset(); the extension resets them whenever a ticket
 * is selected or an update is posted, so a snapshot always means "since the last
 * Jira update on the active ticket".
 *
 * This class is event-source agnostic: it does not subscribe to VS Code events
 * itself. The {@link RepoRegistry} owns a single set of subscriptions and routes
 * each event to the right repo's tracker via {@link recordEdit}/{@link recordPresence}/
 * {@link setFocused}. That routing is what makes per-repo time tracking possible in a
 * multi-root workspace.
 */
export class ActivityTracker {
  private activeSeconds = 0;
  private editCount = 0;
  private readonly filesTouched = new Set<string>();
  private lastHeartbeat = 0;
  private windowFocused: boolean;

  private readonly idleTimeoutMs: number;

  constructor(idleTimeoutMinutes: number, focused = true) {
    this.idleTimeoutMs = idleTimeoutMinutes * 60_000;
    this.windowFocused = focused;
  }

  /** Strong signal: a real edit. Records the touched file and beats the clock. */
  recordEdit(fsPath?: string): void {
    if (fsPath) {
      this.filesTouched.add(fsPath);
    }
    this.heartbeat(true);
  }

  /** Weak signal: presence/navigation (selection, focus, save) keeps a session alive. */
  recordPresence(): void {
    this.heartbeat(false);
  }

  /** Apply a window focus change. On refocus, reset the clock so away-time isn't counted. */
  setFocused(focused: boolean): void {
    this.windowFocused = focused;
    if (focused) {
      this.lastHeartbeat = Date.now();
    }
  }

  private heartbeat(isEdit: boolean): void {
    if (!this.windowFocused) {
      return;
    }
    const now = Date.now();
    if (this.lastHeartbeat > 0) {
      const gap = now - this.lastHeartbeat;
      if (gap > 0 && gap < this.idleTimeoutMs) {
        this.activeSeconds += gap / 1000;
      }
    }
    this.lastHeartbeat = now;
    if (isEdit) {
      this.editCount++;
    }
  }

  snapshot(): ActivitySnapshot {
    return {
      activeSeconds: Math.round(this.activeSeconds),
      editCount: this.editCount,
      filesTouched: [...this.filesTouched],
      lastActivity: this.lastHeartbeat,
    };
  }

  reset(): void {
    this.activeSeconds = 0;
    this.editCount = 0;
    this.filesTouched.clear();
    this.lastHeartbeat = 0;
  }
}
