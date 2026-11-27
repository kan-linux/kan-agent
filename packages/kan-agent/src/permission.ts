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

/**
 * Operations no tool call may ever carry (HLD §7 defense in depth). The model has no general
 * shell, but a hallucinated or hostile payload must be stopped at the permission boundary before
 * any tool logic sees it — including in string fields (verify_cmd, patch content, ...). The scan
 * is deliberately conservative: a payload that merely mentions one of these forms is blocked too,
 * because nothing in the tool layer ever executes such strings and a wrong block costs a retry
 * while a wrong pass could cost the system.
 */
const DESTRUCTIVE_INTENT: ReadonlyArray<{ pattern: RegExp; label: string }> = [
	{
		// rm with a recursive flag aimed at / or a system root: "rm -rf /", "rm -rf /opt",
		// "rm -fr /usr", ... Deleting a tool root below them (/opt/go) is the engine's own job
		// and is not matched.
		pattern:
			/\brm\s+(?:-{1,2}[a-zA-Z-]+\s+)*-{1,2}[a-zA-Z]*r[a-zA-Z]*\b[^;&|\n]*?(?:^|[\s"'`\\=(,;|&])\/(?:\*|(?:opt|usr|etc|var|home|boot|bin|sbin|lib64?|dev|proc|sys|root|tmp)(?:\/?(?=["'`\\\s;,)&|]|$)|(?=["'`\\\s;,)&|]|$))|(?=["'`\\\s;,)&|]|$))/i,
		label: "recursive delete of / or a system root",
	},
	{ pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i, label: "filesystem format" },
	{ pattern: /\bmkswap\b/i, label: "swap area rewrite" },
	{ pattern: /\bwipefs\b/i, label: "filesystem signature wipe" },
	{ pattern: /\bdd\b[^;&|\n]*\bof=\/dev\//i, label: "raw write to a block device" },
	{ pattern: />\s*\/dev\/(?:sd|hd|nvme|vd|xvd|loop)\w*/i, label: "raw write to a block device" },
	{ pattern: /\(\)\s*\{[^}]*\|[^}]*&[^}]*\}/, label: "fork bomb" },
];

/** The destructive operation named by a tool call's arguments, if any. */
export function findDestructiveIntent(args: Record<string, unknown>): string | undefined {
	const payload = JSON.stringify(args);
	for (const { pattern, label } of DESTRUCTIVE_INTENT) {
		if (pattern.test(payload)) return label;
	}
	return undefined;
}

/** Register the permission gate on a Pi extension channel. Returns an unsubscribe function. */
export function registerPermissionGate(pi: ExtensionAPI): () => void {
	return pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		const danger = findDestructiveIntent(event.input);
		if (danger !== undefined) {
			return {
				block: true,
				reason: `Blocked: destructive operation (${danger}) is never allowed in a tool call, not even with confirmation.`,
			};
		}
		if (!HIGH_RISK_TOOLS.has(event.toolName)) return undefined;
		const description = RISK_LABEL[event.toolName] ?? "performs a high-risk action";
		const summary = `${event.toolName} ${description}`;
		return await adjudicate(summary, event.input, ctx);
	});
}

/**
 * Ask the user to confirm a high-risk call, or block it when no confirmation UI exists.
 * The parsed arguments are shown as-is: the user confirms exactly what the model tried to run.
 *
 * A headless run (`-p`) has no dialog, so a high-risk call is blocked by default — unless the run
 * was pre-authorized with `--yes` (KAN_AGENT_ASSUME_YES). That flag is the HLD §7 "策略 allowlist"
 * path: the human's explicit run-level decision stands in for per-call confirmation.
 */
async function adjudicate(
	summary: string,
	args: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	if (!ctx.hasUI) {
		if (process.env.KAN_AGENT_ASSUME_YES === "1") return undefined;
		return {
			block: true,
			reason: `Blocked: ${summary} requires confirmation, and no confirmation UI is available in this run. Re-run with --yes to pre-authorize this run's high-risk tools, or start an interactive session where each high-risk call is confirmed in a dialog.`,
		};
	}
	const message = `${summary}\n\nArguments: ${JSON.stringify(args)}\n\nAllow this call?`;
	const confirmed = await ctx.ui.confirm("Kan-Agent permission gate", message);
	if (confirmed) return undefined;
	return { block: true, reason: "Blocked by user: confirmation declined." };
}
