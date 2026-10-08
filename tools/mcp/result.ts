import type { ToolResult } from "../../src/engine/agent/types";

export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  [key: string]: unknown;
  content: McpContent[];
  isError?: boolean;
}

/** Hard cap so a runaway `data` payload cannot flood the model's context. */
export const MAX_DATA_CHARS = 60_000;

export function toMcpResult(result: ToolResult): McpToolResult {
  if (!result.ok) {
    const text = result.hint ? `${result.error}\nHint: ${result.hint}` : result.error;
    return { content: [{ type: "text", text }], isError: true };
  }
  const content: McpContent[] = [{ type: "text", text: result.summary }];
  if (result.data !== undefined) {
    const json = JSON.stringify(result.data, null, 1) ?? "null";
    content.push({ type: "text", text: json.length > MAX_DATA_CHARS ? `${json.slice(0, MAX_DATA_CHARS)}\n...[truncated ${json.length - MAX_DATA_CHARS} chars]` : json });
  }
  for (const image of result.images ?? []) {
    if (image.caption) content.push({ type: "text", text: image.caption });
    content.push({ type: "image", data: image.base64, mimeType: image.mediaType });
  }
  return { content };
}

export function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
