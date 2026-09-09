import { parseFragment } from "parse5";
import { AppError } from "../shared/errors";
import type { Cue } from "../shared/types";
import { childrenOf, type HtmlNode } from "./html-tree";

function textNode(node: HtmlNode): string {
  return "value" in node ? node.value : childrenOf(node).map(textNode).join("");
}
function timestamp(value: string): number {
  if (!/^(?:\d{2,}:)?[0-5]\d:[0-5]\d\.\d{3}$/.test(value))
    throw new AppError("VTT_PARSE", `无效字幕时间：${value}`);
  const parts = value.split(":").map(Number);
  return Math.round(parts.reduce((sum, part) => sum * 60 + part, 0) * 1000);
}
export function parseVtt(input: string): { cues: Cue[]; warnings: string[] } {
  const raw = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^WEBVTT(?:[ \t].*)?\n/.test(raw))
    throw new AppError("VTT_PARSE", "资源不是有效的 WebVTT 字幕。");
  const cues: Cue[] = [],
    warnings: string[] = [];
  for (const block of raw.split(/\n[ \t]*\n/).slice(1)) {
    if (
      !block.trim() ||
      /^(NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)
    )
      continue;
    const lines = block.split("\n");
    const timeIndex = lines[0]?.includes("-->") ? 0 : 1;
    const match = lines[timeIndex]?.match(/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);
    if (!match) {
      warnings.push("跳过不含有效时间范围的字幕块。");
      continue;
    }
    try {
      const startMs = timestamp(match[1]),
        endMs = timestamp(match[2]);
      if (endMs < startMs) throw new Error("字幕结束早于开始。");
      const payload = lines.slice(timeIndex + 1).join("\n");
      const speaker = payload.match(/<v(?:\.[^ >]+)*\s+([^>]+)>/)?.[1];
      const cleaned = payload.replace(/<\d{2,}:\d{2}(?::\d{2})?\.\d{3}>/g, "");
      const text = textNode(parseFragment(cleaned)).trim();
      if (text)
        cues.push({ startMs, endMs, text, ...(speaker ? { speaker } : {}) });
    } catch {
      warnings.push("跳过时间范围损坏的字幕块。");
    }
  }
  if (!cues.length && warnings.length)
    throw new AppError("VTT_PARSE", "字幕块全部解析失败。");
  return { cues, warnings };
}
export function time(ms: number, separator = "."): string {
  const value = Math.max(0, Math.round(ms));
  return `${String(Math.floor(value / 3600000)).padStart(2, "0")}:${String(Math.floor(value / 60000) % 60).padStart(2, "0")}:${String(Math.floor(value / 1000) % 60).padStart(2, "0")}${separator}${String(value % 1000).padStart(3, "0")}`;
}
export function toSrt(cues: Cue[]): string {
  return cues
    .map(
      (c, i) =>
        `${i + 1}\n${time(c.startMs, ",")} --> ${time(c.endMs, ",")}\n${c.text}\n`,
    )
    .join("\n");
}
export function toTimedText(cues: Cue[]): string {
  return cues
    .map(
      (c) =>
        `[${time(c.startMs)}–${time(c.endMs)}] ${c.speaker ? `${c.speaker}: ` : ""}${c.text}`,
    )
    .join("\n");
}
