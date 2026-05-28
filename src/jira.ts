export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
}

function authHeader(cfg: JiraConfig): string {
  return 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');
}

function base(cfg: JiraConfig): string {
  return cfg.baseUrl.replace(/\/$/, '');
}

/** Posts the summary as a comment on the issue using the Jira Cloud REST API v3 (ADF body). */
export async function postComment(cfg: JiraConfig, issueKey: string, text: string): Promise<void> {
  const res = await fetch(`${base(cfg)}/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(cfg),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ body: adf(text) }),
  });

  if (!res.ok) {
    throw new Error(`Jira responded ${res.status}: ${await res.text()}`);
  }
}

/** Split a line into ADF text nodes, wrapping any URLs in clickable link marks. */
function inlineNodes(line: string): unknown[] {
  const urlRe = /(https?:\/\/[^\s)]+)/g;
  const nodes: unknown[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(line)) !== null) {
    if (m.index > last) {
      nodes.push({ type: 'text', text: line.slice(last, m.index) });
    }
    nodes.push({ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[1] } }] });
    last = m.index + m[1].length;
  }
  if (last < line.length) {
    nodes.push({ type: 'text', text: line.slice(last) });
  }
  return nodes.length ? nodes : [{ type: 'text', text: line }];
}

/** Build an Atlassian Document Format (ADF) doc from plain text lines. */
function adf(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line.trim() ? inlineNodes(line) : [],
    })),
  };
}

/** Logs a worklog entry (time tracking) with a description on the issue. */
export async function addWorklog(
  cfg: JiraConfig,
  issueKey: string,
  timeSpentSeconds: number,
  text: string,
): Promise<void> {
  // Jira requires at least 60 seconds.
  const seconds = Math.max(60, Math.round(timeSpentSeconds));
  const res = await fetch(`${base(cfg)}/rest/api/3/issue/${issueKey}/worklog`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(cfg),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ timeSpentSeconds: seconds, comment: adf(text) }),
  });
  if (!res.ok) {
    throw new Error(`Jira worklog responded ${res.status}: ${await res.text()}`);
  }
}

/**
 * Returns the current user's open (not-Done) issues, most recently updated first.
 * Uses the enhanced `/search/jql` endpoint, falling back to the legacy `/search`
 * endpoint for older Jira instances.
 */
export async function searchAssignedIssues(cfg: JiraConfig, max = 25): Promise<JiraIssue[]> {
  const jql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
  const params = `jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=summary,status`;
  const headers = { Authorization: authHeader(cfg), Accept: 'application/json' };

  let res = await fetch(`${base(cfg)}/rest/api/3/search/jql?${params}`, { headers });
  if (res.status === 404 || res.status === 410) {
    res = await fetch(`${base(cfg)}/rest/api/3/search?${params}`, { headers });
  }
  if (!res.ok) {
    throw new Error(`Jira search responded ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    issues?: Array<{ key: string; fields?: { summary?: string; status?: { name?: string } } }>;
  };
  return (data.issues ?? []).map((i) => ({
    key: i.key,
    summary: i.fields?.summary ?? '',
    status: i.fields?.status?.name ?? '',
  }));
}

/** Lightweight connection check — returns the authenticated account's display name. */
export async function testConnection(cfg: JiraConfig): Promise<string> {
  const res = await fetch(`${base(cfg)}/rest/api/3/myself`, {
    headers: { Authorization: authHeader(cfg), Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Jira responded ${res.status}: ${await res.text()}`);
  }
  const me = (await res.json()) as { displayName?: string; emailAddress?: string };
  return me.displayName || me.emailAddress || 'authenticated';
}
