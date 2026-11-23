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

/** The tool surface Kan-Agent declares to the model: its 7 atomic tools and nothing else. */
export const KAN_AGENT_TOOL_NAMES = [
	"repo_fetch",
	"install_audit",
	"source_patch",
	"sandbox_build",
	"atomic_deploy",
	"system_rollback",
	"sys_inspect",
] as const;

export default function kanAgentExtension(pi: ExtensionAPI): void {
	for (const tool of createKanAgentTools()) {
		pi.registerTool(tool);
	}
	registerPermissionGate(pi);
	// Kan-Agent is not a coding assistant: pi's read/bash/edit/write are not part of its tool
	// surface. Narrow the active set to the 7 atomic tools so the model never reaches for a
	// general shell, which HLD §7 forbids ("不暴露通用能力").
	pi.on("session_start", () => {
		pi.setActiveTools([...KAN_AGENT_TOOL_NAMES]);
	});
	pi.on("before_agent_start", () => ({ systemPrompt: KAN_AGENT_SYSTEM_PROMPT }));
}
