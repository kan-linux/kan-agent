#!/usr/bin/env node
/**
 * Kan-Agent CLI entry: pi's `main()` with the Kan-Agent tool/permission layer injected.
 *
 * Product shape (HLD §4.1: 一条命令开箱即用): a request runs as a one-shot headless job —
 * `kan-agent "帮我安装go"` — and prints its report. pi's coding TUI is not part of the surface:
 * kan-agent installs system components and (later) troubleshoots them; it is not a coding
 * assistant. A bare `kan-agent` prints usage. Multi-turn conversation, when UC6 needs it, gets
 * its own minimal session — not pi's interactive mode.
 *
 * Before pi starts, the managed llama-server runtime is brought up (HLD §4.3) and the agent
 * dir's models.json is pointed at it, so no environment setup is needed. Own flag:
 *   --no-llm   do not manage llama-server; use the agent dir's models.json as-is
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function usage(): void {
	console.log(`Usage: kan-agent "<request>"     one-shot: install/upgrade/rollback system components
       kan-agent -p "<request>"   synonym of the above

Examples:
  sudo kan-agent "帮我安装go"
  sudo kan-agent "帮我升级go"
  sudo kan-agent "install go"

Options:
  --list-models list the models available to this run
  --help, -h    show this help
  --version, -v show version`);
}

/** The kan-agent version: the release tree's config/VERSION, else the source package.json. */
function version(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [join(dirname(process.execPath), "config", "VERSION"), join(here, "..", "config", "VERSION")]) {
		if (existsSync(candidate)) return readFileSync(candidate, "utf8").trim();
	}
	try {
		const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
		if (pkg.version) return pkg.version;
	} catch {
		// fall through
	}
	return "development";
}

const { args, noLlm } = takeOwnFlags(process.argv.slice(2));

if (args.length === 0) {
	usage();
	process.exit(0);
}

// kan-agent owns its help and version: pi's are the coding assistant's (wrong product identity).
if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
	usage();
	process.exit(0);
}
if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
	console.log(`kan-agent ${version()}`);
	process.exit(0);
}

// One-shot product shape: a request runs headless. pi's coding TUI is not reachable from here.
// The injected -p is also argv[0], so pi's subcommand words ("install go") become message text
// instead of colliding with pi's extension commands.
const hasRequest = args.some((a) => a === "--" || !a.startsWith("-"));
if (hasRequest && !args.includes("-p") && !args.includes("--print")) {
	args.unshift("-p");
}

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
