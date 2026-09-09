import { micromark } from 'micromark';
import { parseFragment } from 'parse5';
export function safeLink(value: string, base: string): string | undefined {
  try { const url = new URL(value, base); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export function htmlToMarkdown(html: string, base: string): string {
  function walk(node: any, literal = false): string {
    if (node.nodeName === '#text') return literal ? node.value : node.value.replace(/[ \t\r\n]+/g, ' ').replace(/([\\`*_[\]<>])/g, '\\$1');
    const tag = node.tagName ?? '';
    if (['script', 'style', 'iframe', 'object', 'noscript'].includes(tag)) return '';
    const attr = (key: string) => node.attrs?.find((a: any) => a.name === key)?.value ?? '';
    if (tag === 'table') {
      const rowNodes: any[] = [];
      const findRows = (n: any) => { if (n.tagName === 'tr') rowNodes.push(n); else for (const child of n.childNodes ?? []) findRows(child); };
      findRows(node);
      const matrix = rowNodes.map(row => (row.childNodes ?? []).filter((cell: any) => ['td','th'].includes(cell.tagName)).map((cell: any) => (cell.childNodes ?? []).map((n: any) => walk(n)).join('').trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
      if (!matrix.length) return '';
      const width = Math.max(...matrix.map(row => row.length));
      const line = (cells: string[]) => '| ' + Array.from({length: width}, (_,i) => cells[i] ?? '').join(' | ') + ' |';
      return '\n\n' + [line(matrix[0]), line(Array(width).fill('---')), ...matrix.slice(1).map(line)].join('\n') + '\n\n';
    }
    if (tag === 'ul' || tag === 'ol') {
      const children = (node.childNodes ?? []).filter((n: any) => n.tagName === 'li');
      const start = Number(attr('start')) || 1;
      return '\n\n' + children.map((child: any, index: number) => {
        const content = (child.childNodes ?? []).map((n: any) => walk(n)).join('').trim();
        const marker = tag === 'ol' ? `${start + index}. ` : '- ';
        return marker + content.replace(/\n/g, '\n' + ' '.repeat(marker.length));
      }).join('\n') + '\n\n';
    }
    const inner = (node.childNodes ?? []).map((n: any) => walk(n, literal || tag === 'pre' || tag === 'code')).join('');
    if (tag === 'pre') { const fence = '`'.repeat(Math.max(3, ...(inner.match(/`+/g) ?? []).map((s: string) => s.length + 1))); return `\n\n${fence}\n${inner.trim()}\n${fence}\n\n`; }
    if (tag === 'code') return literal ? inner : `\`${inner}\``;
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inner.trim()}\n\n`;
    if (tag === 'a') { const href = safeLink(attr('href'), base); return href ? `[${inner.trim()}](<${href}>)` : inner; }
    if (tag === 'img') return attr('alt') ? `[图片：${attr('alt')}]` : '';
    if (tag === 'strong' || tag === 'b') return `**${inner}**`;
    if (tag === 'em' || tag === 'i') return `*${inner}*`;
    if (tag === 'br') return '\n';
    if (tag === 'li') return `\n- ${inner.trim()}\n`;
    if (tag === 'tr') return `\n${inner.trim()}\n`;
    if (tag === 'td' || tag === 'th') return `${inner.trim()} | `;
    if (tag === 'blockquote') return `\n\n> ${inner.trim().replace(/\n/g, '\n> ')}\n\n`;
    if (['p', 'div', 'section', 'article', 'ul', 'ol', 'table'].includes(tag)) return `\n\n${inner.trim()}\n\n`;
    return inner;
  }
  return walk(parseFragment(html)).trim();
}
export function htmlToText(html: string): string {
  function walk(node: any): string {
    if (node.nodeName === '#text') return node.value;
    if (['script', 'style', 'iframe', 'object', 'noscript'].includes(node.tagName)) return '';
    const inner = (node.childNodes ?? []).map(walk).join('');
    return ['p','div','br','li','tr','h1','h2','h3','h4','pre'].includes(node.tagName) ? `${inner}\n` : inner;
  }
  return walk(parseFragment(html)).replace(/\n{3,}/g, '\n\n').trim();
}

export function markdownToText(markdown: string): string { return htmlToText(micromark(markdown)); }
