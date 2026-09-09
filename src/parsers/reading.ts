import { micromark } from 'micromark';
import { parseFragment } from 'parse5';
import { childrenOf, type HtmlNode, tagOf } from './html-tree';
export function safeLink(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function htmlToMarkdown(html: string, base: string): string {
  function walk(node: HtmlNode, literal = false): string {
    if ('value' in node)
      return literal
        ? node.value
        : node.value
            .replace(/[ \t\r\n]+/g, ' ')
            .replace(/([\\`*_[\]<>])/g, '\\$1');
    const tag = tagOf(node);
    if (['script', 'style', 'iframe', 'object', 'noscript'].includes(tag))
      return '';
    const attr = (key: string) =>
      ('attrs' in node ? node.attrs : []).find((a) => a.name === key)?.value ??
      '';
    if (tag === 'table') {
      const rowNodes: HtmlNode[] = [];
      const findRows = (n: HtmlNode) => {
        if (tagOf(n) === 'tr') rowNodes.push(n);
        else for (const child of childrenOf(n)) findRows(child);
      };
      findRows(node);
      const matrix = rowNodes.map((row) =>
        childrenOf(row)
          .filter((cell: HtmlNode) => ['td', 'th'].includes(tagOf(cell)))
          .map((cell: HtmlNode) =>
            childrenOf(cell)
              .map((n: HtmlNode) => walk(n))
              .join('')
              .trim()
              .replace(/\|/g, '\\|')
              .replace(/\n/g, '<br>'),
          ),
      );
      if (!matrix.length) return '';
      const width = Math.max(...matrix.map((row) => row.length));
      const line = (cells: string[]) =>
        `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
      return `\n\n${[line(matrix[0]), line(Array(width).fill('---')), ...matrix.slice(1).map(line)].join('\n')}\n\n`;
    }
    if (tag === 'ul' || tag === 'ol') {
      const children = childrenOf(node).filter(
        (n: HtmlNode) => tagOf(n) === 'li',
      );
      const start = Number(attr('start')) || 1;
      return `\n\n${children
        .map((child: HtmlNode, index: number) => {
          const content = childrenOf(child)
            .map((n: HtmlNode) => walk(n))
            .join('')
            .trim();
          const marker = tag === 'ol' ? `${start + index}. ` : '- ';
          return (
            marker + content.replace(/\n/g, `\n${' '.repeat(marker.length)}`)
          );
        })
        .join('\n')}\n\n`;
    }
    const inner = childrenOf(node)
      .map((n: HtmlNode) => walk(n, literal || tag === 'pre' || tag === 'code'))
      .join('');
    if (tag === 'pre') {
      const fence = '`'.repeat(
        Math.max(
          3,
          ...(inner.match(/`+/g) ?? []).map((s: string) => s.length + 1),
        ),
      );
      return `\n\n${fence}\n${inner.trim()}\n${fence}\n\n`;
    }
    if (tag === 'code')
      return literal ? inner : `\n\n\`\`\`\n${inner.trim()}\n\`\`\`\n\n`;
    if (/^h[1-6]$/.test(tag))
      return `\n\n${'#'.repeat(Number(tag[1]))} ${inner.trim()}\n\n`;
    if (tag === 'a') {
      const href = safeLink(attr('href'), base);
      return href ? `[${inner.trim()}](<${href}>)` : inner;
    }
    if (tag === 'img') return attr('alt') ? `[Image: ${attr('alt')}]` : '';
    if (tag === 'strong' || tag === 'b') return `**${inner}**`;
    if (tag === 'em' || tag === 'i') return `*${inner}*`;
    if (tag === 'br') return '\n';
    if (tag === 'li') return `\n- ${inner.trim()}\n`;
    if (tag === 'tr') return `\n${inner.trim()}\n`;
    if (tag === 'td' || tag === 'th') return `${inner.trim()} | `;
    if (tag === 'blockquote')
      return `\n\n> ${inner.trim().replace(/\n/g, '\n> ')}\n\n`;
    if (['p', 'div', 'section', 'article', 'ul', 'ol', 'table'].includes(tag))
      return `\n\n${inner.trim()}\n\n`;
    return inner;
  }
  return walk(parseFragment(html)).trim();
}
export function htmlToText(html: string): string {
  function walk(node: HtmlNode): string {
    if ('value' in node) return node.value;
    if (
      ['script', 'style', 'iframe', 'object', 'noscript'].includes(tagOf(node))
    )
      return '';
    const inner = childrenOf(node).map(walk).join('');
    return [
      'p',
      'div',
      'br',
      'li',
      'tr',
      'h1',
      'h2',
      'h3',
      'h4',
      'pre',
    ].includes(tagOf(node))
      ? `${inner}\n`
      : inner;
  }
  return walk(parseFragment(html))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function markdownToText(markdown: string): string {
  return htmlToText(micromark(markdown));
}
