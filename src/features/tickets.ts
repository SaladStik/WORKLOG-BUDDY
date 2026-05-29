import * as vscode from 'vscode';
import { getRepoFolder, getJiraConfig } from '../core/config';
import { getBranch, parseJiraKey } from '../services/gitInfo';
import { searchAssignedIssues, JiraConfig, JiraIssue } from '../services/jira';
import { SessionManager } from '../core/session';

/** Picking / switching the active Jira ticket. */
export class TicketService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: SessionManager,
  ) {}

  /** Pick (or enter) a ticket and make it the active session. Returns the chosen key. */
  async startTicket(): Promise<string | undefined> {
    const folder = await getRepoFolder();
    const branch = folder ? await getBranch(folder) : undefined;
    const guess = parseJiraKey(branch);

    const jira = await getJiraConfig(this.context);
    let chosen: string | undefined;
    if (jira) {
      const picked = await this.pickFromJira(jira, guess);
      if (picked === undefined) {
        return undefined; // cancelled
      }
      chosen = picked || (await this.enterManually(guess));
    } else {
      chosen = await this.enterManually(guess);
    }

    if (chosen) {
      await this.session.setActiveTicket(chosen);
      vscode.window.showInformationMessage(`Now tracking work on ${chosen}.`);
    }
    return chosen;
  }

  /** Returns a key, '' to signal "enter manually", or undefined if cancelled. */
  private async pickFromJira(jira: JiraConfig, guess: string | undefined): Promise<string | undefined> {
    let issues: JiraIssue[] = [];
    try {
      issues = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading your Jira tickets…' },
        () => searchAssignedIssues(jira),
      );
    } catch (err) {
      vscode.window.showWarningMessage(`Couldn't load Jira tickets: ${(err as Error).message}`);
      return '';
    }

    const items: (vscode.QuickPickItem & { key?: string })[] = issues.map((i) => ({
      label: i.key,
      description: i.status,
      detail: i.summary,
      key: i.key,
    }));
    if (guess && !issues.some((i) => i.key === guess)) {
      items.unshift({ label: guess, description: 'from current branch', key: guess });
    }
    items.push({ label: '$(edit) Enter a key manually…' });

    const sel = await vscode.window.showQuickPick(items, {
      title: 'Which ticket are you working on?',
      placeHolder: 'Select an assigned ticket',
      matchOnDetail: true,
    });
    if (!sel) {
      return undefined;
    }
    return sel.key ?? '';
  }

  private async enterManually(guess: string | undefined): Promise<string | undefined> {
    const entered = await vscode.window.showInputBox({
      prompt: 'Jira ticket key',
      value: guess ?? '',
      placeHolder: 'PROJ-123',
      ignoreFocusOut: true,
      validateInput: (v) =>
        /^[A-Z][A-Z0-9]+-\d+$/.test(v.trim()) ? undefined : 'Expected a key like PROJ-123',
    });
    return entered?.trim() || undefined;
  }
}
