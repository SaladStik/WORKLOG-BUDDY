# Worklog Buddy

VS Code extension that notices when you've **actually been coding** (not just leaving the
window open), asks **which Jira ticket** you're on, tracks your work against it, and then
**nudges you to post AI-written updates** — which you review and approve before anything
goes to Jira. Summaries are generated with **NVIDIA NIM**.

## The flow

1. **"Yo — what ticket are you working on?"** Once you cross a threshold of real coding
   (or run the command), it asks. If your Jira connection is set up, it shows your
   assigned tickets in a picker (and guesses from your git branch).
2. **It tracks everything against that ticket** — active editing time, edits, files
   touched, commits — measured _since your last update_, not wall-clock with the window open.
3. **It nudges you periodically:** _"You just committed on PROJ-123 — write an update?"_ or
   _"You've done ~20 min of work — write an update?"_
4. **You review & approve.** It drafts the update from your `git diff` + commits via NIM,
   opens it as an editable doc, and only posts the text **you** approve.
5. **Manage your Jira info** anytime: URL, email, token, test connection, switch ticket.

## Architecture

| File                     | Responsibility                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/activityTracker.ts` | Heartbeat-with-decay — counts real editing, not idle time. Resets each update so a snapshot = "work since last Jira update". |
| `src/gitInfo.ts`         | Branch + Jira-key parsing, HEAD-sha (commit detection), diff/commit evidence.                                                |
| `src/nimClient.ts`       | Calls NVIDIA NIM (OpenAI-compatible) to draft the update.                                                                    |
| `src/jira.ts`            | Post comment, search assigned issues, test connection (REST v3).                                                             |
| `src/extension.ts`       | Active-ticket session, timer-driven nudges, review/approve, Jira management.                                                 |

## Run it (hackathon quick start)

```bash
npm install
npm run compile
```

Press **F5** to launch the Extension Development Host, then:

- **`Worklog: Set NVIDIA NIM API key`** — paste your `nvapi-…` key (stored in
  `SecretStorage`, never in settings or source).
- **`Worklog: Manage Jira connection`** — set URL, email, token; **Test connection**.
- **`Worklog: Start working on a ticket`** — pick from your assigned tickets.
- Edit files / commit. You'll get nudged. To demo instantly, lower
  `worklog.updateReminderMinutes` to `1`, or just run **`Worklog: Write Jira update now`**.

## Settings

| Setting                                       | Default                               | Meaning                                     |
| --------------------------------------------- | ------------------------------------- | ------------------------------------------- |
| `worklog.workThresholdMinutes`                | 25                                    | Active min before the "what ticket?" prompt |
| `worklog.updateReminderMinutes`               | 20                                    | Active min since last update before nudging |
| `worklog.remindOnCommit`                      | true                                  | Nudge right after a commit                  |
| `worklog.snoozeMinutes`                       | 10                                    | Quiet period after snooze/dismiss           |
| `worklog.idleTimeoutMinutes`                  | 3                                     | Gap that stops counting as active           |
| `worklog.autoNudge`                           | true                                  | Master switch for automatic nudges          |
| `worklog.nim.baseUrl`                         | `https://integrate.api.nvidia.com/v1` | NIM endpoint                                |
| `worklog.nim.model`                           | `deepseek-ai/deepseek-v4-pro`         | Summary model                               |
| `worklog.jira.baseUrl` / `worklog.jira.email` | ""                                    | Jira connection (token via SecretStorage)   |

## Commands

- **Worklog: Start working on a ticket** — pick/switch the active ticket
- **Worklog: Write Jira update now** — draft, review, approve, post
- **Worklog: Manage Jira connection** — URL / email / token / test / switch
- **Worklog: Set NVIDIA NIM API key**
- **Worklog: Reset activity session**

## Security note

Your NIM key was shared in plaintext during development — **rotate it**. Both the NIM key
and the Jira token are stored via VS Code `SecretStorage` at runtime, not in settings.
