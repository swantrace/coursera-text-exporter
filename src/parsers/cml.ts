import { parseFragment, serialize } from 'parse5';
import { AppError } from '../shared/errors';
// CML's XML-like text representation; unknown semantic tags fail visibly.
export function cmlToHtml(value: string): string {
  const root = parseFragment(value);
  const passthrough = new Set(['p','br','strong','em','b','i','u','s','ul','ol','li','pre','code','a','span','div','blockquote','table','thead','tbody','tr','th','td','h1','h2','h3','h4','h5','h6','sub','sup','img','hr']);
  const aliases: Record<string,string> = { 'co-content':'div', paragraph:'p', text:'span', heading:'h2', list:'ul', item:'li', 'list-item':'li', 'code-block':'pre', 'inline-code':'code', link:'a', math:'code', 'inline-math':'code', 'block-math':'pre' };
  function walk(node: any): void {
    if (node.tagName) {
      const original = node.tagName;
      const attrs: Array<{name:string;value:string}> = node.attrs ?? [];
      const attr = (name: string) => attrs.find(a=>a.name===name)?.value;
      if (!aliases[original] && !passthrough.has(original)) throw new AppError('CML_UNSUPPORTED', `阅读 CML 包含未适配元素 ${original}。`);
      node.tagName = aliases[original] ?? original; node.nodeName = node.tagName;
      if (original === 'heading') node.tagName = node.nodeName = `h${Math.max(1,Math.min(6,Number(attr('level')) || 2))}`;
      if (original === 'list' && ['ordered','numbered'].includes(attr('type') ?? '')) node.tagName = node.nodeName = 'ol';
      if (original === 'link' && !attr('href') && attr('url')) attrs.push({name:'href',value:attr('url')!});
      node.attrs = attrs.filter(a => ['href','src','alt','start','colspan','rowspan'].includes(a.name));
    }
    for (const child of node.childNodes ?? []) walk(child);
  }
  walk(root); return serialize(root);
}
