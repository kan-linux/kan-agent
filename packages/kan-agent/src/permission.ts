/**
 * Kan-Agent permission gate: the tool-execution-boundary permission layer from the HLD (§4.5, §7).
 *
 * Pi has no built-in permission system, so high-risk tools are gated here via the `tool_call`
 * event, which fires before execute and can block. Interactive runs ask the user; runs without a
 * confirmation UI block by default so no high-risk action escapes without an explicit decision.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

/**
 * Tools that require explicit confirmation before execution (HLD §4.5 permission level
 * "高危,需确认" plus sandbox_build/source_patch, which the HLD §4.2 names as high-risk:
 * "部署、回滚、补丁、构建").
 */
export const HIGH_RISK_TOOLS: ReadonlySet<string> = new Set([
	"atomic_deploy",
	"system_rollback",
	"source_patch",
	"sandbox_build",
]);

/** One-line risk label shown in the confirmation dialog. */
const RISK_LABEL: Readonly<Record<string, string>> = {
	atomic_deploy: "deploys artifacts to the system store and flips symlinks",
	system_rollback: "rolls component state back to a historical generation",
	source_patch: "edits build/source files in the workspace",
	sandbox_build: "compiles source in the sandbox",
};

/** Register the permission gate on a Pi extension channel. Returns an unsubscribe function. */
export function registerPermissionGate(pi: ExtensionAPI): () => void {
	return pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (!HIGH_RISK_TOOLS.has(event.toolName)) return undefined;
		const description = RISK_LABEL[event.toolName] ?? "performs a high-risk action";
		const summary = `${event.toolName} ${description}`;
		return await adjudicate(summary, event.input, ctx);
	});
}

/**
 * Ask the user to confirm a high-risk call, or block it when no confirmation UI exists.
 * The parsed arguments are shown as-is: the user confirms exactly what the model tried to run.
 */
async function adjudicate(
	summary: string,
	args: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	if (!ctx.hasUI) {
		return { block: true, reason: `Blocked: ${summary} requires confirmation, and no confirmation UI is available.` };
	}
	const message = `${summary}\n\nArguments: ${JSON.stringify(args)}\n\nAllow this call?`;
	const confirmed = await ctx.ui.confirm("Kan-Agent permission gate", message);
	if (confirmed) return undefined;
	return { block: true, reason: "Blocked by user: confirmation declined." };
}
