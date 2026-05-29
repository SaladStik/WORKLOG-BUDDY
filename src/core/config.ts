import * as vscode from 'vscode';
import * as path from 'path';
import type { JiraConfig } from '../services/jira';
import { findRepoRoot } from '../services/gitInfo';

export const NIM_KEY_SECRET = 'worklog.nimApiKey';
export const JIRA_TOKEN_SECRET = 'worklog.jiraToken';

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('worklog');
}

/** Absolute path of the first workspace folder, or undefined when none is open. */
export function getFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Resolve the git repository to operate on. Tries the active editor's file first
 * (so a nested or multi-root repo is found), then each workspace folder, and
 * returns the actual repo root (`--show-toplevel`). This is what git commands
 * should use — `getFolder()` alone breaks when the opened folder isn't the repo
 * root (parent folder opened, repo in a subfolder, or multi-root workspace).
 */
export async function getRepoFolder(): Promise<string | undefined> {
  const candidates: string[] = [];
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    candidates.push(path.dirname(active.fsPath));
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(folder.uri.fsPath);
  }
  for (const dir of candidates) {
    const root = await findRepoRoot(dir);
    if (root) {
      return root;
    }
  }
  return undefined;
}

/** Full Jira config (settings + token) or undefined if any part is missing. */
export async function getJiraConfig(context: vscode.ExtensionContext): Promise<JiraConfig | undefined> {
  const c = cfg();
  const baseUrl = c.get<string>('jira.baseUrl', '');
  const email = c.get<string>('jira.email', '');
  const token = await context.secrets.get(JIRA_TOKEN_SECRET);
  if (!baseUrl || !email || !token) {
    return undefined;
  }
  return { baseUrl, email, token };
}

export function getNimEndpoint(): { baseUrl: string; model: string } {
  const c = cfg();
  return {
    baseUrl: c.get<string>('nim.baseUrl', 'https://integrate.api.nvidia.com/v1'),
    model: c.get<string>('nim.model', 'meta/llama-3.1-8b-instruct'),
  };
}

export async function getNimApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(NIM_KEY_SECRET);
}

export function getUpdateStyle(): string {
  return cfg().get<string>('updateStyle', '');
}

/** Prompt for and store a secret (NIM key / Jira token) in SecretStorage. */
export async function setSecret(context: vscode.ExtensionContext, key: string, prompt: string): Promise<void> {
  const value = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  if (value) {
    await context.secrets.store(key, value.trim());
    vscode.window.showInformationMessage('Saved.');
  }
}

export interface PanelSettings {
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraToken: string;
  nimApiKey: string;
  nimBaseUrl: string;
  nimModel: string;
  updateStyle: string;
  autoNudge: boolean;
  workThresholdMinutes: number;
  updateReminderMinutes: number;
  remindOnCommit: boolean;
  idleTimeoutMinutes: number;
  snoozeMinutes: number;
}

/** Settings to send to the webview. Secrets are returned blank — never echoed back. */
export function readPanelSettings(): PanelSettings {
  const c = cfg();
  return {
    jiraBaseUrl: c.get('jira.baseUrl', ''),
    jiraEmail: c.get('jira.email', ''),
    jiraToken: '',
    nimApiKey: '',
    nimBaseUrl: c.get('nim.baseUrl', 'https://integrate.api.nvidia.com/v1'),
    nimModel: c.get('nim.model', 'meta/llama-3.1-8b-instruct'),
    updateStyle: c.get('updateStyle', ''),
    autoNudge: c.get('autoNudge', true),
    workThresholdMinutes: c.get('workThresholdMinutes', 25),
    updateReminderMinutes: c.get('updateReminderMinutes', 20),
    remindOnCommit: c.get('remindOnCommit', true),
    idleTimeoutMinutes: c.get('idleTimeoutMinutes', 3),
    snoozeMinutes: c.get('snoozeMinutes', 10),
  };
}

/** Persist settings from the webview. Secrets are only overwritten when non-empty. */
export async function savePanelSettings(
  context: vscode.ExtensionContext,
  s: Record<string, unknown>,
): Promise<void> {
  const c = cfg();
  const G = vscode.ConfigurationTarget.Global;
  await c.update('jira.baseUrl', (s.jiraBaseUrl as string) ?? '', G);
  await c.update('jira.email', (s.jiraEmail as string) ?? '', G);
  await c.update('nim.baseUrl', (s.nimBaseUrl as string) ?? '', G);
  await c.update('nim.model', (s.nimModel as string) ?? '', G);
  await c.update('updateStyle', (s.updateStyle as string) ?? '', G);
  await c.update('autoNudge', !!s.autoNudge, G);
  await c.update('workThresholdMinutes', Number(s.workThresholdMinutes) || 25, G);
  await c.update('updateReminderMinutes', Number(s.updateReminderMinutes) || 20, G);
  await c.update('remindOnCommit', !!s.remindOnCommit, G);
  await c.update('idleTimeoutMinutes', Number(s.idleTimeoutMinutes) || 3, G);
  await c.update('snoozeMinutes', Number(s.snoozeMinutes) || 10, G);
  if (s.jiraToken) {
    await context.secrets.store(JIRA_TOKEN_SECRET, s.jiraToken as string);
  }
  if (s.nimApiKey) {
    await context.secrets.store(NIM_KEY_SECRET, s.nimApiKey as string);
  }
}

/** Persist a verified Jira connection (used by the panel's Test-connection sign-in). */
export async function persistJiraConnection(
  context: vscode.ExtensionContext,
  baseUrl: string,
  email: string,
  token: string,
): Promise<void> {
  const c = cfg();
  const G = vscode.ConfigurationTarget.Global;
  await c.update('jira.baseUrl', baseUrl, G);
  await c.update('jira.email', email, G);
  await context.secrets.store(JIRA_TOKEN_SECRET, token);
}
