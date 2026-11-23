/**
 * Kan-Agent Pi extension entry point (HLD §4.2: customize Pi's tool layer + permission layer only).
 *
 * Registers the 7 atomic tools into Pi's tool-calling channel and installs the permission gate.
 * The system prompt is injected via `before_agent_start` so the base model sees Kan-Agent's
 * identity instead of pi's coding-assistant preamble. Agent loop and session core stay untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPermissionGate } from "./permission.ts";
import { KAN_AGENT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { createKanAgentTools } from "./tools.ts";

export default function kanAgentExtension(pi: ExtensionAPI): void {
	for (const tool of createKanAgentTools()) {
		pi.registerTool(tool);
	}
	registerPermissionGate(pi);
	pi.on("before_agent_start", () => ({ systemPrompt: KAN_AGENT_SYSTEM_PROMPT }));
}
