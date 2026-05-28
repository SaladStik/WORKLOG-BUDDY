import * as vscode from 'vscode';
import { cfg, getJiraConfig, setSecret, JIRA_TOKEN_SECRET } from '../core/config';
import { testConnection } from '../services/jira';
import { TicketService } from './tickets';

/** Quick-pick menu for managing the Jira connection (URL / email / token / test / switch). */
export async function manageJira(
  context: vscode.ExtensionContext,
  tickets: TicketService,
): Promise<void> {
  const c = cfg();
  const baseUrl = c.get<string>('jira.baseUrl', '');
  const email = c.get<string>('jira.email', '');
  const hasToken = !!(await context.secrets.get(JIRA_TOKEN_SECRET));

  const items: (vscode.QuickPickItem & { id: string })[] = [
    { id: 'url', label: '$(globe) Jira URL', description: baseUrl || 'not set' },
    { id: 'email', label: '$(mail) Account email', description: email || 'not set' },
    { id: 'token', label: '$(key) API token', description: hasToken ? 'set' : 'not set' },
    { id: 'test', label: '$(plug) Test connection' },
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
        prompt: 'Jira base URL',
        value: baseUrl,
        placeHolder: 'https://yourcompany.atlassian.net',
        ignoreFocusOut: true,
      });
      if (v !== undefined) {
        await c.update('jira.baseUrl', v.trim(), G);
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
