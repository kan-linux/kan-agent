#!/usr/bin/env node
/**
 * Kan-Agent CLI entry: pi's `main()` with the Kan-Agent tool/permission layer injected.
 *
 * The tool surface is compiled into the binary rather than loaded with `-e`, so a bare
 * `kan-agent "<request>"` reaches the full tool layer — that is the LiveISO user experience
 * (HLD §4.1: 一条命令开箱即用). pi's agent loop and session core are untouched; only
 * `MainOptions.extensionFactories` is filled in.
 */

import { type InlineExtension, main, type MainOptions } from "@earendil-works/pi-coding-agent";
import kanAgentExtension from "./extension.ts";

const extensionFactories: InlineExtension[] = [
	{ name: "kan-agent", factory: kanAgentExtension, builtin: true },
];

const options: MainOptions = { extensionFactories };
main(process.argv.slice(2), options);
