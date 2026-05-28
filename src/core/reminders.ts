import * as vscode from 'vscode';
import { cfg, getFolder } from './config';
import { getHeadSha } from '../services/gitInfo';
import { isBusy, runExclusive } from './lock';
import { SessionManager } from './session';
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

/** Timer-driven nudges: detects commits and accumulated active time, then prompts. */
export class ReminderService {
  private timer?: ReturnType<typeof setInterval>;
  private lastHeadSha?: string;
  private snoozeUntil = 0;

  constructor(
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
    // Prime the commit detector so the first tick can't fire a false "you committed".
    const folder = getFolder();
    if (folder) {
      void getHeadSha(folder).then((sha) => (this.lastHeadSha = sha));
    }
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

  private async tick(): Promise<void> {
    this.session.refreshStatus();
    this.onTick();

    const c = cfg();
    if (!c.get<boolean>('autoNudge', true)) {
      return;
    }

    // Detect new commits even while busy/snoozed so lastHeadSha stays current.
    let committed = false;
    const folder = getFolder();
    if (folder) {
      const head = await getHeadSha(folder);
      if (head) {
        if (this.lastHeadSha && head !== this.lastHeadSha) {
          committed = true;
        }
        this.lastHeadSha = head;
      }
    }

    if (isBusy() || Date.now() < this.snoozeUntil) {
      return;
    }

    const ticket = this.session.getActiveTicket();
    const snap = this.session.snapshot();
    const mins = snap.activeSeconds / 60;

    if (committed && c.get<boolean>('remindOnCommit', true)) {
      if (ticket) {
        await runExclusive(() => this.nudge(ticket, 'You just committed', 'lastCommit'));
      } else {
        await runExclusive(() => this.promptNoTicket(mins, snap.editCount));
      }
      return;
    }

    if (!ticket) {
      if (snap.editCount > 0 && mins >= c.get<number>('workThresholdMinutes', 25)) {
        await runExclusive(() => this.promptNoTicket(mins, snap.editCount));
      }
      return;
    }

    if (mins >= c.get<number>('updateReminderMinutes', 20)) {
      await runExclusive(() => this.nudge(ticket, `You've done ~${Math.round(mins)} min of work`));
    }
  }

  private async promptNoTicket(mins: number, edits: number): Promise<void> {
    const choice = await askWithTimeout(
      `Yo — you've been coding for a while (${Math.round(mins)} min · ${edits} edits). What Jira ticket is this?`,
      PROMPT_TIMEOUT_MS,
      'Pick ticket',
      'Snooze',
    );
    if (choice === 'Pick ticket') {
      await this.tickets.startTicket();
    } else {
      this.snooze(); // Snooze, dismiss, or ignored-and-timed-out → quiet, then re-prompt later.
    }
  }

  private async nudge(ticket: string, reason: string, mode: DraftMode = 'session'): Promise<void> {
    const choice = await askWithTimeout(
      `${reason} on ${ticket}. Write a Jira update?`,
      PROMPT_TIMEOUT_MS,
      'Write update',
      'Snooze',
      'Switch ticket',
    );
    if (choice === 'Write update') {
      await this.draft.generateAndReview(ticket, mode);
    } else if (choice === 'Switch ticket') {
      await this.tickets.startTicket();
    } else {
      this.snooze(); // Snooze, dismiss, or ignored-and-timed-out → quiet, then re-prompt later.
    }
  }
}
