import * as vscode from 'vscode';

function makeNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

/** Self-contained HTML for the sidebar management panel webview. */
export function getPanelHtml(webview: vscode.Webview): string {
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
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 0; font-size: 13px;
  }

  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px 10px; border-bottom: 1px solid var(--vscode-panel-border);
    position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 5;
  }
  .brand { font-weight: 600; letter-spacing: 0.02em; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; padding: 3px 9px; border-radius: 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .pill.ok { color: var(--vscode-terminal-ansiGreen, #4caf50); }
  .pill.error { color: var(--vscode-errorForeground); }

  .tabs {
    display: flex; padding: 0 8px; border-bottom: 1px solid var(--vscode-panel-border);
    position: sticky; top: 44px; background: var(--vscode-editor-background); z-index: 4;
  }
  .tab {
    background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--vscode-foreground); opacity: 0.6; cursor: pointer;
    padding: 8px 12px; font: inherit; transition: opacity 0.15s, border-color 0.15s;
  }
  .tab:hover { opacity: 0.9; }
  .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, var(--vscode-button-background)); }

  .panel { display: none; padding: 14px; }
  .panel.active { display: block; animation: fade 0.18s ease; }
  @keyframes fade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

  .card {
    border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    background: var(--vscode-editorWidget-background, transparent);
    padding: 12px; margin-bottom: 12px;
  }
  .card h3 {
    margin: 0 0 10px; font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; opacity: 0.7;
  }

  label { display: block; margin: 9px 0 4px; font-size: 12px; opacity: 0.85; }
  input[type="text"], input[type="password"], input[type="number"], textarea {
    width: 100%; padding: 6px 8px; border-radius: 4px; font: inherit; outline: none;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); transition: border-color 0.15s;
  }
  input:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
  textarea { resize: vertical; }

  button {
    padding: 6px 11px; border-radius: 4px; font: inherit; cursor: pointer;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-input-border); transition: background 0.15s;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.block { width: 100%; }

  .row { display: flex; gap: 8px; align-items: center; }
  .row .grow { flex: 1 1 auto; min-width: 0; }
  .btns { display: flex; flex-direction: column; gap: 8px; }
  .reveal { flex: 0 0 auto; }

  .ticket-hero { font-size: 16px; font-weight: 600; margin: 2px 0 10px; }
  .ticket-hero.none { opacity: 0.55; font-weight: 400; font-style: italic; }

  /* Repo picker - only shown in multi-root workspaces with more than one repo. */
  .repoSection { margin-bottom: 12px; }
  .repoHead { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
  .repoHead .lbl { font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; opacity: 0.7; }
  .repoHead .hint { font-size: 11px; opacity: 0.55; }
  .repoList { border: 1px solid var(--vscode-panel-border); border-radius: 4px;
    background: var(--vscode-input-background); overflow: hidden; }
  .repoItem { display: flex; align-items: center; gap: 8px; padding: 7px 9px; cursor: pointer;
    border-left: 2px solid transparent; transition: background 0.12s; }
  .repoItem + .repoItem { border-top: 1px solid var(--vscode-panel-border); }
  .repoItem:hover { background: var(--vscode-list-hoverBackground); }
  .repoItem.focused { background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); border-left-color: var(--vscode-focusBorder); }
  .repoItem .check { flex: 0 0 auto; width: 15px; height: 15px; border-radius: 3px;
    border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background);
    display: inline-flex; align-items: center; justify-content: center; font-size: 11px; line-height: 1; }
  .repoItem .check.on { background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); border-color: transparent; }
  .repoItem .nm { font-weight: 600; flex: 0 0 auto; max-width: 45%; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .repoItem .tk { flex: 1; text-align: right; opacity: 0.85; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .repoItem .tk.none { opacity: 0.5; font-style: italic; }
  .repoItem .pin { flex: 0 0 auto; opacity: 0.5; font-size: 11px; }
  .repoItem.focused .pin { opacity: 1; }
  .stats { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    padding: 3px 9px; font-size: 11px; border-radius: 10px; }

  .ticketList { max-height: 240px; overflow-y: auto; border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; background: var(--vscode-input-background); margin-top: 8px; }
  .ticket { display: flex; gap: 8px; align-items: center; padding: 7px 9px; cursor: pointer;
    border-left: 2px solid transparent; transition: background 0.12s; }
  .ticket:hover { background: var(--vscode-list-hoverBackground); }
  .ticket.active { background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground); border-left-color: var(--vscode-focusBorder); }
  .ticket .k { font-weight: 600; min-width: 64px; }
  .ticket .s { flex: 1; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { padding: 12px; opacity: 0.65; font-size: 12px; text-align: center; }

  .toggleRow { display: flex; align-items: center; justify-content: space-between; margin: 10px 0; }
  .toggle { width: 34px; height: 18px; border-radius: 10px; padding: 2px; flex: 0 0 auto;
    background: var(--vscode-badge-background); cursor: pointer; transition: background 0.15s;
    border: 1px solid var(--vscode-input-border); }
  .toggle.on { background: var(--vscode-button-background); }
  .toggle .knob { width: 12px; height: 12px; border-radius: 50%; background: var(--vscode-foreground); transition: transform 0.15s; }
  .toggle.on .knob { transform: translateX(16px); }

  .presets { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .preset { padding: 4px 9px; font-size: 12px; border-radius: 10px; }

  .status { font-size: 12px; opacity: 0.85; }
  .status.ok { color: var(--vscode-terminal-ansiGreen, #4caf50); }
  .status.error { color: var(--vscode-errorForeground); }
  .helper { font-size: 11px; opacity: 0.65; margin-top: 6px; }
  .helper a { color: var(--vscode-textLink-foreground); }

  .savebar { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: flex-end;
    gap: 12px; padding: 10px 0 2px; margin-top: 4px; background: var(--vscode-editor-background);
    border-top: 1px solid var(--vscode-panel-border); }
  .saved { font-size: 12px; color: var(--vscode-terminal-ansiGreen, #4caf50); opacity: 0; transition: opacity 0.2s; }
  .saved.show { opacity: 1; }
</style>
</head>
<body>

<header>
  <span class="brand">Worklog Buddy</span>
  <span class="pill" id="connPill"><span class="dot"></span><span id="connPillText">Not connected</span></span>
</header>

<nav class="tabs">
  <button class="tab active" data-tab="activity">Activity</button>
  <button class="tab" data-tab="settings">Settings</button>
</nav>

<div class="panel active" id="panel-activity">
  <div class="card">
    <h3>Current session</h3>
    <div class="repoSection" id="repoSection" style="display:none">
      <div class="repoHead">
        <span class="lbl">Repositories</span>
        <span class="hint">check to track &middot; click to focus</span>
      </div>
      <div class="repoList" id="repoList"></div>
    </div>
    <div class="ticket-hero none" id="activeTicket">No ticket selected</div>
    <div class="stats">
      <span class="badge" id="statMins">0 min active</span>
      <span class="badge" id="statEdits">0 edits</span>
      <span class="badge" id="statFiles">0 files</span>
    </div>
    <div class="btns">
      <button class="primary block" id="writeUpdateNow">Write update</button>
      <button class="block" id="writeAllRepos" style="display:none">Write updates for tracked repos</button>
      <button class="block" id="writeLastCommit">Write about last commit</button>
      <button class="block" id="writeAboutCommit">Write about a specific commit…</button>
      <div class="row">
        <button class="grow" id="switchTicket">Switch ticket</button>
        <button class="grow" id="resetSession">Reset session</button>
      </div>
    </div>
  </div>

  <div class="card">
    <h3>Assigned tickets</h3>
    <button class="block" id="refreshTickets">Refresh from Jira</button>
    <div id="ticketList" class="ticketList"><div class="empty">Connect to Jira to load your tickets.</div></div>
  </div>
</div>

<div class="panel" id="panel-settings">
  <div class="card">
    <h3>Jira connection</h3>
    <label>Jira URL</label>
    <input type="text" id="jiraBaseUrl" placeholder="https://yourcompany.atlassian.net" />
    <label>Account email</label>
    <input type="text" id="jiraEmail" placeholder="you@example.com" />
    <label>API token</label>
    <div class="row">
      <input type="password" id="jiraToken" class="grow" placeholder="ATATT..." />
      <button class="reveal" data-toggle="jiraToken">Show</button>
    </div>
    <div class="row" style="margin-top:10px;">
      <button id="testConnection">Test connection</button>
      <span id="connStatus" class="status">Not connected</span>
    </div>
    <div class="helper">Create an API token at <a href="https://id.atlassian.com/manage-profile/security/api-tokens">id.atlassian.com</a>.</div>
  </div>

  <div class="card">
    <h3>NVIDIA NIM</h3>
    <label>API key</label>
    <div class="row">
      <input type="password" id="nimApiKey" class="grow" placeholder="nvapi-..." />
      <button class="reveal" data-toggle="nimApiKey">Show</button>
    </div>
    <div class="helper">Get an API key at <a href="https://build.nvidia.com">build.nvidia.com</a>. Open any model and click <em>Get API Key</em>.</div>
    <label>Base URL</label>
    <input type="text" id="nimBaseUrl" />
    <label>Model</label>
    <input type="text" id="nimModel" />
    <div class="row" style="margin-top:10px;">
      <button id="testNim">Test NIM</button>
      <span id="nimStatus" class="status">Not tested</span>
    </div>
  </div>

  <div class="card">
    <h3>Message style</h3>
    <div class="presets">
      <button class="preset" data-style="Concise, factual bullet points. No emojis.">Concise</button>
      <button class="preset" data-style="Formal, professional tone in full sentences. No emojis.">Formal</button>
      <button class="preset" data-style="Casual, friendly tone. A few relevant emojis are fine.">Casual</button>
      <button class="preset" data-style="Start with a one-line TL;DR, then a detailed breakdown grouped by file with rationale.">Detailed</button>
    </div>
    <textarea id="updateStyle" rows="3" placeholder="e.g. Formal tone, no emojis, start with a TL;DR line."></textarea>
    <div class="helper">Appended to the AI prompt to control tone &amp; formatting.</div>
  </div>

  <div class="card">
    <h3>Nudge behavior</h3>
    <div class="toggleRow">
      <span>Automatic nudges</span>
      <div class="toggle" id="autoNudge" data-toggle-switch="autoNudge"><div class="knob"></div></div>
    </div>
    <div class="toggleRow">
      <span>Remind me right after a commit</span>
      <div class="toggle" id="remindOnCommit" data-toggle-switch="remindOnCommit"><div class="knob"></div></div>
    </div>
    <label>Prompt for a ticket after N active minutes</label>
    <input type="number" id="workThresholdMinutes" min="1" />
    <label>Remind to update after N active minutes</label>
    <input type="number" id="updateReminderMinutes" min="1" />
    <label>Idle timeout (minutes)</label>
    <input type="number" id="idleTimeoutMinutes" min="1" />
    <label>Snooze duration (minutes)</label>
    <input type="number" id="snoozeMinutes" min="1" />
  </div>

  <div class="savebar">
    <span class="saved" id="savedMsg">✓ Saved</span>
    <button class="primary" id="save">Save settings</button>
  </div>
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
  function setConn(state, text) {
    const pill = $('connPill'); const inline = $('connStatus');
    const cls = state === 'ok' ? ' ok' : state === 'error' ? ' error' : '';
    pill.className = 'pill' + cls;
    $('connPillText').textContent = text;
    inline.className = 'status' + cls;
    inline.textContent = text;
  }
  function renderTickets(items) {
    const list = $('ticketList');
    if (!items || !items.length) {
      list.innerHTML = '<div class="empty">No tickets. Connect to Jira and refresh.</div>';
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

  // The repo picker is only shown when the workspace has more than one git repo.
  // Checkbox = track this repo (nudges + batch updates). Row click = focus it (sticky pin).
  function renderRepos(repos, currentRoot, pinned) {
    const section = $('repoSection');
    const list = $('repoList');
    const multi = repos && repos.length > 1;
    section.style.display = multi ? 'block' : 'none';
    $('writeAllRepos').style.display = multi ? 'block' : 'none';
    if (!multi) { list.innerHTML = ''; return; }

    list.innerHTML = '';
    let trackedCount = 0;
    for (const r of repos) {
      if (r.included) trackedCount++;
      const focused = r.root === currentRoot;
      const item = document.createElement('div');
      item.className = 'repoItem' + (focused ? ' focused' : '');
      item.title = focused ? (pinned ? 'Pinned. Click to unpin and follow the editor.' : 'Click to pin focus here.') : 'Click to focus this repo.';
      item.innerHTML = '<span class="check"></span><span class="nm"></span>'
        + '<span class="tk"></span><span class="pin"></span>';
      const check = item.children[0];
      check.className = 'check' + (r.included ? ' on' : '');
      check.textContent = r.included ? '✓' : '';
      check.title = r.included ? 'Tracked. Click to stop tracking.' : 'Not tracked. Click to track.';
      item.children[1].textContent = r.name;
      const tk = item.children[2];
      tk.textContent = r.ticket || 'no ticket';
      tk.className = 'tk' + (r.ticket ? '' : ' none');
      item.children[3].textContent = focused && pinned ? '📌' : '';

      check.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'setRepoIncluded', root: r.root, included: !r.included });
      });
      item.addEventListener('click', () => {
        vscode.postMessage({ type: 'focusRepo', root: r.root });
      });
      list.appendChild(item);
    }
    $('writeAllRepos').textContent = 'Write updates for ' + trackedCount + ' tracked repo'
      + (trackedCount === 1 ? '' : 's');
    $('writeAllRepos').disabled = trackedCount === 0;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'settings') applySettings(m.settings || {});
    else if (m.type === 'session') {
      selectedTicket = m.activeTicket;
      const el = $('activeTicket');
      el.textContent = m.activeTicket || 'No ticket selected';
      el.className = 'ticket-hero' + (m.activeTicket ? '' : ' none');
      $('statMins').textContent = (m.activeMinutes || 0) + ' min active';
      $('statEdits').textContent = (m.edits || 0) + ' edits';
      $('statFiles').textContent = (m.files || 0) + ' files';
      renderRepos(m.repos, m.currentRepo, m.pinned);
    } else if (m.type === 'connectionStatus') {
      if (m.state === 'connecting') setConn('connecting','Connecting…');
      else if (m.state === 'ok') setConn('ok','Connected as ' + (m.name || 'user'));
      else if (m.state === 'error') setConn('error', m.error || 'Connection failed');
      else setConn('idle','Not connected');
    } else if (m.type === 'nimStatus') {
      const el = $('nimStatus');
      if (m.state === 'connecting') { el.className = 'status'; el.textContent = 'Testing…'; }
      else if (m.state === 'ok') { el.className = 'status ok'; el.textContent = '✓ ' + (m.model || 'NIM reachable'); }
      else if (m.state === 'error') { el.className = 'status error'; el.textContent = m.error || 'Test failed'; }
    } else if (m.type === 'tickets') renderTickets(m.items || []);
    else if (m.type === 'saved') {
      const s = $('savedMsg'); s.classList.add('show');
      setTimeout(() => s.classList.remove('show'), 1800);
    }
  });

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('panel-' + t.getAttribute('data-tab')).classList.add('active');
  }));

  document.querySelectorAll('[data-toggle]').forEach(b => {
    b.addEventListener('click', () => {
      const inp = $(b.getAttribute('data-toggle'));
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

  $('save').addEventListener('click', () => vscode.postMessage({ type: 'save', settings: gather() }));
  $('testConnection').addEventListener('click', () => vscode.postMessage({ type: 'testConnection',
    jiraBaseUrl: $('jiraBaseUrl').value, jiraEmail: $('jiraEmail').value, jiraToken: $('jiraToken').value }));
  $('testNim').addEventListener('click', () => vscode.postMessage({ type: 'testNim',
    nimApiKey: $('nimApiKey').value, nimBaseUrl: $('nimBaseUrl').value, nimModel: $('nimModel').value }));
  $('refreshTickets').addEventListener('click', () => vscode.postMessage({ type: 'refreshTickets' }));
  $('switchTicket').addEventListener('click', () => vscode.postMessage({ type: 'switchTicket' }));
  $('writeUpdateNow').addEventListener('click', () => vscode.postMessage({ type: 'writeUpdateNow' }));
  $('writeAllRepos').addEventListener('click', () => vscode.postMessage({ type: 'writeSelectedRepos' }));
  $('writeLastCommit').addEventListener('click', () => vscode.postMessage({ type: 'writeAboutLastCommit' }));
  $('writeAboutCommit').addEventListener('click', () => vscode.postMessage({ type: 'writeAboutCommit' }));
  $('resetSession').addEventListener('click', () => vscode.postMessage({ type: 'resetSession' }));

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
