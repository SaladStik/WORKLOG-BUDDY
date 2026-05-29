written for a cursor meetup in like 45 mins
# Worklog Buddy

Worklog Buddy lives right in your editor and quietly keeps your Jira tickets up to date
for you. It watches when you're **actually coding** (not just leaving VS Code open), and
when you've done real work — or just made a commit — it offers to **write the Jira update
for you**: a worklog entry plus a comment, drafted from your actual `git diff` by
**NVIDIA NIM**.

It's built to help without getting in the way. Nudges are occasional, easy to snooze, and
never post anything on their own — you always review and approve first. No leaving your
editor, no context-switching to Jira, no end-of-day "wait, what did I even do today?"

---

## 5-minute setup

### 1. Install the extension (~1 min)
Either:
- **From the packaged file:** `Cmd+Shift+P` → **Extensions: Install from VSIX…** → pick
  `worklog-buddy-0.0.1.vsix`, then **reload the window**.
- **From source (dev):** open this folder in VS Code → `npm install` → press **F5**.

After installing, reload: `Cmd+Shift+P` → **Developer: Reload Window**.

### 2. Open the panel (~10 sec)
Click the **clock icon** in the left Activity Bar. The **Worklog Buddy → Manage** panel opens.

### 3. Connect Jira (~2 min)
1. Create a Jira API token at
   **https://id.atlassian.com/manage-profile/security/api-tokens** → Create → copy it.
2. In the panel's **Jira connection** section, fill in:
   - **Jira URL** — `https://yourcompany.atlassian.net`
   - **Account email** — the email you log into Jira with
   - **API token** — the token you just copied
3. Click **Test connection**. On success it shows `✓ Connected as <you>` and loads your
   assigned tickets below.

### 4. Add your NIM key (~1 min)
In the **NVIDIA NIM** section, paste your API key (`nvapi-…`). Leave the base URL and
model as-is (`meta/llama-3.1-8b-instruct` is fast and fine for summaries). Click **Save**.

### 5. Start working (~30 sec)
Click one of your tickets in the **Assigned tickets** list to make it active. Now just
code. When you've done a chunk of work — or right after a `git commit` — you'll get a
nudge offering to write the update. Approve it, and it posts to Jira.

> **Demo tip:** to see it fire immediately, set **Remind to update after N active
> minutes** to `1` in the panel, or run **`Worklog: Write Jira update now`** from the
> command palette.

---

## How it works

**1. It detects *real* work, not an idle window.**
Every edit, save, cursor move and window-focus change is a "heartbeat". Time only counts
toward "active" when the gap between heartbeats is short (under the idle timeout) and the
window is focused — so leaving VS Code open on a coffee break adds nothing. The clock
resets every time you post an update, so "active minutes" always means *work since your
last Jira update*.

**2. It asks which ticket you're on.**
Once you cross the activity threshold (or commit), it prompts. It pre-guesses the ticket
key from your git branch (`feature/SCRUM-17-foo`) and can list your assigned, not-Done
tickets straight from Jira so you just click one.

**3. It nudges you at the right moments.**
A timer checks two triggers: **a fresh git commit** ("You just committed on SCRUM-17 —
write an update?") and **accumulated active time** ("You've done ~20 min of work…").
Nudges respect a snooze window so they don't nag.

**4. It drafts the update from what you actually did.**
It gathers evidence — `git diff`, recent commit messages, and the files you touched — and
sends it to NVIDIA NIM. The draft **streams live** into a markdown document so you see it
appear in real time.

**5. You review, then approve.**
Nothing is posted automatically. You get a dialog with **Approve & post** / **Copy** /
**Edit first**. Approving logs a **worklog entry** (time tracking) *and* posts the draft
as a **comment** on the ticket. Want to tweak it first? Choose *Edit first*, edit the doc,
then run **`Worklog: Post current draft`**.

---

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `worklog.workThresholdMinutes` | 25 | Active min before the "what ticket?" prompt |
| `worklog.updateReminderMinutes` | 20 | Active min since last update before nudging |
| `worklog.remindOnCommit` | true | Nudge right after a commit |
| `worklog.snoozeMinutes` | 10 | Quiet period after snooze/dismiss |
| `worklog.idleTimeoutMinutes` | 3 | Gap that stops counting as active |
| `worklog.autoNudge` | true | Master switch for automatic nudges |
| `worklog.nim.baseUrl` | `https://integrate.api.nvidia.com/v1` | NIM endpoint |
| `worklog.nim.model` | `meta/llama-3.1-8b-instruct` | Draft model |
| `worklog.jira.baseUrl` / `worklog.jira.email` | "" | Jira connection (token in SecretStorage) |

All of these are editable from the sidebar panel — you rarely need to touch raw settings.

## Commands

Open with `Cmd+Shift+P`:

- **Worklog: Open management panel** — the sidebar UI
- **Worklog: Start working on a ticket** — pick / switch the active ticket
- **Worklog: Write Jira update now** — draft + review + post on demand
- **Worklog: Post current draft** — post the draft document you've been editing
- **Worklog: Manage Jira connection** — URL / email / token / test / switch
- **Worklog: Set NVIDIA NIM API key**
- **Worklog: Reset activity session**

## Where credentials live

Your **NIM key** and **Jira token** are stored in VS Code's encrypted `SecretStorage` —
never in settings files or source. Jira URL and email are stored in your VS Code settings.

## Project layout

The code is organized in layers — the entry point only wires services together:

```
src/
  extension.ts              Entry point — constructs services, registers commands
  core/
    config.ts               Settings + secrets accessors (SecretStorage)
    lock.ts                 runExclusive mutex — prevents stacked prompts
    session.ts              SessionManager — active ticket, tracker, status bar
    reminders.ts            ReminderService — commit/activity nudge triggers
  features/
    tickets.ts              TicketService — pick / switch the active ticket
    draft.ts                DraftService — generate → review → post a Jira update
    jiraManager.ts          Manage-Jira quick-pick command
  services/
    activityTracker.ts      Heartbeat-with-decay; counts real editing, not idle time
    gitInfo.ts              Branch/key parsing, commit detection, diff evidence
    nimClient.ts            Calls NVIDIA NIM (streaming) to draft the update
    jira.ts                 Worklog, comment, ticket search, connection test (REST v3)
    adf.ts                  Markdown → Jira ADF converter
  webview/
    settingsView.ts         SettingsViewProvider — the sidebar panel
    panelHtml.ts            Panel HTML / CSS / JS
```

Dependencies form a strict DAG: `services` + `core/config` → `core/session` →
`features` → `core/reminders` → `extension`.

## Build from source

```bash
npm install
npm run compile                                   # type-check + build to out/
npx @vscode/vsce package --skip-license --allow-missing-repository   # → .vsix
```

There's also `smoke-test.mjs` for verifying the NIM + Jira integrations outside VS Code:

```bash
node --env-file=.env smoke-test.mjs               # reads creds from a local .env (gitignored)
```
