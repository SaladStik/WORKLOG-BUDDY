import * as vscode from 'vscode';

let busy = false;

/**
 * Runs an interactive flow exclusively. Concurrent calls are dropped while one is
 * active, so automatic nudges never stack on top of a flow the user is already in.
 */
export async function runExclusive(fn: () => Promise<void>): Promise<void> {
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

export function isBusy(): boolean {
  return busy;
}
