import type { DefaultTreeAdapterTypes } from "parse5";
export type HtmlNode = DefaultTreeAdapterTypes.Node;
export function childrenOf(
  node: HtmlNode,
): DefaultTreeAdapterTypes.ChildNode[] {
  return "childNodes" in node ? node.childNodes : [];
}
export function tagOf(node: HtmlNode): string {
  return "tagName" in node ? node.tagName : "";
}
