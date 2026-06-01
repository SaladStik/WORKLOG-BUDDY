import * as vscode from 'vscode';
import {
  cfg,
  getJiraConfig,
  getJiraUrlInfo,
  setSecret,
  setWorkspaceJiraUrl,
  JIRA_TOKEN_SECRET,
} from '../core/config';
import { testConnection } from '../services/jira';
import { TicketService } from './tickets';

/** Quick-pick menu for managing the Jira connection (URL / email / token / test / switch). */
export async function manageJira(
  context: vscode.ExtensionContext,
  tickets: TicketService,
): Promise<void> {
  const c = cfg();
  const { global, override, effective } = getJiraUrlInfo();
  const email = c.get<string>('jira.email', '');
  const hasToken = !!(await context.secrets.get(JIRA_TOKEN_SECRET));
  const hasWorkspace = !!vscode.workspace.workspaceFolders?.length;

  const items: (vscode.QuickPickItem & { id: string })[] = [
    { id: 'url', label: '$(globe) Jira URL (global)', description: global || 'not set' },
    {
      id: 'urlOverride',
      label: '$(root-folder) Jira URL for this workspace',
      description: !hasWorkspace ? 'open a folder to override' : override || 'using global',
    },
    { id: 'email', label: '$(mail) Account email (global)', description: email || 'not set' },
    { id: 'token', label: '$(key) API token (global)', description: hasToken ? 'set' : 'not set' },
    { id: 'test', label: '$(plug) Test connection', description: effective || undefined },
    { id: 'switch', label: '$(checklist) Switch active ticket' },
  ];

  const sel = await vscode.window.showQuickPick(items, { title: 'Manage Jira connection' });
  if (!sel) {
    return;
  }

  const G = vscode.ConfigurationTarget.Global;
  switch (sel.id) {
    case 'url': {
      const v = await vscode.window.showInputBox({
        prompt: 'Global Jira base URL (used unless a workspace overrides it)',
        value: global,
        placeHolder: 'https://yourcompany.atlassian.net',
        ignoreFocusOut: true,
      });
      if (v !== undefined) {
        await c.update('jira.baseUrl', v.trim(), G);
      }
      break;
    }
    case 'urlOverride': {
      if (!hasWorkspace) {
        vscode.window.showWarningMessage('Open a folder or workspace to set a per-workspace Jira URL.');
        break;
      }
      const v = await vscode.window.showInputBox({
        prompt: 'Jira URL for this workspace (leave blank to use the global URL)',
        value: override,
        placeHolder: global || 'https://otherproject.atlassian.net',
        ignoreFocusOut: true,
      });
      if (v !== undefined) {
        await setWorkspaceJiraUrl(v);
        vscode.window.showInformationMessage(
          v.trim()
            ? `This workspace will use ${v.trim()} for Jira.`
            : 'Cleared - this workspace now uses the global Jira URL.',
        );
      }
      break;
    }
    case 'email': {
      const v = await vscode.window.showInputBox({
        prompt: 'Atlassian account email',
        value: email,
        ignoreFocusOut: true,
      });
      if (v !== undefined) {
        await c.update('jira.email', v.trim(), G);
      }
      break;
    }
    case 'token':
      await setSecret(context, JIRA_TOKEN_SECRET, 'Jira API token');
      break;
    case 'test': {
      const jira = await getJiraConfig(context);
      if (!jira) {
        vscode.window.showWarningMessage('Set the Jira URL, email and token first.');
        return;
      }
      try {
        const who = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Testing Jira connection…' },
          () => testConnection(jira),
        );
        vscode.window.showInformationMessage(`Connected to Jira as ${who}.`);
      } catch (err) {
        vscode.window.showErrorMessage(`Jira connection failed: ${(err as Error).message}`);
      }
      break;
    }
    case 'switch':
      await tickets.startTicket();
      break;
  }
}
