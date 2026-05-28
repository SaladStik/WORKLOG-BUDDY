import * as vscode from 'vscode';

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
 */
export class ActivityTracker {
  private activeSeconds = 0;
  private editCount = 0;
  private readonly filesTouched = new Set<string>();
  private lastHeartbeat = 0;
  private windowFocused: boolean;

  private readonly idleTimeoutMs: number;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(idleTimeoutMinutes: number) {
    this.idleTimeoutMs = idleTimeoutMinutes * 60_000;
    this.windowFocused = vscode.window.state.focused;
  }

  start(): void {
    this.disposables.push(
      // Strong signal: actual edits.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) {
          return;
        }
        if (e.document.uri.scheme === 'file') {
          this.filesTouched.add(e.document.uri.fsPath);
        }
        this.heartbeat(true);
      }),
      // Weak signals: presence/navigation keep a session alive.
      vscode.window.onDidChangeTextEditorSelection(() => this.heartbeat(false)),
      vscode.window.onDidChangeActiveTextEditor(() => this.heartbeat(false)),
      vscode.workspace.onDidSaveTextDocument(() => this.heartbeat(false)),
      vscode.window.onDidChangeWindowState((s) => {
        this.windowFocused = s.focused;
        if (s.focused) {
          // Reset the clock on refocus so away-time isn't counted.
          this.lastHeartbeat = Date.now();
        }
      }),
    );
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

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
