import * as vscode from 'vscode';
import {
  getRepoFolder,
  getJiraConfig,
  getNimApiKey,
  getNimEndpoint,
  getUpdateStyle,
  setSecret,
  NIM_KEY_SECRET,
} from '../core/config';
import {
  collectEvidence,
  collectCommitEvidence,
  getCommitRef,
  listRecentCommits,
} from '../services/gitInfo';
import { buildPrompt, summarizeStream, NimConfig } from '../services/nimClient';
import { addWorklog, postComment, JiraConfig } from '../services/jira';
import { SessionManager } from '../core/session';

export type DraftMode = 'session' | 'lastCommit';

const DRAFT_HEADING = /^#\s*Worklog update\s*—\s*([A-Z][A-Z0-9]+-\d+)/m;

/** Sets the `worklog.activeDraft` context key based on the active editor's content. */
export function refreshDraftContext(): void {
  const editor = vscode.window.activeTextEditor;
  const isDraft =
    !!editor && /^#\s*Worklog update\s*—/m.test(editor.document.getText().slice(0, 200));
  void vscode.commands.executeCommand('setContext', 'worklog.activeDraft', isDraft);
}

/** Remove a leading markdown heading so it isn't posted into Jira. */
function stripHeading(text: string): string {
  return text.replace(/^#.*\n+/, '').trim();
}

/**
 * Parse a human duration into seconds: "1h 30m", "45m", "2h", or a bare number
 * (treated as minutes). Returns undefined when the input is blank or unparseable.
 */
function parseDuration(input: string): number | undefined {
  const s = input.trim().toLowerCase();
  if (!s) {
    return undefined;
  }
  if (/^\d+$/.test(s)) {
    return parseInt(s, 10) * 60; // bare number = minutes
  }
  const h = s.match(/(\d+(?:\.\d+)?)\s*h/);
  const m = s.match(/(\d+)\s*m/);
  if (!h && !m) {
    return undefined;
  }
  const total = (h ? parseFloat(h[1]) * 3600 : 0) + (m ? parseInt(m[1], 10) * 60 : 0);
  return Math.round(total);
}

/** Generates, reviews and posts Jira updates (worklog + comment). */
export class DraftService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: SessionManager,
  ) {}

  /**
   * Let the user pick one of the recent commits, then draft an update about it.
   * `commitRef` flows through `generateAndReview` so any commit (not just HEAD) works.
   */
  async writeAboutCommit(ticket: string): Promise<void> {
    const folder = await getRepoFolder();
    if (!folder) {
      vscode.window.showWarningMessage(
        'No git repository found. Open the folder that contains your repo (the one with the .git directory) and try again.',
      );
      return;
    }
    const commits = await listRecentCommits(folder, 30);
    if (!commits.length) {
      vscode.window.showWarningMessage('No commits found in this repository.');
      return;
    }
    const items: (vscode.QuickPickItem & { sha: string })[] = commits.map((c) => ({
      label: c.subject,
      description: `${c.shortSha} · ${c.relative}`,
      sha: c.sha,
    }));
    const sel = await vscode.window.showQuickPick(items, {
      title: `Write update for ${ticket} — which commit?`,
      placeHolder: 'Pick a commit to summarize',
      matchOnDescription: true,
    });
    if (!sel) {
      return;
    }

    // Optional: let the user log a specific amount of time against this commit.
    // Blank → fall back to tracked session time; Esc → cancel the whole flow.
    const timeStr = await vscode.window.showInputBox({
      title: `Time to log on ${ticket} (optional)`,
      prompt: 'How long did this take? e.g. 1h 30m, 45m, 2h. Leave blank to use tracked session time.',
      placeHolder: 'e.g. 1h 30m',
      ignoreFocusOut: true,
      validateInput: (v) =>
        !v.trim() || parseDuration(v) !== undefined ? undefined : 'Use formats like 1h, 30m, or 1h 30m',
    });
    if (timeStr === undefined) {
      return; // cancelled
    }
    const loggedSeconds = parseDuration(timeStr);
    await this.generateAndReview(ticket, 'lastCommit', sel.sha, loggedSeconds);
  }

  async generateAndReview(
    ticket: string,
    mode: DraftMode = 'session',
    commitRef = 'HEAD',
    loggedSecondsOverride?: number,
  ): Promise<void> {
    const apiKey = await getNimApiKey(this.context);
    if (!apiKey) {
      const pick = await vscode.window.showWarningMessage('No NVIDIA NIM API key set.', 'Set key now');
      if (pick) {
        await setSecret(this.context, NIM_KEY_SECRET, 'NVIDIA NIM API key (nvapi-…)');
      }
      return;
    }
    const folder = await getRepoFolder();
    if (!folder) {
      vscode.window.showWarningMessage(
        'No git repository found. Open the folder that contains your repo (the one with the .git directory) and try again.',
      );
      return;
    }

    const snap = this.session.snapshot();
    const sinceMinutes = Math.max(Math.round(snap.activeSeconds / 60) + 5, 15);

    // Open the draft doc first and stream tokens into it so the user sees progress.
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: `# Worklog update — ${ticket}\n\n`,
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    refreshDraftContext();

    const appendToDoc = async (piece: string) => {
      const edit = new vscode.WorkspaceEdit();
      const end = doc.lineAt(doc.lineCount - 1).range.end;
      edit.insert(doc.uri, end, piece);
      await vscode.workspace.applyEdit(edit);
    };

    const streamed = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Drafting ${ticket}…` },
      async () => {
        const evidence =
          mode === 'lastCommit'
            ? await collectCommitEvidence(folder, commitRef)
            : await collectEvidence(folder, sinceMinutes);
        const files = mode === 'lastCommit' ? [] : snap.filesTouched;
        const prompt = buildPrompt(ticket, Math.round(snap.activeSeconds / 60), files, evidence, getUpdateStyle());
        const nim: NimConfig = { ...getNimEndpoint(), apiKey };
        try {
          return await summarizeStream(nim, prompt, appendToDoc);
        } catch (err) {
          vscode.window.showErrorMessage(`NIM request failed: ${(err as Error).message}`);
          return '';
        }
      },
    );
    if (!streamed) {
      return;
    }

    // Append a deterministic commit reference (id + link) so it's always accurate.
    if (mode === 'lastCommit') {
      const ref = await getCommitRef(folder, commitRef);
      if (ref) {
        await appendToDoc(
          ref.url ? `\n\n---\nCommit ${ref.shortSha} — ${ref.url}` : `\n\n---\nCommit ${ref.shortSha}`,
        );
      }
    }

    const jira = await getJiraConfig(this.context);
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
      this.session.markUpdated();
    } else if (choice === 'Approve & post' && jira) {
      await this.post(jira, ticket, finalText, loggedSecondsOverride ?? snap.activeSeconds);
    }
    // "Edit first" or Cancel: doc stays open; user runs `worklog.postCurrentDraft` when ready.
  }

  /**
   * Posts the active markdown editor's content to Jira. Used when the user dismissed
   * the modal to edit the draft. The ticket key is parsed from the leading heading.
   */
  async postCurrentDraft(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Open the draft document, then run this command again.');
      return;
    }
    const text = editor.document.getText();
    const ticket = text.match(DRAFT_HEADING)?.[1] ?? this.session.getActiveTicket();
    if (!ticket) {
      vscode.window.showWarningMessage('Could not determine the ticket. Set an active ticket first.');
      return;
    }
    const jira = await getJiraConfig(this.context);
    if (!jira) {
      vscode.window.showWarningMessage('Configure Jira connection first (Manage panel).');
      return;
    }
    await this.post(jira, ticket, stripHeading(text), this.session.snapshot().activeSeconds);
  }

  /** Log a worklog entry AND post the summary as a comment, then reset the session. */
  private async post(jira: JiraConfig, ticket: string, text: string, activeSeconds: number): Promise<void> {
    try {
      await addWorklog(jira, ticket, activeSeconds, text);
      await postComment(jira, ticket, text);
      const mins = Math.max(1, Math.round(activeSeconds / 60));
      vscode.window.showInformationMessage(`Logged ${mins}m + posted update to ${ticket}.`);
      this.session.markUpdated();
    } catch (err) {
      vscode.window.showErrorMessage(`Posting to Jira failed: ${(err as Error).message}`);
    }
  }
}
