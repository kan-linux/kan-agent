/**
 * Public surface of the Kan-Agent runtime layer: tool definitions, permission gate, and system
 * prompt. The Pi extension entry point is extension.ts.
 */

export { default as kanAgentExtension } from "./extension.ts";
export { HIGH_RISK_TOOLS, registerPermissionGate } from "./permission.ts";
export { KAN_AGENT_SYSTEM_PROMPT } from "./system-prompt.ts";
export { createKanAgentTools } from "./tools.ts";
