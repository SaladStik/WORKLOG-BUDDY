import * as vscode from 'vscode';
import { ActivityTracker } from './services/activityTracker';
import { cfg, NIM_KEY_SECRET, setSecret } from './core/config';
import { runExclusive } from './core/lock';
import { SessionManager } from './core/session';
import { TicketService } from './features/tickets';
import { DraftService, refreshDraftContext } from './features/draft';
import { ReminderService } from './core/reminders';
import { manageJira } from './features/jiraManager';
import { SettingsViewProvider } from './webview/settingsView';

let reminders: ReminderService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const tracker = new ActivityTracker(cfg().get<number>('idleTimeoutMinutes', 3));
  tracker.start();

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.show();

  const session = new SessionManager(context, tracker, statusItem);
  session.refreshStatus();

  const tickets = new TicketService(context, session);
  const draft = new DraftService(context, session);
  const provider = new SettingsViewProvider(context, session);

  reminders = new ReminderService(session, tickets, draft, () => provider.pushSession());
  reminders.start();

  // Keep the panel's session stats in sync when the active ticket changes.
  session.onUpdated(() => provider.pushSession());

  context.subscriptions.push(
    statusItem,
    session,
    { dispose: () => tracker.dispose() },
    { dispose: () => reminders?.dispose() },

    vscode.window.registerWebviewViewProvider('worklog.settingsView', provider),
    vscode.commands.registerCommand('worklog.openSettings', () =>
      vscode.commands.executeCommand('worklog.settingsView.focus'),
    ),

    vscode.commands.registerCommand('worklog.startTicket', () =>
      runExclusive(async () => {
        await tickets.startTicket();
      }),
    ),
    vscode.commands.registerCommand('worklog.updateNow', () =>
      runExclusive(async () => {
        const ticket = session.getActiveTicket() ?? (await tickets.startTicket());
        if (ticket) {
          await draft.generateAndReview(ticket);
        }
      }),
    ),
    vscode.commands.registerCommand('worklog.writeAboutLastCommit', () =>
      runExclusive(async () => {
        const ticket = session.getActiveTicket() ?? (await tickets.startTicket());
        if (ticket) {
          await draft.generateAndReview(ticket, 'lastCommit');
        }
      }),
    ),
    vscode.commands.registerCommand('worklog.postCurrentDraft', () =>
      runExclusive(() => draft.postCurrentDraft()),
    ),
    vscode.commands.registerCommand('worklog.manageJira', () =>
      runExclusive(() => manageJira(context, tickets)),
    ),
    vscode.commands.registerCommand('worklog.setApiKey', () =>
      setSecret(context, NIM_KEY_SECRET, 'NVIDIA NIM API key (nvapi-…)'),
    ),
    vscode.commands.registerCommand('worklog.resetSession', () => {
      session.resetSession();
      vscode.window.showInformationMessage('Worklog activity session reset.');
    }),

    // Show the title-bar checkmark only when the active editor is a worklog draft.
    vscode.window.onDidChangeActiveTextEditor(() => refreshDraftContext()),
  );

  refreshDraftContext();
}

export function deactivate(): void {
  reminders?.dispose();
}
