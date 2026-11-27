/**
 * The managed llama-server runtime's discovery rules (HLD §4.3): the running tree is authoritative,
 * the /opt/kan-agent install is the fallback convention, and an empty model dir is an error to fix
 * — never a silent borrow from another tree.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findLlamaServer, findModel } from "../src/llm.ts";
import { makeStagingRoot, removeStagingRoot } from "./fixture.ts";

const base = join(import.meta.dirname, ".tmp");
let root: string;

afterEach(() => {
	if (root) removeStagingRoot(root);
	delete process.env.KAN_AGENT_LLM_DIR;
	delete process.env.KAN_AGENT_LLAMA_SERVER;
});

function tree(name: string): string {
	root = makeStagingRoot(base, name);
	return root;
}

describe("findModel", () => {
	it("uses the override dir and requires exactly one .gguf there", () => {
		const dir = tree("llm-override");
		const target = join(dir, "models");
		mkdirSync(target, { recursive: true });
		process.env.KAN_AGENT_LLM_DIR = target;
		expect(() => findModel()).toThrow(/holds no \.gguf model/);
		writeFileSync(join(target, "b.gguf"), "x");
		writeFileSync(join(target, "a.gguf"), "x");
		expect(() => findModel()).toThrow(/keep exactly one/);
		writeFileSync(join(target, "c.gguf"), "x");
		expect(() => findModel()).toThrow(/3 \.gguf files/);
	});

	it("returns the single model when exactly one is present", () => {
		const dir = tree("llm-single");
		const target = join(dir, "models");
		mkdirSync(target, { recursive: true });
		process.env.KAN_AGENT_LLM_DIR = target;
		writeFileSync(join(target, "model.gguf"), "x");
		expect(findModel()).toBe(join(target, "model.gguf"));
	});

	it("treats the tree's llm/ as authoritative when it exists, even when empty", () => {
		const execDir = tree("llm-tree");
		mkdirSync(join(execDir, "llm"), { recursive: true });
		expect(() => findModel(execDir)).toThrow(/holds no \.gguf model/);
	});
});

describe("findLlamaServer", () => {
	it("uses the override when it names a file", () => {
		const dir = tree("srv-override");
		const bin = join(dir, "llama-server");
		writeFileSync(bin, "x");
		process.env.KAN_AGENT_LLAMA_SERVER = bin;
		expect(findLlamaServer()).toBe(bin);
		process.env.KAN_AGENT_LLAMA_SERVER = join(dir, "missing");
		expect(findLlamaServer()).toBeUndefined();
	});

	it("treats the tree's bin/ as authoritative when it exists", () => {
		const execDir = tree("srv-tree");
		mkdirSync(join(execDir, "bin"), { recursive: true });
		// No llama-server inside: no borrowing from /opt or PATH.
		expect(findLlamaServer(execDir)).toBeUndefined();
		const bin = join(execDir, "bin", "llama-server");
		writeFileSync(bin, "x");
		expect(findLlamaServer(execDir)).toBe(bin);
	});
});
