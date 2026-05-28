import * as vscode from 'vscode';
import { ActivityTracker } from './activityTracker';
import { collectEvidence, collectLastCommitEvidence, getBranch, getHeadSha, parseJiraKey } from './gitInfo';
import { buildPrompt, summarizeStream, NimConfig } from './nimClient';
import {
  addWorklog,
  postComment,
  searchAssignedIssues,
  testConnection,
  JiraConfig,
  JiraIssue,
} from './jira';

const NIM_KEY_SECRET = 'worklog.nimApiKey';
const JIRA_TOKEN_SECRET = 'worklog.jiraToken';
const ACTIVE_TICKET_KEY = 'worklog.activeTicket';

let tracker: ActivityTracker;
let statusItem: vscode.StatusBarItem;
let settingsProvider: SettingsViewProvider | undefined;
let timer: NodeJS.Timeout;
let lastHeadSha: string | undefined;
let snoozeUntil = 0;
let busy = false;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration('worklog');

  tracker = new ActivityTracker(cfg.get<number>('idleTimeoutMinutes', 3));
  tracker.start();

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.show();
  updateStatus(context);

  // Prime the commit detector so the very first tick doesn't fire a false "you committed".
  const folder = getFolder();
  if (folder) {
    void getHeadSha(folder).then((sha) => (lastHeadSha = sha));
  }

  settingsProvider = new SettingsViewProvider(context);

  timer = setInterval(() => void checkTriggers(context), 20_000);

  context.subscriptions.push(
    statusItem,
    new vscode.Disposable(() => clearInterval(timer)),
    new vscode.Disposable(() => tracker.dispose()),

    vscode.window.registerWebviewViewProvider('worklog.settingsView', settingsProvider),
    vscode.commands.registerCommand('worklog.openSettings', () =>
      vscode.commands.executeCommand('worklog.settingsView.focus'),
    ),

    vscode.commands.registerCommand('worklog.startTicket', () =>
      runExclusive(async () => {
        await startTicket(context);
      }),
    ),
    vscode.commands.registerCommand('worklog.updateNow', () =>
      runExclusive(async () => {
        const ticket = getActiveTicket(context) ?? (await startTicket(context));
        if (ticket) {
          await generateAndReview(context, ticket);
        }
      }),
    ),
    vscode.commands.registerCommand('worklog.manageJira', () =>
      runExclusive(() => manageJira(context)),
    ),
    vscode.commands.registerCommand('worklog.setApiKey', () => setSecret(context, NIM_KEY_SECRET, 'NVIDIA NIM API key (nvapi-…)')),
    vscode.commands.registerCommand('worklog.resetSession', () => {
      tracker.reset();
      updateStatus(context);
      vscode.window.showInformationMessage('Worklog activity session reset.');
    }),
    vscode.commands.registerCommand('worklog.postCurrentDraft', () =>
      runExclusive(() => postCurrentDraft(context)),
    ),
    vscode.commands.registerCommand('worklog.writeAboutLastCommit', () =>
      runExclusive(async () => {
        const ticket = getActiveTicket(context) ?? (await startTicket(context));
        if (ticket) {
          await generateAndReview(context, ticket, 'lastCommit');
        }
      }),
    ),

    // Show the title-bar checkmark only when the active editor is a worklog draft.
    vscode.window.onDidChangeActiveTextEditor(() => refreshDraftContext()),
  );

  refreshDraftContext();
}

/** Sets the `worklog.activeDraft` context key based on the active editor's content. */
function refreshDraftContext(): void {
  const editor = vscode.window.activeTextEditor;
  const isDraft =
    !!editor && /^#\s*Worklog update\s*—/m.test(editor.document.getText().slice(0, 200));
  void vscode.commands.executeCommand('setContext', 'worklog.activeDraft', isDraft);
}

export function deactivate(): void {
  clearInterval(timer);
  tracker?.dispose();
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function getFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getActiveTicket(context: vscode.ExtensionContext): string | undefined {
  return context.workspaceState.get<string>(ACTIVE_TICKET_KEY);
}

async function setActiveTicket(context: vscode.ExtensionContext, key: string | undefined): Promise<void> {
  await context.workspaceState.update(ACTIVE_TICKET_KEY, key);
  tracker.reset(); // count time from "now" against the new ticket
  snoozeUntil = 0;
  updateStatus(context);
}

function updateStatus(context: vscode.ExtensionContext): void {
  const ticket = getActiveTicket(context);
  const mins = Math.round(tracker.snapshot().activeSeconds / 60);
  if (ticket) {
    statusItem.text = `$(git-commit) ${ticket} · ${mins}m`;
    statusItem.tooltip = `Worklog: ${mins} active min since last update on ${ticket}. Click to write an update.`;
    statusItem.command = 'worklog.updateNow';
  } else {
    statusItem.text = '$(question) Worklog: set ticket';
    statusItem.tooltip = 'Worklog: click to pick the Jira ticket you are working on.';
    statusItem.command = 'worklog.startTicket';
  }
}

/** Run an interactive flow while suppressing automatic nudges from stacking. */
async function runExclusive(fn: () => Promise<void>): Promise<void> {
  if (busy) {
    return;
  }
  busy = true;
  try {
    await fn();
  } catch (err) {
    vscode.window.showErrorMessage(`Worklog: ${(err as Error).message}`);
  } finally {
    busy = false;
  }
}

function snooze(): void {
  const mins = vscode.workspace.getConfiguration('worklog').get<number>('snoozeMinutes', 10);
  snoozeUntil = Date.now() + mins * 60_000;
}

// ---------------------------------------------------------------------------
// Config / secrets
// ---------------------------------------------------------------------------

async function setSecret(context: vscode.ExtensionContext, key: string, prompt: string): Promise<void> {
  const value = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  if (value) {
    await context.secrets.store(key, value.trim());
    vscode.window.showInformationMessage('Saved.');
  }
}

async function getJiraConfig(context: vscode.ExtensionContext): Promise<JiraConfig | undefined> {
  const cfg = vscode.workspace.getConfiguration('worklog');
  const baseUrl = cfg.get<string>('jira.baseUrl', '');
  const email = cfg.get<string>('jira.email', '');
  const token = await context.secrets.get(JIRA_TOKEN_SECRET);
  if (!baseUrl || !email || !token) {
    return undefined;
  }
  return { baseUrl, email, token };
}

// ---------------------------------------------------------------------------
// Triggers (timer-driven nudges)
// ---------------------------------------------------------------------------

async function checkTriggers(context: vscode.ExtensionContext): Promise<void> {
  updateStatus(context);
  settingsProvider?.pushSession();

  const cfg = vscode.workspace.getConfiguration('worklog');
  if (!cfg.get<boolean>('autoNudge', true)) {
    return;
  }

  // Detect new commits even while busy/snoozed so lastHeadSha stays current.
  let committed = false;
  const folder = getFolder();
  if (folder) {
    const head = await getHeadSha(folder);
    if (head) {
      if (lastHeadSha && head !== lastHeadSha) {
        committed = true;
      }
      lastHeadSha = head;
    }
  }

  if (busy || Date.now() < snoozeUntil) {
    return;
  }

  const ticket = getActiveTicket(context);
  const snap = tracker.snapshot();
  const mins = snap.activeSeconds / 60;

  // Commits always nudge (highest-signal trigger). If no ticket is set yet, ask
  // which ticket this commit was on rather than dropping the signal on the floor.
  if (committed && cfg.get<boolean>('remindOnCommit', true)) {
    if (ticket) {
      await runExclusive(() => nudge(context, ticket, 'You just committed'));
    } else {
      await runExclusive(() => promptNoTicket(context, mins, snap.editCount));
    }
    return;
  }

  if (!ticket) {
    if (snap.editCount > 0 && mins >= cfg.get<number>('workThresholdMinutes', 25)) {
      await runExclusive(() => promptNoTicket(context, mins, snap.editCount));
    }
    return;
  }

  if (mins >= cfg.get<number>('updateReminderMinutes', 20)) {
    await runExclusive(() =>
      nudge(context, ticket, `You've done ~${Math.round(mins)} min of work`),
    );
  }
}

/**
 * Like showInformationMessage, but resolves to undefined if the user ignores it for
 * `timeoutMs`. Without this, an ignored notification keeps the `busy` lock held and
 * blocks every future nudge; with it, an ignored prompt auto-snoozes and re-prompts
 * after the snooze window.
 */
async function askWithTimeout(
  message: string,
  timeoutMs: number,
  ...items: string[]
): Promise<string | undefined> {
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

async function promptNoTicket(
  context: vscode.ExtensionContext,
  mins: number,
  edits: number,
): Promise<void> {
  const choice = await askWithTimeout(
    `Yo — you've been coding for a while (${Math.round(mins)} min · ${edits} edits). What Jira ticket is this?`,
    60_000,
    'Pick ticket',
    'Snooze',
  );
  if (choice === 'Pick ticket') {
    await startTicket(context);
  } else {
    snooze(); // Snooze, dismiss, or ignored-and-timed-out → quiet, then re-prompt later.
  }
}

async function nudge(
  context: vscode.ExtensionContext,
  ticket: string,
  reason: string,
): Promise<void> {
  const choice = await askWithTimeout(
    `${reason} on ${ticket}. Write a Jira update?`,
    60_000,
    'Write update',
    'Snooze',
    'Switch ticket',
  );
  if (choice === 'Write update') {
    await generateAndReview(context, ticket);
  } else if (choice === 'Switch ticket') {
    await startTicket(context);
  } else {
    snooze(); // Snooze, dismiss, or ignored-and-timed-out → quiet, then re-prompt later.
  }
}

// ---------------------------------------------------------------------------
// Ticket selection
// ---------------------------------------------------------------------------

async function startTicket(context: vscode.ExtensionContext): Promise<string | undefined> {
  const folder = getFolder();
  const branch = folder ? await getBranch(folder) : undefined;
  const guess = parseJiraKey(branch);

  const jira = await getJiraConfig(context);
  let chosen: string | undefined;

  if (jira) {
    const picked = await pickFromJira(jira, guess);
    if (picked === undefined) {
      return undefined; // cancelled
    }
    chosen = picked || (await enterTicketManually(guess));
  } else {
    chosen = await enterTicketManually(guess);
  }

  if (chosen) {
    await setActiveTicket(context, chosen);
    vscode.window.showInformationMessage(`Now tracking work on ${chosen}.`);
  }
  return chosen;
}

/** Returns a key, '' to signal "enter manually", or undefined if cancelled. */
async function pickFromJira(jira: JiraConfig, guess: string | undefined): Promise<string | undefined> {
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

async function enterTicketManually(guess: string | undefined): Promise<string | undefined> {
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

// ---------------------------------------------------------------------------
// Generate → review → approve → post
// ---------------------------------------------------------------------------

async function generateAndReview(
  context: vscode.ExtensionContext,
  ticket: string,
  mode: 'session' | 'lastCommit' = 'session',
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('worklog');
  const apiKey = await context.secrets.get(NIM_KEY_SECRET);
  if (!apiKey) {
    const pick = await vscode.window.showWarningMessage('No NVIDIA NIM API key set.', 'Set key now');
    if (pick) {
      await setSecret(context, NIM_KEY_SECRET, 'NVIDIA NIM API key (nvapi-…)');
    }
    return;
  }
  const folder = getFolder();
  if (!folder) {
    vscode.window.showWarningMessage('Open a folder/repo to generate a worklog update.');
    return;
  }

  const snap = tracker.snapshot();
  const sinceMinutes = Math.max(Math.round(snap.activeSeconds / 60) + 5, 15);

  // Open the draft doc first and stream tokens into it so the user sees progress.
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `# Worklog update — ${ticket}\n\n`,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
  refreshDraftContext();

  const streamed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Drafting ${ticket}…` },
    async () => {
      const evidence =
        mode === 'lastCommit'
          ? await collectLastCommitEvidence(folder)
          : await collectEvidence(folder, sinceMinutes);
      const files = mode === 'lastCommit' ? [] : snap.filesTouched;
      const style = cfg.get<string>('updateStyle', '');
      const prompt = buildPrompt(ticket, Math.round(snap.activeSeconds / 60), files, evidence, style);
      const nim: NimConfig = {
        baseUrl: cfg.get<string>('nim.baseUrl', 'https://integrate.api.nvidia.com/v1'),
        model: cfg.get<string>('nim.model', 'meta/llama-3.1-8b-instruct'),
        apiKey,
      };
      try {
        return await summarizeStream(nim, prompt, async (piece) => {
          const edit = new vscode.WorkspaceEdit();
          const end = doc.lineAt(doc.lineCount - 1).range.end;
          edit.insert(doc.uri, end, piece);
          await vscode.workspace.applyEdit(edit);
        });
      } catch (err) {
        vscode.window.showErrorMessage(`NIM request failed: ${(err as Error).message}`);
        return '';
      }
    },
  );

  if (!streamed) {
    return;
  }

  const jira = await getJiraConfig(context);
  const actions = jira ? ['Approve & post', 'Copy', 'Edit first'] : ['Copy', 'Edit first'];
  const choice = await vscode.window.showInformationMessage(
    `Draft ready for ${ticket}.`,
    {
      modal: true,
      detail:
        'Approve & post: logs a worklog entry AND posts the draft as a comment.\n' +
        'Edit first: dismiss this and edit the document. Run "Worklog: Post current draft" when ready.',
    },
    ...actions,
  );

  const finalText = stripHeading(doc.getText());

  if (choice === 'Copy') {
    await vscode.env.clipboard.writeText(finalText);
    vscode.window.showInformationMessage('Update copied to clipboard.');
    markUpdated(context);
  } else if (choice === 'Approve & post' && jira) {
    try {
      // Both: log the time worked AND post the summary as a comment.
      await addWorklog(jira, ticket, snap.activeSeconds, finalText);
      await postComment(jira, ticket, finalText);
      const mins = Math.max(1, Math.round(snap.activeSeconds / 60));
      vscode.window.showInformationMessage(`Logged ${mins}m + posted update to ${ticket}.`);
      markUpdated(context);
    } catch (err) {
      vscode.window.showErrorMessage(`Posting to Jira failed: ${(err as Error).message}`);
    }
  }
  // "Edit first" or Cancel: doc stays open. User runs `worklog.postCurrentDraft` when ready.
}

/**
 * Posts the active markdown editor's content to Jira. Used when the user dismissed
 * the modal to edit the draft, then wants to publish it. The ticket key is parsed
 * from the document's leading "# Worklog update — TICKET" heading.
 */
async function postCurrentDraft(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open the draft document, then run this command again.');
    return;
  }
  const text = editor.document.getText();
  const heading = text.match(/^#\s*Worklog update\s*—\s*([A-Z][A-Z0-9]+-\d+)/m);
  const ticket = heading?.[1] ?? getActiveTicket(context);
  if (!ticket) {
    vscode.window.showWarningMessage('Could not determine the ticket. Set an active ticket first.');
    return;
  }
  const jira = await getJiraConfig(context);
  if (!jira) {
    vscode.window.showWarningMessage('Configure Jira connection first (Manage panel).');
    return;
  }
  const finalText = stripHeading(text);
  const snap = tracker.snapshot();
  try {
    await addWorklog(jira, ticket, snap.activeSeconds, finalText);
    await postComment(jira, ticket, finalText);
    const mins = Math.max(1, Math.round(snap.activeSeconds / 60));
    vscode.window.showInformationMessage(`Logged ${mins}m + posted update to ${ticket}.`);
    markUpdated(context);
  } catch (err) {
    vscode.window.showErrorMessage(`Posting to Jira failed: ${(err as Error).message}`);
  }
}

function markUpdated(context: vscode.ExtensionContext): void {
  // Start the next window fresh so reminders/evidence cover only new work.
  tracker.reset();
  snoozeUntil = 0;
  updateStatus(context);
}

/** Remove a leading markdown heading so it isn't posted into Jira. */
function stripHeading(text: string): string {
  return text.replace(/^#.*\n+/, '').trim();
}

// ---------------------------------------------------------------------------
// Manage Jira connection
// ---------------------------------------------------------------------------

async function manageJira(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('worklog');
  const baseUrl = cfg.get<string>('jira.baseUrl', '');
  const email = cfg.get<string>('jira.email', '');
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

  switch (sel.id) {
    case 'url': {
      const v = await vscode.window.showInputBox({
        prompt: 'Jira base URL',
        value: baseUrl,
        placeHolder: 'https://yourcompany.atlassian.net',
        ignoreFocusOut: true,
      });
      if (v !== undefined) {
        await cfg.update('jira.baseUrl', v.trim(), vscode.ConfigurationTarget.Global);
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
        await cfg.update('jira.email', v.trim(), vscode.ConfigurationTarget.Global);
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
      await startTicket(context);
      break;
  }
}

// ---------------------------------------------------------------------------
// Sidebar webview (management panel)
// ---------------------------------------------------------------------------

function makeNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

class SettingsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
  }

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  pushSession(): void {
    if (!this.view) return;
    const snap = tracker.snapshot();
    this.post({
      type: 'session',
      activeTicket: getActiveTicket(this.context) ?? null,
      activeMinutes: Math.round(snap.activeSeconds / 60),
      edits: snap.editCount,
      files: snap.filesTouched.length,
    });
  }

  private sendSettings(): void {
    const cfg = vscode.workspace.getConfiguration('worklog');
    this.post({
      type: 'settings',
      settings: {
        jiraBaseUrl: cfg.get('jira.baseUrl', ''),
        jiraEmail: cfg.get('jira.email', ''),
        jiraToken: '',
        nimApiKey: '',
        nimBaseUrl: cfg.get('nim.baseUrl', 'https://integrate.api.nvidia.com/v1'),
        nimModel: cfg.get('nim.model', 'meta/llama-3.1-8b-instruct'),
        updateStyle: cfg.get('updateStyle', ''),
        autoNudge: cfg.get('autoNudge', true),
        workThresholdMinutes: cfg.get('workThresholdMinutes', 25),
        updateReminderMinutes: cfg.get('updateReminderMinutes', 20),
        remindOnCommit: cfg.get('remindOnCommit', true),
        idleTimeoutMinutes: cfg.get('idleTimeoutMinutes', 3),
        snoozeMinutes: cfg.get('snoozeMinutes', 10),
      },
    });
  }

  private async onMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.sendSettings();
        this.pushSession();
        break;
      case 'save':
        await this.save(msg.settings as Record<string, unknown>);
        vscode.window.showInformationMessage('Worklog settings saved.');
        break;
      case 'testConnection':
        await this.testAndSignIn(msg as unknown as { jiraBaseUrl: string; jiraEmail: string; jiraToken: string });
        break;
      case 'refreshTickets':
        await this.refreshTickets();
        break;
      case 'selectTicket':
        await setActiveTicket(this.context, msg.key as string);
        this.pushSession();
        break;
      case 'switchTicket':
        await vscode.commands.executeCommand('worklog.startTicket');
        this.pushSession();
        break;
      case 'writeUpdateNow':
        await vscode.commands.executeCommand('worklog.updateNow');
        break;
      case 'writeAboutLastCommit':
        await vscode.commands.executeCommand('worklog.writeAboutLastCommit');
        break;
      case 'resetSession':
        tracker.reset();
        this.pushSession();
        break;
    }
  }

  private async save(s: Record<string, unknown>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('worklog');
    const G = vscode.ConfigurationTarget.Global;
    await cfg.update('jira.baseUrl', (s.jiraBaseUrl as string) ?? '', G);
    await cfg.update('jira.email', (s.jiraEmail as string) ?? '', G);
    await cfg.update('nim.baseUrl', (s.nimBaseUrl as string) ?? '', G);
    await cfg.update('nim.model', (s.nimModel as string) ?? '', G);
    await cfg.update('updateStyle', (s.updateStyle as string) ?? '', G);
    await cfg.update('autoNudge', !!s.autoNudge, G);
    await cfg.update('workThresholdMinutes', Number(s.workThresholdMinutes) || 25, G);
    await cfg.update('updateReminderMinutes', Number(s.updateReminderMinutes) || 20, G);
    await cfg.update('remindOnCommit', !!s.remindOnCommit, G);
    await cfg.update('idleTimeoutMinutes', Number(s.idleTimeoutMinutes) || 3, G);
    await cfg.update('snoozeMinutes', Number(s.snoozeMinutes) || 10, G);
    if (s.jiraToken) await this.context.secrets.store(JIRA_TOKEN_SECRET, s.jiraToken as string);
    if (s.nimApiKey) await this.context.secrets.store(NIM_KEY_SECRET, s.nimApiKey as string);
  }

  private async testAndSignIn(msg: { jiraBaseUrl: string; jiraEmail: string; jiraToken: string }): Promise<void> {
    const token = msg.jiraToken || (await this.context.secrets.get(JIRA_TOKEN_SECRET)) || '';
    if (!msg.jiraBaseUrl || !msg.jiraEmail || !token) {
      this.post({ type: 'connectionStatus', state: 'error', error: 'Fill in URL, email and token.' });
      return;
    }
    this.post({ type: 'connectionStatus', state: 'connecting' });
    try {
      const who = await testConnection({ baseUrl: msg.jiraBaseUrl, email: msg.jiraEmail, token });
      // Persist as "signed in" so subsequent calls (refresh, posting) work.
      const cfg = vscode.workspace.getConfiguration('worklog');
      const G = vscode.ConfigurationTarget.Global;
      await cfg.update('jira.baseUrl', msg.jiraBaseUrl, G);
      await cfg.update('jira.email', msg.jiraEmail, G);
      await this.context.secrets.store(JIRA_TOKEN_SECRET, token);
      this.post({ type: 'connectionStatus', state: 'ok', name: who });
      await this.refreshTickets();
    } catch (err) {
      this.post({ type: 'connectionStatus', state: 'error', error: (err as Error).message });
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

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Worklog Buddy</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 14px; font-size: 13px;
  }
  h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; letter-spacing: 0.02em; text-transform: uppercase; opacity: 0.85; }
  section { margin-bottom: 18px; }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 0 0 14px; }
  label { display: block; margin: 8px 0 4px; font-size: 12px; opacity: 0.85; }
  input[type="text"], input[type="password"], input[type="number"] {
    width: 100%; box-sizing: border-box; padding: 5px 7px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    font: inherit; outline: none;
  }
  input:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
  textarea {
    width: 100%; box-sizing: border-box; padding: 5px 7px; resize: vertical;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    font: inherit; outline: none;
  }
  button {
    padding: 5px 10px; font: inherit; cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-input-border);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .row { display: flex; gap: 8px; align-items: center; }
  .row > * { flex: 0 0 auto; }
  .row .grow { flex: 1 1 auto; min-width: 0; }
  .stats { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
  .badge {
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    padding: 2px 8px; font-size: 11px; border-radius: 2px;
  }
  .ticket {
    display: flex; gap: 8px; align-items: center; padding: 6px 8px;
    border: 1px solid transparent; cursor: pointer;
  }
  .ticket:hover { background: var(--vscode-list-hoverBackground); }
  .ticket.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .ticket .k { font-weight: 600; min-width: 70px; }
  .ticket .s { flex: 1; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ticketList {
    max-height: 180px; overflow-y: auto;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-input-background);
  }
  .empty { padding: 10px; opacity: 0.7; font-size: 12px; }
  .toggleRow { display: flex; align-items: center; justify-content: space-between; margin: 6px 0; }
  .toggle {
    width: 32px; height: 18px; border-radius: 10px; padding: 2px; box-sizing: border-box;
    background: var(--vscode-badge-background); cursor: pointer; transition: background 0.15s;
    border: 1px solid var(--vscode-input-border);
  }
  .toggle.on { background: var(--vscode-button-background); }
  .toggle .knob { width: 12px; height: 12px; border-radius: 50%; background: var(--vscode-foreground); transition: transform 0.15s; }
  .toggle.on .knob { transform: translateX(14px); }
  .status { margin-top: 6px; font-size: 12px; }
  .status.ok { color: var(--vscode-terminal-ansiGreen, #4caf50); }
  .status.error { color: var(--vscode-errorForeground); }
  .reveal { background: none; border: 1px solid var(--vscode-input-border); padding: 5px 7px; }
  .helper { font-size: 11px; opacity: 0.7; margin-top: 4px; }
  .helper a { color: var(--vscode-textLink-foreground); }
  .footer {
    position: sticky; bottom: 0; background: var(--vscode-editor-background);
    padding: 10px 0 0; border-top: 1px solid var(--vscode-panel-border); margin-top: 8px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; }
</style>
</head>
<body>

<section>
  <h2>Session</h2>
  <div class="row">
    <span>Active ticket:</span>
    <span id="activeTicket" style="font-weight:600;">none selected</span>
    <button id="switchTicket">Switch</button>
    <button id="writeUpdateNow" class="primary">Write update</button>
  </div>
  <div class="row" style="margin-top:6px;">
    <button id="writeLastCommit">Write about last commit</button>
  </div>
  <div class="stats">
    <span class="badge" id="statMins">0 min active</span>
    <span class="badge" id="statEdits">0 edits</span>
    <span class="badge" id="statFiles">0 files</span>
  </div>
</section>
<hr/>

<section>
  <h2>Jira connection</h2>
  <label>Jira URL</label>
  <input type="text" id="jiraBaseUrl" placeholder="https://yourcompany.atlassian.net" />
  <label>Account email</label>
  <input type="text" id="jiraEmail" placeholder="you@example.com" />
  <label>API token</label>
  <div class="row">
    <input type="password" id="jiraToken" class="grow" placeholder="ATATT..." />
    <button class="reveal" data-toggle="jiraToken">Show</button>
  </div>
  <div class="row" style="margin-top:8px;">
    <button id="testConnection">Test connection</button>
    <span id="connStatus" class="status">Not connected</span>
  </div>
  <div class="helper">Create an API token at <a href="https://id.atlassian.com/manage-profile/security/api-tokens">id.atlassian.com</a>.</div>
</section>
<hr/>

<section>
  <h2>Assigned tickets</h2>
  <div class="row" style="margin-bottom:6px;">
    <button id="refreshTickets">Refresh</button>
  </div>
  <div id="ticketList" class="ticketList"><div class="empty">Connect to Jira to load your tickets.</div></div>
</section>
<hr/>

<section>
  <h2>NVIDIA NIM</h2>
  <label>API key</label>
  <div class="row">
    <input type="password" id="nimApiKey" class="grow" placeholder="nvapi-..." />
    <button class="reveal" data-toggle="nimApiKey">Show</button>
  </div>
  <label>Base URL</label>
  <input type="text" id="nimBaseUrl" />
  <label>Model</label>
  <input type="text" id="nimModel" />
</section>
<hr/>

<section>
  <h2>Message style</h2>
  <div class="row" style="flex-wrap:wrap; gap:6px; margin-bottom:6px;">
    <button class="preset" data-style="Concise, factual bullet points. No emojis.">Concise</button>
    <button class="preset" data-style="Formal, professional tone in full sentences. No emojis.">Formal</button>
    <button class="preset" data-style="Casual, friendly tone. A few relevant emojis are fine.">Casual</button>
    <button class="preset" data-style="Start with a one-line TL;DR, then a detailed breakdown grouped by file with rationale.">Detailed</button>
  </div>
  <textarea id="updateStyle" rows="3" placeholder="e.g. Formal tone, no emojis, start with a TL;DR line."></textarea>
  <div class="helper">Appended to the AI prompt to control tone &amp; formatting of generated updates.</div>
</section>
<hr/>

<section>
  <h2>Nudge behavior</h2>
  <div class="toggleRow">
    <span>Automatic nudges</span>
    <div class="toggle" id="autoNudge" data-toggle-switch="autoNudge"><div class="knob"></div></div>
  </div>
  <label>Prompt for a ticket after N active minutes</label>
  <input type="number" id="workThresholdMinutes" min="1" />
  <label>Remind to update after N active minutes</label>
  <input type="number" id="updateReminderMinutes" min="1" />
  <div class="toggleRow">
    <span>Remind me right after a commit</span>
    <div class="toggle" id="remindOnCommit" data-toggle-switch="remindOnCommit"><div class="knob"></div></div>
  </div>
  <label>Idle timeout (minutes)</label>
  <input type="number" id="idleTimeoutMinutes" min="1" />
  <label>Snooze duration (minutes)</label>
  <input type="number" id="snoozeMinutes" min="1" />
</section>

<div class="footer">
  <button class="link" id="resetSession">Reset session</button>
  <button class="primary" id="save">Save</button>
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const fields = ['jiraBaseUrl','jiraEmail','jiraToken','nimApiKey','nimBaseUrl','nimModel','updateStyle',
                  'workThresholdMinutes','updateReminderMinutes','idleTimeoutMinutes','snoozeMinutes'];
  const toggles = ['autoNudge','remindOnCommit'];
  let selectedTicket = null;

  function gather() {
    const out = {};
    for (const f of fields) out[f] = $(f).value;
    for (const t of toggles) out[t] = $(t).classList.contains('on');
    return out;
  }
  function applySettings(s) {
    for (const f of fields) if (s[f] !== undefined && s[f] !== null) $(f).value = s[f];
    for (const t of toggles) $(t).classList.toggle('on', !!s[t]);
  }
  function setStatus(state, text, cls) {
    const el = $('connStatus');
    el.className = 'status ' + (cls || '');
    el.textContent = text;
  }
  function renderTickets(items) {
    const list = $('ticketList');
    if (!items || !items.length) {
      list.innerHTML = '<div class="empty">No tickets — connect to Jira and refresh.</div>';
      return;
    }
    list.innerHTML = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'ticket' + (it.key === selectedTicket ? ' active' : '');
      row.innerHTML = '<span class="k"></span><span class="badge"></span><span class="s"></span>';
      row.children[0].textContent = it.key;
      row.children[1].textContent = it.status || '';
      row.children[2].textContent = it.summary || '';
      row.addEventListener('click', () => {
        selectedTicket = it.key;
        vscode.postMessage({ type: 'selectTicket', key: it.key });
        renderTickets(items);
      });
      list.appendChild(row);
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'settings') applySettings(m.settings || {});
    else if (m.type === 'session') {
      selectedTicket = m.activeTicket;
      $('activeTicket').textContent = m.activeTicket || 'none selected';
      $('activeTicket').style.opacity = m.activeTicket ? 1 : 0.6;
      $('statMins').textContent = (m.activeMinutes || 0) + ' min active';
      $('statEdits').textContent = (m.edits || 0) + ' edits';
      $('statFiles').textContent = (m.files || 0) + ' files';
    } else if (m.type === 'connectionStatus') {
      if (m.state === 'connecting') setStatus('connecting','Connecting…','');
      else if (m.state === 'ok') setStatus('ok','✓ Connected as ' + (m.name || 'user'), 'ok');
      else if (m.state === 'error') setStatus('error','✗ ' + (m.error || 'failed'), 'error');
      else setStatus('idle','Not connected','');
    } else if (m.type === 'tickets') renderTickets(m.items || []);
  });

  document.querySelectorAll('[data-toggle]').forEach(b => {
    b.addEventListener('click', () => {
      const id = b.getAttribute('data-toggle');
      const inp = $(id);
      const showing = inp.type === 'text';
      inp.type = showing ? 'password' : 'text';
      b.textContent = showing ? 'Show' : 'Hide';
    });
  });
  document.querySelectorAll('[data-toggle-switch]').forEach(t => {
    t.addEventListener('click', () => t.classList.toggle('on'));
  });
  document.querySelectorAll('.preset').forEach(b => {
    b.addEventListener('click', () => { $('updateStyle').value = b.getAttribute('data-style'); });
  });

  $('save').addEventListener('click', () =>
    vscode.postMessage({ type: 'save', settings: gather() }));
  $('testConnection').addEventListener('click', () =>
    vscode.postMessage({ type: 'testConnection',
      jiraBaseUrl: $('jiraBaseUrl').value, jiraEmail: $('jiraEmail').value, jiraToken: $('jiraToken').value }));
  $('refreshTickets').addEventListener('click', () =>
    vscode.postMessage({ type: 'refreshTickets' }));
  $('switchTicket').addEventListener('click', () =>
    vscode.postMessage({ type: 'switchTicket' }));
  $('writeUpdateNow').addEventListener('click', () =>
    vscode.postMessage({ type: 'writeUpdateNow' }));
  $('writeLastCommit').addEventListener('click', () =>
    vscode.postMessage({ type: 'writeAboutLastCommit' }));
  $('resetSession').addEventListener('click', () =>
    vscode.postMessage({ type: 'resetSession' }));

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

