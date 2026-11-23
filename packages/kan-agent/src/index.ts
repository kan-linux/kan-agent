/**
 * Public surface of the Kan-Agent runtime layer: the 7 atomic tool definitions, the permission
 * gate, the system prompt, and the official component catalog. The Pi extension entry point is
 * extension.ts; the CLI entry that wires it into pi is cli.ts.
 */

export { type CatalogEntry, CatalogError, ComponentCatalog, type ResolvedSource } from "./catalog.ts";
export { default as kanAgentExtension, KAN_AGENT_TOOL_NAMES } from "./extension.ts";
export { HIGH_RISK_TOOLS, registerPermissionGate } from "./permission.ts";
export { KAN_AGENT_SYSTEM_PROMPT } from "./system-prompt.ts";
export { createKanAgentTools } from "./tools.ts";
