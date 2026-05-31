import * as vscode from 'vscode';
import { cfg } from './config';
import { getHeadSha } from '../services/gitInfo';
import { isBusy, runExclusive } from './lock';
import { SessionManager } from './session';
import { RepoRegistry, RepoState } from './repos';
import { TicketService } from '../features/tickets';
import { DraftService, DraftMode } from '../features/draft';

const TICK_INTERVAL_MS = 20_000;
const PROMPT_TIMEOUT_MS = 60_000;

/**
 * showInformationMessage that resolves to undefined if the user ignores it for
 * `timeoutMs`. Without this, an ignored notification would hold the busy lock and
 * block every future nudge; with it, an ignored prompt auto-snoozes and re-prompts.
 */
async function askWithTimeout(message: string, timeoutMs: number, ...items: string[]): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([vscode.window.showInformationMessage(message, ...items), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Timer-driven nudges. Each repo in the workspace is checked independently: a fresh
 * commit or accumulated active time in *any* repo can trigger a nudge, and the nudge is
 * scoped to that repo (its ticket, its diff). At most one nudge fires per tick.
 */
export class ReminderService {
  private timer?: ReturnType<typeof setInterval>;
  private snoozeUntil = 0;

  constructor(
    private readonly registry: RepoRegistry,
    private readonly session: SessionManager,
    private readonly tickets: TicketService,
    private readonly draft: DraftService,
    private readonly onTick: () => void,
  ) {
    // Selecting a ticket or posting an update clears any active snooze.
    session.onUpdated(() => {
      this.snoozeUntil = 0;
    });
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private snooze(): void {
    this.snoozeUntil = Date.now() + cfg().get<number>('snoozeMinutes', 10) * 60_000;
  }

  /** Prefix a nudge with the repo name only when more than one repo is tracked. */
  private label(repo: RepoState): string {
    return this.registry.all().length > 1 ? `[${repo.name}] ` : '';
  }

  private async tick(): Promise<void> {
    this.session.refreshStatus();
    this.onTick();

    const c = cfg();
    if (!c.get<boolean>('autoNudge', true)) {
      return;
    }

    // Never stack a nudge on top of a flow the user is already in. We bail *before*
    // touching any repo's lastHeadSha so a commit made mid-review isn't swallowed - it'll
    // be detected on the next free tick instead of silently advancing the pointer.
    if (isBusy()) {
      return;
    }

    // Detect a new commit in any repo since we last looked. A fresh commit is an explicit
    // action - always prompt once for it, even during a snooze.
    if (c.get<boolean>('remindOnCommit', true) && (await this.checkCommits())) {
      return;
    }

    // Time-based nudges stay quiet during a snooze.
    if (Date.now() < this.snoozeUntil) {
      return;
    }

    await this.checkActiveTime(c);
  }

  /**
   * Scan *every* repo for a fresh commit; nudge for the first one found. A commit is an
   * explicit action, so it fires regardless of which repo is focused or whether the repo
   * is in the tracked set - as long as it has a ticket. Returns true if it nudged.
   */
  private async checkCommits(): Promise<boolean> {
    for (const repo of this.registry.all()) {
      const head = await getHeadSha(repo.root);
      if (!head) {
        continue;
      }
      const committed = repo.lastHeadSha !== undefined && head !== repo.lastHeadSha;
      repo.lastHeadSha = head;
      if (!committed) {
        continue;
      }
      const ticket = this.registry.activeTicket(repo.root);
      if (ticket) {
        await runExclusive(() =>
          this.nudge(ticket, `${this.label(repo)}You just committed`, 'lastCommit', repo.root),
        );
        return true;
      }
      // No ticket on that repo: only prompt if it's a tracked repo (don't nag about excluded ones).
      if (this.registry.isIncluded(repo.root)) {
        const snap = repo.tracker.snapshot();
        await runExclusive(() => this.promptNoTicket(snap.activeSeconds / 60, snap.editCount, repo));
        return true;
      }
    }
    return false;
  }

  /** Scan tracked repos for crossed activity thresholds; nudge for the first one. */
  private async checkActiveTime(c: vscode.WorkspaceConfiguration): Promise<void> {
    for (const repo of this.registry.included()) {
      const ticket = this.registry.activeTicket(repo.root);
      const snap = repo.tracker.snapshot();
      const mins = snap.activeSeconds / 60;

      if (!ticket) {
        if (snap.editCount > 0 && mins >= c.get<number>('workThresholdMinutes', 25)) {
          await runExclusive(() => this.promptNoTicket(mins, snap.editCount, repo));
          return;
        }
        continue;
      }

      if (mins >= c.get<number>('updateReminderMinutes', 20)) {
        await runExclusive(() =>
          this.nudge(
            ticket,
            `${this.label(repo)}You've done ~${Math.round(mins)} min of work`,
            'session',
            repo.root,
          ),
        );
        return;
      }
    }
  }

  private async promptNoTicket(mins: number, edits: number, repo: RepoState): Promise<void> {
    const choice = await askWithTimeout(
      `Yo, you've been coding in ${repo.name} for a while (${Math.round(mins)} min · ${edits} edits). What Jira ticket is this?`,
      PROMPT_TIMEOUT_MS,
      'Pick ticket',
      'Snooze',
    );
    if (choice === 'Pick ticket') {
      await this.tickets.startTicket(repo.root);
    } else {
      this.snooze(); // Snooze, dismiss, or ignored-and-timed-out → quiet, then re-prompt later.
    }
  }

  private async nudge(
    ticket: string,
    reason: string,
    mode: DraftMode = 'session',
    repoFolder?: string,
  ): Promise<void> {
    const choice = await askWithTimeout(
      `${reason} on ${ticket}. Write a Jira update?`,
      PROMPT_TIMEOUT_MS,
      'Write update',
      'Snooze',
      'Switch ticket',
    );
    if (choice === 'Write update') {
      await this.draft.generateAndReview(ticket, mode, 'HEAD', undefined, repoFolder);
    } else if (choice === 'Switch ticket') {
      await this.tickets.startTicket(repoFolder);
    } else {
      this.snooze(); // Snooze, dismiss, or ignored-and-timed-out → quiet, then re-prompt later.
    }
  }
}
