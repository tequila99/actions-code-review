/**
 * Byte-budget truncation shared by every tool whose output is bounded by
 * `tool_output_max_bytes` (get_diff, grep, list_files, read_file,
 * web_search) — extracted from five near-identical copies. Not
 * `provider/http.ts#truncate`, which clips a string by character count for a
 * log line rather than by UTF-8 byte length for a tool result headed to the
 * model — a different function with a different unit, kept separate on
 * purpose.
 */

export function truncate (content: string, maxBytes: number): string {
  const buf = Buffer.from(content, 'utf8')
  if (buf.byteLength <= maxBytes) return content
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n… (truncated, output exceeded ${maxBytes} bytes)`
}
