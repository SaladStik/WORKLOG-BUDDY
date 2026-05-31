// Standalone integration smoke test - exercises the REAL compiled modules
// (out/nimClient.js, out/jira.js) without the VS Code layer.
//
// Run after `npm run compile`. Reads everything from env vars (no secrets on disk):
//
//   NIM_API_KEY=nvapi-...                  (required for NIM test)
//   NIM_MODEL=deepseek-ai/deepseek-v4-pro  (optional override)
//   JIRA_BASE_URL=https://you.atlassian.net
//   JIRA_EMAIL=you@example.com
//   JIRA_TOKEN=...                         (Jira API token)
//   JIRA_TEST_ISSUE=PROJ-123               (optional: actually post a comment+worklog)
//
// Example:
//   NIM_API_KEY=nvapi-xxx node smoke-test.mjs

import { summarize, buildPrompt } from './out/nimClient.js';
import {
  testConnection,
  searchAssignedIssues,
  postComment,
  addWorklog,
} from './out/jira.js';

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function testNim() {
  head('NVIDIA NIM');
  const apiKey = process.env.NIM_API_KEY;
  if (!apiKey) {
    console.log('  (skipped - set NIM_API_KEY)');
    return;
  }
  const cfg = {
    apiKey,
    baseUrl: process.env.NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    model: process.env.NIM_MODEL || 'deepseek-ai/deepseek-v4-pro',
  };
  const prompt = buildPrompt('DEMO-1', 18, ['src/auth.ts', 'src/login.ts'], {
    statText: ' src/auth.ts | 24 +++++---\n src/login.ts | 8 ++--',
    commits: 'a1b2c3d add token refresh\ne4f5g6h fix expiry check',
    diff: '@@ added refreshToken() and wired it into the login flow @@',
  });
  try {
    const out = await summarize(cfg, prompt);
    ok(`model "${cfg.model}" responded (${out.length} chars)`);
    console.log('\n--- sample summary ---\n' + out + '\n----------------------');
  } catch (e) {
    bad(`NIM call failed: ${e.message}`);
  }
}

async function testJira() {
  head('Jira');
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN, JIRA_TEST_ISSUE } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_TOKEN) {
    console.log('  (skipped - set JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN)');
    return;
  }
  const cfg = { baseUrl: JIRA_BASE_URL, email: JIRA_EMAIL, token: JIRA_TOKEN };

  try {
    const who = await testConnection(cfg);
    ok(`authenticated as ${who}`);
  } catch (e) {
    bad(`auth failed: ${e.message}`);
    return;
  }

  try {
    const issues = await searchAssignedIssues(cfg, 5);
    ok(`ticket search returned ${issues.length} issue(s)`);
    issues.forEach((i) => console.log(`    ${i.key}  [${i.status}]  ${i.summary}`));
  } catch (e) {
    bad(`ticket search failed: ${e.message}`);
  }

  if (JIRA_TEST_ISSUE) {
    const text = `Smoke test ${new Date().toISOString()} - verifying worklog + comment.`;
    try {
      await addWorklog(cfg, JIRA_TEST_ISSUE, 60, text);
      ok(`logged work on ${JIRA_TEST_ISSUE}`);
    } catch (e) {
      bad(`worklog failed: ${e.message}`);
    }
    try {
      await postComment(cfg, JIRA_TEST_ISSUE, text);
      ok(`posted comment on ${JIRA_TEST_ISSUE}`);
    } catch (e) {
      bad(`comment failed: ${e.message}`);
    }
  } else {
    console.log('  (set JIRA_TEST_ISSUE=PROJ-123 to test posting a comment + worklog)');
  }
}

await testNim();
await testJira();
console.log('\nDone.');
