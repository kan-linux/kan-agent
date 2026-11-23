/**
 * Store, generations, and the safe-removal guard (HLD §4.6).
 *
 * These tests exist because two deploy bugs shipped silently once: a read-only store that stripped
 * the execute bit (making the deployed tool unrunnable and the health check fall back to a host
 * binary), and a `current` pointer aimed at a filename that did not exist. Both are properties of
 * the store, so both are asserted here directly.
 */

import { chmodSync, existsSync, mkdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeToRemove, KanPaths, UnsafePathError } from "../src/root.ts";
import { commitToStore, flipSymlink, GenerationStore } from "../src/store.ts";
import { makeStagingRoot, removeStagingRoot } from "./fixture.ts";

const base = join(import.meta.dirname, ".tmp");
let root: string;
let paths: KanPaths;

beforeEach(() => {
	root = makeStagingRoot(base, "store-test");
	process.env.PI_KAN_ROOT = root;
	paths = new KanPaths(root);
});

afterEach(() => {
	removeStagingRoot(root);
	delete process.env.PI_KAN_ROOT;
});

/** Stage a directory that looks like an extracted tool with a runnable binary. */
function stageTool(name: string, report: string): string {
	const staged = join(paths.workspaceDir, ".staging", name);
	rmSync(staged, { recursive: true, force: true });
	mkdirSync(join(staged, "bin"), { recursive: true });
	const binary = join(staged, "bin", name);
	writeFileSync(binary, `#!/bin/sh\necho "${report}"\n`, "utf8");
	chmodSync(binary, 0o755);
	return staged;
}

describe("store", () => {
	it("keeps the execute bit on stored binaries (a-w, not chmod 444)", () => {
		const staged = stageTool("go", "stored-tool");
		const storePath = commitToStore(paths, "go", "1.27.4", staged);
		const binary = join(storePath, "bin", "go");
		expect(existsSync(binary)).toBe(true);
		// The regression: chmod 0444 stripped this, so the deployed tool could not run.
		expect(statSync(binary).mode & 0o111).not.toBe(0);
		expect(statSync(binary).mode & 0o222).toBe(0);
		expect(statSync(storePath).mode & 0o222).toBe(0);
	});

	it("replaces a store entry on redeploy of the same version", () => {
		const first = commitToStore(paths, "go", "1.27.4", stageTool("go", "first"));
		expect(existsSync(join(first, "bin", "go"))).toBe(true);
		const second = commitToStore(paths, "go", "1.27.4", stageTool("go", "second"));
		expect(second).toBe(first);
		expect(existsSync(join(second, "bin", "go"))).toBe(true);
	});
});

describe("generations", () => {
	it("records a generation and points current at an existing record", () => {
		const store = new GenerationStore(paths);
		const record = store.advance(
			"go",
			{
				component: "go",
				version: "1.27.4",
				store_path: paths.storePath("go", "1.27.4"),
				install_root: paths.installRoot("go"),
				config_placement: [],
			},
			flipSymlink,
		);
		expect(record.generation).toBe(1);
		// The regression: current once pointed at "1", whose target did not exist.
		expect(existsSync(join(paths.generationDir("go"), "current"))).toBe(true);
		expect(store.current("go")?.generation).toBe(1);
	});

	it("flips the install root to the generation's store path", () => {
		const store = new GenerationStore(paths);
		const storePath = commitToStore(paths, "go", "1.27.4", stageTool("go", "one"));
		store.advance(
			"go",
			{
				component: "go",
				version: "1.27.4",
				store_path: storePath,
				install_root: paths.installRoot("go"),
				config_placement: [],
			},
			flipSymlink,
		);
		expect(readlinkSync(paths.installRoot("go"))).toBe("..".concat("/var/lib/kan-agent/store/go/1.27.4"));
	});

	it("rolls back to an earlier generation", () => {
		const store = new GenerationStore(paths);
		const first = commitToStore(paths, "go", "1.27.4", stageTool("go", "one"));
		store.advance(
			"go",
			{
				component: "go",
				version: "1.27.4",
				store_path: first,
				install_root: paths.installRoot("go"),
				config_placement: [],
			},
			flipSymlink,
		);
		const second = commitToStore(paths, "go", "1.27.5", stageTool("go", "two"));
		store.advance(
			"go",
			{
				component: "go",
				version: "1.27.5",
				store_path: second,
				install_root: paths.installRoot("go"),
				config_placement: [],
			},
			flipSymlink,
		);
		expect(store.current("go")?.generation).toBe(2);

		store.rollbackTo("go", 1, flipSymlink);
		expect(store.current("go")?.generation).toBe(1);
		expect(readlinkSync(paths.installRoot("go"))).toContain("1.27.4");
	});

	it("refuses a generation that does not exist", () => {
		const store = new GenerationStore(paths);
		expect(() => store.rollbackTo("go", 99, flipSymlink)).toThrow(/generation 99 does not exist/);
	});
});

describe("assertSafeToRemove", () => {
	it("blocks paths outside the allowlist", () => {
		const bad = [
			"",
			"/",
			join(root, "etc"),
			join(paths.stateDir, "..", "..", "etc", "passwd"),
			"relative/path",
			`${paths.stateDir}/`,
		];
		for (const target of bad) {
			expect(() => assertSafeToRemove(paths, target), target).toThrow(UnsafePathError);
		}
	});

	it("allows the state dir and per-tool /opt roots", () => {
		expect(() => assertSafeToRemove(paths, paths.workspaceDir)).not.toThrow();
		expect(() => assertSafeToRemove(paths, paths.installRoot("go"))).not.toThrow();
	});
});
