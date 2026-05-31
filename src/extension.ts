import * as vscode from 'vscode';
import { cfg, NIM_KEY_SECRET, setSecret } from './core/config';
import { runExclusive } from './core/lock';
import { RepoRegistry } from './core/repos';
import { SessionManager } from './core/session';
import { TicketService } from './features/tickets';
import { DraftService, refreshDraftContext } from './features/draft';
import { ReminderService } from './core/reminders';
import { manageJira } from './features/jiraManager';
import { SettingsViewProvider } from './webview/settingsView';

let reminders: ReminderService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const registry = new RepoRegistry(context, cfg().get<number>('idleTimeoutMinutes', 3));
  registry.start();
  // Discover repos now and whenever the workspace's folders change.
  void registry.refresh();

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.show();

  const session = new SessionManager(registry, statusItem);
  session.refreshStatus();

  const tickets = new TicketService(context, session, registry);
  const draft = new DraftService(context, session);
  const provider = new SettingsViewProvider(context, session, registry, tickets);

  reminders = new ReminderService(registry, session, tickets, draft, () => provider.pushSession());
  reminders.start();

  // Keep the panel's session stats in sync when the active ticket changes.
  session.onUpdated(() => provider.pushSession());

  context.subscriptions.push(
    statusItem,
    session,
    registry,
    vscode.workspace.onDidChangeWorkspaceFolders(() => void registry.refresh()),
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
        const picked = await tickets.pickRepoFolder('Write a Jira update for which repo?');
        if (!picked) {
          return; // cancelled
        }
        const root = picked.root;
        const ticket = registry.activeTicket(root) ?? (await tickets.startTicket(root));
        if (ticket) {
          await draft.generateAndReview(ticket, 'session', 'HEAD', undefined, root);
        }
      }),
    ),
    vscode.commands.registerCommand('worklog.writeAboutLastCommit', () =>
      runExclusive(async () => {
        const picked = await tickets.pickRepoFolder('Write about the last commit in which repo?');
        if (!picked) {
          return; // cancelled
        }
        const root = picked.root;
        const ticket = registry.activeTicket(root) ?? (await tickets.startTicket(root));
        if (ticket) {
          await draft.generateAndReview(ticket, 'lastCommit', 'HEAD', undefined, root);
        }
      }),
    ),
    vscode.commands.registerCommand('worklog.writeAboutCommit', () =>
      runExclusive(async () => {
        const picked = await tickets.pickRepoFolder('Pick a commit from which repo?');
        if (!picked) {
          return; // cancelled
        }
        const root = picked.root;
        const ticket = registry.activeTicket(root) ?? (await tickets.startTicket(root));
        if (ticket) {
          await draft.writeAboutCommit(ticket, root);
        }
      }),
    ),
    // Multi-repo: draft one update per tracked repo that has a ticket (each posts to its own).
    vscode.commands.registerCommand('worklog.updateSelectedRepos', () =>
      runExclusive(async () => {
        const tracked = registry.included();
        const withTicket = tracked.filter((r) => registry.activeTicket(r.root));
        if (!withTicket.length) {
          vscode.window.showWarningMessage(
            'None of the tracked repos have an active ticket yet. Pick a ticket for each repo first.',
          );
          return;
        }
        for (const repo of withTicket) {
          const ticket = registry.activeTicket(repo.root);
          if (ticket) {
            await draft.generateAndReview(ticket, 'session', 'HEAD', undefined, repo.root);
          }
        }
        const skipped = tracked.filter((r) => !registry.activeTicket(r.root));
        if (skipped.length) {
          vscode.window.showInformationMessage(
            `Skipped ${skipped.length} repo(s) with no ticket: ${skipped.map((r) => r.name).join(', ')}.`,
          );
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

    // Show the title-bar checkmark only when the active editor is a worklog draft, and
    // reflect the current repo (which follows the active editor) in the status bar/panel.
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshDraftContext();
      session.refreshStatus();
      provider.pushSession();
    }),
  );

  refreshDraftContext();
}

export function deactivate(): void {
  reminders?.dispose();
}
