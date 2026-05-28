/* eslint-disable @typescript-eslint/no-explicit-any */
type AdfNode = Record<string, any>;

/**
 * Parses inline markdown in a single line into ADF text nodes: **bold**, *italic*,
 * `code`, [text](url), and bare URLs — each with the appropriate ADF mark. The model
 * emits markdown, which Jira would otherwise render as literal asterisks/backticks.
 */
function parseInline(text: string): AdfNode[] {
  const patterns: { re: RegExp; make: (m: RegExpMatchArray) => AdfNode }[] = [
    { re: /`([^`]+)`/, make: (m) => ({ type: 'text', text: m[1], marks: [{ type: 'code' }] }) },
    { re: /\*\*([^*]+)\*\*/, make: (m) => ({ type: 'text', text: m[1], marks: [{ type: 'strong' }] }) },
    { re: /__([^_]+)__/, make: (m) => ({ type: 'text', text: m[1], marks: [{ type: 'strong' }] }) },
    {
      re: /\[([^\]]+)\]\(([^)]+)\)/,
      make: (m) => ({ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[2] } }] }),
    },
    { re: /\*([^*\s][^*]*)\*/, make: (m) => ({ type: 'text', text: m[1], marks: [{ type: 'em' }] }) },
    { re: /_([^_\s][^_]*)_/, make: (m) => ({ type: 'text', text: m[1], marks: [{ type: 'em' }] }) },
    {
      re: /(https?:\/\/[^\s)]+)/,
      make: (m) => ({ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[1] } }] }),
    },
  ];

  const nodes: AdfNode[] = [];
  let rest = text;
  while (rest.length) {
    let best: { idx: number; len: number; node: AdfNode } | null = null;
    for (const p of patterns) {
      const m = rest.match(p.re);
      if (m && m.index !== undefined && (!best || m.index < best.idx)) {
        best = { idx: m.index, len: m[0].length, node: p.make(m) };
      }
    }
    if (!best) {
      nodes.push({ type: 'text', text: rest });
      break;
    }
    if (best.idx > 0) {
      nodes.push({ type: 'text', text: rest.slice(0, best.idx) });
    }
    nodes.push(best.node);
    rest = rest.slice(best.idx + best.len);
  }
  return nodes.length ? nodes : [{ type: 'text', text } as AdfNode];
}

/** Converts the markdown the model produces into a Jira ADF (Atlassian Document Format) doc. */
export function markdownToAdf(text: string): AdfNode {
  const content: AdfNode[] = [];
  let list: { ordered: boolean; items: AdfNode[] } | null = null;

  const flush = () => {
    if (list) {
      content.push({ type: list.ordered ? 'orderedList' : 'bulletList', content: list.items });
      list = null;
    }
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const isRule = /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim());

    if (heading) {
      flush();
      content.push({
        type: 'heading',
        attrs: { level: Math.min(heading[1].length, 6) },
        content: parseInline(heading[2]),
      });
    } else if (isRule) {
      flush();
      content.push({ type: 'rule' });
    } else if (bullet) {
      if (!list || list.ordered) {
        flush();
        list = { ordered: false, items: [] };
      }
      list.items.push({ type: 'listItem', content: [{ type: 'paragraph', content: parseInline(bullet[1]) }] });
    } else if (ordered) {
      if (!list || !list.ordered) {
        flush();
        list = { ordered: true, items: [] };
      }
      list.items.push({ type: 'listItem', content: [{ type: 'paragraph', content: parseInline(ordered[1]) }] });
    } else {
      flush();
      content.push({ type: 'paragraph', content: parseInline(line) });
    }
  }
  flush();

  if (!content.length) {
    content.push({ type: 'paragraph', content: [] });
  }
  return { type: 'doc', version: 1, content };
}
