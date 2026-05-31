import * as vscode from 'vscode';
import { getJiraConfig } from '../core/config';
import { getBranch, parseJiraKey } from '../services/gitInfo';
import { searchAssignedIssues, JiraConfig, JiraIssue } from '../services/jira';
import { SessionManager } from '../core/session';
import { RepoRegistry } from '../core/repos';

/** Picking / switching the active Jira ticket. */
export class TicketService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: SessionManager,
    private readonly registry: RepoRegistry,
  ) {}

  /**
   * Resolve which repo an action targets. With one repo (or none) it resolves without
   * prompting; with several it asks, so a ticket / commit always lands on the repo you
   * mean rather than whatever file happens to be open. Returns the chosen root (which may
   * be undefined when there are no repos), or undefined if the user cancelled the picker.
   */
  async pickRepoFolder(title: string): Promise<{ root?: string } | undefined> {
    const repos = this.registry.all();
    if (repos.length <= 1) {
      return { root: repos[0]?.root };
    }
    // If the user has pinned a repo in the picker, treat that as their explicit choice
    // and don't nag — actions target the pinned repo until they unpin it.
    if (this.registry.isPinned) {
      return { root: this.registry.current()?.root };
    }
    const current = this.registry.current();
    const items = repos.map((r) => ({
      label: (r.root === current?.root ? '$(pin) ' : '') + r.name,
      description: this.registry.activeTicket(r.root) ?? 'no ticket',
      detail: r.root,
      root: r.root,
    }));
    const sel = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: 'Select a repository',
      matchOnDescription: true,
    });
    return sel ? { root: sel.root } : undefined;
  }

  /**
   * Pick (or enter) a ticket and make it the active session. Returns the chosen key.
   * Pass `root` to assign the ticket to a specific repo (e.g. the one that was committed
   * to); defaults to the current repo.
   */
  async startTicket(root?: string): Promise<string | undefined> {
    // When the caller didn't specify a repo, ask which one (no-op for a single repo).
    if (root === undefined) {
      const picked = await this.pickRepoFolder('Pick a ticket for which repo?');
      if (!picked) {
        return undefined; // cancelled
      }
      root = picked.root;
    }
    const folder = root ?? this.session.currentRepoFolder();
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
      await this.session.setActiveTicket(chosen, root);
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
