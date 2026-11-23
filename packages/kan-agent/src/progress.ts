/**
 * Progress reporter for headless runs (HLD §4.1: errors and status must be readable).
 *
 * In print/JSON mode pi writes the assistant's final text only after the whole run finishes, so a
 * multi-step task looks hung. This streams the model's thinking and marks each tool call to stderr
 * as they happen, leaving stdout clean for the final answer (so `kan-agent -p ... | jq` still works).
 *
 * In interactive (TUI) mode pi already renders thinking and tool calls, so this stays silent there.
 *
 * Toggle: KAN_AGENT_PROGRESS=0 turns it off entirely; KAN_AGENT_THINKING=0 keeps the tool markers
 * but hides the thinking stream.
 */

import type {
	ExtensionAPI,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";

function isEnabled(): boolean {
	return !/^(0|off|false|no)$/i.test(process.env.KAN_AGENT_PROGRESS ?? "1");
}

function thinkingEnabled(): boolean {
	return !/^(0|off|false|no)$/i.test(process.env.KAN_AGENT_THINKING ?? "1");
}

/** Write a line to stderr without throwing when the pipe is gone. */
function write(text: string): void {
	try {
		process.stderr.write(text);
	} catch {
		// stderr may be closed; progress is best-effort and must never break the run.
	}
}

/** Shorten tool arguments for a one-line marker. */
function briefArgs(args: unknown): string {
	const raw = JSON.stringify(args ?? {});
	return raw.length > 96 ? `${raw.slice(0, 93)}...` : raw;
}

/** Subscribe to the events that describe forward progress. Returns an unsubscribe function. */
export function registerProgressReporter(pi: ExtensionAPI): () => void {
	// Captured from session_start: the TUI renders its own progress, so we stay silent there.
	let headless = true;

	const offSessionStart = pi.on("session_start", (_event, ctx) => {
		headless = !ctx.hasUI;
	});

	const offMessage = pi.on("message_update", (event: MessageUpdateEvent) => {
		if (!headless || !isEnabled()) return;
		const e = event.assistantMessageEvent;
		switch (e.type) {
			case "thinking_start":
				if (thinkingEnabled()) write("\n[think] ");
				break;
			case "thinking_delta":
				if (thinkingEnabled()) write(e.delta);
				break;
			case "thinking_end":
				if (thinkingEnabled()) write("\n");
				break;
			case "toolcall_start":
				write("\n");
				break;
			default:
				break;
		}
	});

	const offStart = pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
		if (!headless || !isEnabled()) return;
		write(`[tool] -> ${event.toolName} ${briefArgs(event.args)}\n`);
	});

	const offEnd = pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
		if (!headless || !isEnabled()) return;
		const ms = event.durationMs === undefined ? "" : ` (${Math.round(event.durationMs)}ms)`;
		const verdict = event.isError ? "failed" : "ok";
		write(`[tool] <- ${event.toolName} ${verdict}${ms}\n`);
	});

	return () => {
		offSessionStart();
		offMessage();
		offStart();
		offEnd();
	};
}
