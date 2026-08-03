/** The WebMCP surface (`navigator.modelContext`), which lets a page hand its
 *  own capabilities to whatever agent the *browser* provides.
 *
 *  This is a W3C Community Group Draft — explicitly not a standard, not on the
 *  standards track, and expected around Chrome 146. Nothing here is in
 *  lib.dom, so we describe only the shape we actually call; everything that
 *  uses it is feature-detected at runtime regardless of what tsc believes.
 */

interface WebMcpClient {
  /** Hand control back to a human before doing something they would not want
   *  an agent doing unattended. Resolves when the user has responded. */
  requestUserInteraction(): Promise<unknown>
}

interface WebMcpToolAnnotations {
  /** True only if calling the tool changes nothing the user can observe. */
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

interface WebMcpTool {
  name: string
  description: string
  /** JSON Schema for the argument object. This is the entire contract an
   *  agent has with the page, so it is written by hand rather than inferred. */
  inputSchema: Record<string, unknown>
  annotations?: WebMcpToolAnnotations
  execute(input: any, client?: WebMcpClient): Promise<unknown>
}

interface WebMcpModelContext {
  provideContext(context: { tools: WebMcpTool[] }): void
  registerTool(tool: WebMcpTool): void
  unregisterTool(name: string): void
  clearContext(): void
}

interface Navigator {
  readonly modelContext?: WebMcpModelContext
}
