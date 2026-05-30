import * as vscode from 'vscode';
import {
  getJiraConfig,
  persistJiraConnection,
  readPanelSettings,
  savePanelSettings,
  JIRA_TOKEN_SECRET,
  NIM_KEY_SECRET,
} from '../core/config';
import { searchAssignedIssues, testConnection } from '../services/jira';
import { testNim } from '../services/nimClient';
import { SessionManager } from '../core/session';
import { RepoRegistry } from '../core/repos';
import { getPanelHtml } from './panelHtml';

/** The sidebar management panel (webview). */
export class SettingsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: SessionManager,
    private readonly registry: RepoRegistry,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getPanelHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
  }

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  /** Push the live session stats (active ticket, minutes, edits, files) to the panel. */
  pushSession(): void {
    if (!this.view) {
      return;
    }
    const snap = this.session.snapshot();
    const current = this.registry.current();
    const repos = this.registry.all();
    this.post({
      type: 'session',
      activeTicket: this.session.getActiveTicket() ?? null,
      activeMinutes: Math.round(snap.activeSeconds / 60),
      edits: snap.editCount,
      files: snap.filesTouched.length,
      // Multi-repo context: which repo is current and the full list (with their tickets).
      currentRepo: current?.root ?? null,
      repos: repos.map((r) => ({
        root: r.root,
        name: r.name,
        ticket: this.registry.activeTicket(r.root) ?? null,
      })),
    });
  }

  private async onMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post({ type: 'settings', settings: readPanelSettings() });
        this.pushSession();
        await this.autoConnect();
        break;
      case 'save':
        await savePanelSettings(this.context, msg.settings as Record<string, unknown>);
        this.post({ type: 'saved' });
        break;
      case 'testConnection':
        await this.testAndSignIn(
          msg as unknown as { jiraBaseUrl: string; jiraEmail: string; jiraToken: string },
        );
        break;
      case 'testNim':
        await this.testNimConnection(
          msg as unknown as { nimBaseUrl: string; nimModel: string; nimApiKey: string },
        );
        break;
      case 'refreshTickets':
        await this.refreshTickets();
        break;
      case 'selectTicket':
        await this.session.setActiveTicket(msg.key as string);
        this.pushSession();
        break;
      case 'switchTicket':
        await vscode.commands.executeCommand('worklog.startTicket');
        this.pushSession();
        break;
      case 'setCurrentRepo':
        this.registry.setCurrent(msg.root as string);
        this.session.refreshStatus();
        this.pushSession();
        break;
      case 'writeUpdateNow':
        await vscode.commands.executeCommand('worklog.updateNow');
        break;
      case 'writeAboutLastCommit':
        await vscode.commands.executeCommand('worklog.writeAboutLastCommit');
        break;
      case 'writeAboutCommit':
        await vscode.commands.executeCommand('worklog.writeAboutCommit');
        break;
      case 'resetSession':
        this.session.resetSession();
        this.pushSession();
        break;
    }
  }

  /** On open, if saved Jira creds exist, verify the connection so the pill is accurate. */
  private async autoConnect(): Promise<void> {
    const jira = await getJiraConfig(this.context);
    if (!jira) {
      this.post({ type: 'connectionStatus', state: 'idle' });
      return;
    }
    this.post({ type: 'connectionStatus', state: 'connecting' });
    try {
      const who = await testConnection(jira);
      this.post({ type: 'connectionStatus', state: 'ok', name: who });
      await this.refreshTickets();
    } catch (err) {
      this.post({ type: 'connectionStatus', state: 'error', error: (err as Error).message });
    }
  }

  private async testAndSignIn(msg: {
    jiraBaseUrl: string;
    jiraEmail: string;
    jiraToken: string;
  }): Promise<void> {
    const token = msg.jiraToken || (await this.context.secrets.get(JIRA_TOKEN_SECRET)) || '';
    if (!msg.jiraBaseUrl || !msg.jiraEmail || !token) {
      this.post({ type: 'connectionStatus', state: 'error', error: 'Fill in URL, email and token.' });
      return;
    }
    this.post({ type: 'connectionStatus', state: 'connecting' });
    try {
      const who = await testConnection({ baseUrl: msg.jiraBaseUrl, email: msg.jiraEmail, token });
      // Persist as "signed in" so subsequent calls (refresh, posting) work.
      await persistJiraConnection(this.context, msg.jiraBaseUrl, msg.jiraEmail, token);
      this.post({ type: 'connectionStatus', state: 'ok', name: who });
      await this.refreshTickets();
    } catch (err) {
      this.post({ type: 'connectionStatus', state: 'error', error: (err as Error).message });
    }
  }

  /** Verify the NIM key/model with a tiny request. Falls back to the stored key. */
  private async testNimConnection(msg: {
    nimBaseUrl: string;
    nimModel: string;
    nimApiKey: string;
  }): Promise<void> {
    const apiKey = msg.nimApiKey || (await this.context.secrets.get(NIM_KEY_SECRET)) || '';
    const baseUrl = msg.nimBaseUrl || 'https://integrate.api.nvidia.com/v1';
    const model = msg.nimModel || 'meta/llama-3.1-8b-instruct';
    if (!apiKey) {
      this.post({ type: 'nimStatus', state: 'error', error: 'Enter your NIM API key first.' });
      return;
    }
    this.post({ type: 'nimStatus', state: 'connecting' });
    try {
      const m = await testNim({ apiKey, baseUrl, model });
      this.post({ type: 'nimStatus', state: 'ok', model: m });
    } catch (err) {
      this.post({ type: 'nimStatus', state: 'error', error: (err as Error).message });
    }
  }

  private async refreshTickets(): Promise<void> {
    const jira = await getJiraConfig(this.context);
    if (!jira) {
      this.post({ type: 'tickets', items: [] });
      return;
    }
    try {
      const items = await searchAssignedIssues(jira, 25);
      this.post({ type: 'tickets', items });
    } catch (err) {
      this.post({ type: 'connectionStatus', state: 'error', error: (err as Error).message });
    }
  }
}
