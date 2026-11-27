#!/usr/bin/env node
/**
 * Kan-Agent CLI entry: pi's `main()` with the Kan-Agent tool/permission layer injected.
 *
 * The tool surface is compiled into the binary rather than loaded with `-e`, so a bare
 * `kan-agent "<request>"` reaches the full tool layer — that is the LiveISO user experience
 * (HLD §4.1: 一条命令开箱即用). pi's agent loop and session core are untouched; only
 * `MainOptions.extensionFactories` is filled in.
 *
 * Before pi starts, the managed llama-server runtime is brought up (HLD §4.3) and the agent
 * dir's models.json is pointed at it, so no environment setup is needed. Own flag:
 *   --no-llm   do not manage llama-server; use the agent dir's models.json as-is
 */

import { getAgentDir, type InlineExtension, type MainOptions, main } from "@earendil-works/pi-coding-agent";
import kanAgentExtension from "./extension.ts";
import { ensureLlm, seedModelsJson } from "./llm.ts";

const extensionFactories: InlineExtension[] = [{ name: "kan-agent", factory: kanAgentExtension, builtin: true }];

/** Flags kan-agent handles itself; stripped so pi's parser never sees them. */
function takeOwnFlags(argv: string[]): { args: string[]; noLlm: boolean } {
	const args: string[] = [];
	let noLlm = false;
	for (const arg of argv) {
		if (arg === "--no-llm") {
			noLlm = true;
			continue;
		}
		args.push(arg);
	}
	return { args, noLlm };
}

/** Help and listing runs must not load a multi-gigabyte model. */
function wantsModel(args: string[]): boolean {
	const quiet = new Set(["-h", "--help", "--version", "-v", "--list-models"]);
	return !args.some((a) => quiet.has(a));
}

const { args, noLlm } = takeOwnFlags(process.argv.slice(2));

if (!noLlm && process.env.KAN_AGENT_NO_AUTO_LLM !== "1" && wantsModel(args)) {
	const agentDir = getAgentDir();
	try {
		const llm = await ensureLlm({ logPath: `${agentDir}/llama-server.log` });
		seedModelsJson(llm.baseUrl, agentDir);
	} catch (e) {
		// Fall back to whatever models.json the agent dir already holds.
		console.error(`[kan-agent] managed llama-server unavailable: ${(e as Error).message}`);
	}
}

const options: MainOptions = { extensionFactories };
main(args, options);
