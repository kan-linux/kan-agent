/**
 * atomic_deploy and system_rollback (HLD §4.5).
 *
 * Deploy is: stage -> commit to the read-only store -> record a generation -> flip the /opt symlink
 * -> health check. Every step is either atomic or recorded, so a failure leaves a recoverable state
 * and rollback is a symlink flip, not a file restore. This is what replaces install-prebuilts.sh's
 * `replace_dir` (delete-then-install), which the design deprecates because it cannot roll back.
 *
 * These tools are high-risk and are confirmation-gated by the permission layer; nothing here runs
 * without that gate having passed.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ComponentCatalog } from "./catalog.ts";
import { assertSafeToRemove, type KanPaths } from "./root.ts";
import { commitToStore, flipSymlink, GenerationStore } from "./store.ts";

const run = promisify(execFile);

/** Remembers the component of the last failed deploy, which is system_rollback's default. */
const LAST_FAILED_FILE = "last-failed.json";

function recordLastFailure(paths: KanPaths, component: string, generation: number): void {
	writeFileSync(join(paths.stateDir, LAST_FAILED_FILE), JSON.stringify({ component, generation }), "utf8");
}

function readLastFailure(paths: KanPaths): { component: string; generation: number } | undefined {
	try {
		return JSON.parse(readFileSync(join(paths.stateDir, LAST_FAILED_FILE), "utf8")) as {
			component: string;
			generation: number;
		};
	} catch {
		return undefined;
	}
}

export type DeployOutcome =
	| { kind: "ok"; text: string; details: Record<string, unknown> }
	| { kind: "error"; text: string; details: Record<string, unknown> };

export interface DeployArgs {
	component: string;
	version: string;
	artifact: string;
	verify_cmd?: string;
}

export interface RollbackArgs {
	/** Optional: defaults to the component of the last failed deploy (HLD §4.5). */
	component?: string;
	generation: string;
}

/**
 * Deploy an official prebuilt into the store and make it reachable at /opt/<component>.
 *
 * `artifact` is the fetched tarball from repo_fetch. Its single top-level directory becomes the
 * store entry, so the store path holds the tool's own bin/, lib/, ... and /opt/<tool> points at it —
 * the same layout install-prebuilts.sh produced by extracting straight into /opt.
 */
export async function atomicDeployBinary(
	args: DeployArgs,
	paths: KanPaths,
	catalog: ComponentCatalog,
): Promise<DeployOutcome> {
	const entry = catalog.get(args.component);
	if (!entry) {
		return reject(`component "${args.component}" is not in the official component catalog`);
	}
	if (entry.source_type !== "binary") {
		return reject(
			`catalog entry "${args.component}" is source_type=${entry.source_type}; this deploy path is for binary`,
		);
	}
	if (!entry.versions.includes(args.version)) {
		return reject(
			`${args.component}: version "${args.version}" is not in the catalog. Available: ${entry.versions.join(", ")}`,
		);
	}
	if (!existsSync(args.artifact)) {
		return reject(`artifact not found: ${args.artifact}`);
	}

	const staging = join(paths.workspaceDir, ".staging", `${args.component}-${args.version}-${process.pid}`);
	assertSafeToRemove(paths, dirname(staging));
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });

	try {
		await run("tar", ["-xf", args.artifact, "-C", staging]);
	} catch (e) {
		rmSync(staging, { recursive: true, force: true });
		return reject(`could not extract ${args.artifact}: ${(e as Error).message}`);
	}

	const contentDir = singleChildDir(staging) ?? staging;
	const storePath = commitToStore(paths, args.component, args.version, contentDir);
	rmSync(staging, { recursive: true, force: true });
	// commitToStore moved contentDir out; drop the now-empty staging shell.
	assertSafeToRemove(paths, staging);
	rmSync(staging, { recursive: true, force: true });

	const installRoot = paths.installRoot(args.component);
	const generations = new GenerationStore(paths);
	const verifyCmd = args.verify_cmd ?? entry.verify_cmd;

	const record = generations.advance(
		args.component,
		{
			component: args.component,
			version: args.version,
			store_path: storePath,
			install_root: installRoot,
			config_placement: entry.config_placement,
			verify_cmd: verifyCmd,
			sha256: entry.sha256?.[args.version],
		},
		flipSymlink,
	);

	const verify = verifyCmd ? await runVerify(verifyCmd, installRoot) : { output: "(no verify_cmd)", passed: true };
	if (!verify.passed) {
		const parent = record.parent_generation;
		let rolledBack = false;
		recordLastFailure(paths, args.component, record.generation);
		if (parent !== undefined) {
			generations.rollbackTo(args.component, parent, flipSymlink);
			rolledBack = true;
		}
		return {
			kind: "error",
			text: [
				"STATUS: FAILED",
				"step: atomic_deploy",
				`component: ${args.component}`,
				`version: ${args.version}`,
				`store_path: ${storePath}`,
				`verify_cmd: ${verifyCmd}`,
				`verify_output: ${verify.output}`,
				rolledBack ? `action: rolled back to generation ${parent}` : "action: no parent generation to roll back to",
			].join("\n"),
			details: {
				status: "failed",
				reason: "verify_failed",
				component: args.component,
				version: args.version,
				generation: record.generation,
				verify_output: verify.output,
				rolled_back_to: rolledBack ? parent : null,
			},
		};
	}

	return {
		kind: "ok",
		text: [
			"STATUS: OK",
			"step: atomic_deploy",
			`component: ${args.component}`,
			`version: ${args.version}`,
			`generation: ${record.generation}`,
			`store_path: ${storePath}`,
			`install_root: ${installRoot} -> ${storePath}`,
			`verify_cmd: ${verifyCmd ?? "(none)"}`,
			`verify_output: ${verify.output}`,
		].join("\n"),
		details: {
			status: "ok",
			tool: "atomic_deploy",
			component: args.component,
			version: args.version,
			generation: record.generation,
			store_path: storePath,
			install_root: installRoot,
			verify_output: verify.output,
		},
	};
}

/**
 * Roll a component back to a historical generation: flip /opt/<tool> to that generation's store
 * path and re-point `current`. The rollback is itself atomic and lands in the generation log.
 */
export function systemRollback(args: RollbackArgs, paths: KanPaths, catalog: ComponentCatalog): DeployOutcome {
	const generation = Number(args.generation);
	if (!Number.isInteger(generation) || generation < 1) {
		return reject(`generation must be a positive integer, got "${args.generation}"`);
	}
	const component = args.component ?? readLastFailure(paths)?.component;
	if (!component) {
		return reject("system_rollback: no component given and no recorded failed deploy to default to");
	}
	if (!catalog.get(component)) {
		return reject(`component "${component}" is not in the official component catalog`);
	}
	const generations = new GenerationStore(paths);
	const target = generations.get(component, generation);
	if (!target) {
		const known =
			generations
				.list(component)
				.map((r) => r.generation)
				.join(", ") || "(none)";
		return reject(`${component}: generation ${generation} does not exist. Recorded: ${known}`);
	}

	const from = generations.current(component);
	generations.rollbackTo(component, generation, flipSymlink);
	return {
		kind: "ok",
		text: [
			"STATUS: OK",
			"step: system_rollback",
			`component: ${component}`,
			`from_generation: ${from?.generation ?? "(none)"}`,
			`to_generation: ${generation}`,
			`install_root: ${target.install_root} -> ${target.store_path}`,
		].join("\n"),
		details: {
			status: "ok",
			tool: "system_rollback",
			component,
			from_generation: from?.generation ?? null,
			to_generation: generation,
			store_path: target.store_path,
		},
	};
}

/**
 * Run a deploy health check. The design constrains this: allowlisted binaries, no shell
 * metacharacters. So the command is split on whitespace and executed without a shell.
 *
 * The binary is resolved to the deployed install root and must be there. Falling back to a host
 * binary on PATH would silently health-check the wrong program — a passed verify that proves
 * nothing is worse than a failed one.
 */
async function runVerify(verifyCmd: string, installRoot: string): Promise<{ output: string; passed: boolean }> {
	const forbidden = /[;&|`$(){}<>*?~\n\\]/;
	if (forbidden.test(verifyCmd)) {
		return { output: `verify_cmd rejected: contains shell metacharacters: ${verifyCmd}`, passed: false };
	}
	const tokens = verifyCmd.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { output: "verify_cmd is empty", passed: false };
	const binary = tokens[0];
	if (binary.includes("/")) {
		return { output: `verify_cmd rejected: binary must be a bare name (allowlisted), got ${binary}`, passed: false };
	}
	const deployed = join(installRoot, "bin", binary);
	if (!existsSync(deployed)) {
		return {
			output: `verify_cmd rejected: ${binary} is not in the deployed install root (${join(installRoot, "bin")})`,
			passed: false,
		};
	}
	const env = { ...process.env, PATH: `${join(installRoot, "bin")}:${process.env.PATH ?? ""}` };
	try {
		const { stdout, stderr } = await run(deployed, tokens.slice(1), { env, timeout: 30_000 });
		return { output: `${stdout}${stderr}`.trim().slice(0, 400) || "(no output)", passed: true };
	} catch (e) {
		const err = e as Error & { stdout?: string; stderr?: string };
		return { output: `${err.message}${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(0, 400), passed: false };
	}
}

/** The single directory inside `dir`, if there is exactly one and it is a directory. */
function singleChildDir(dir: string): string | undefined {
	const entries = readdirSync(dir, { withFileTypes: true });
	if (entries.length !== 1) return undefined;
	const only = entries[0];
	if (!only.isDirectory()) return undefined;
	return join(dir, only.name);
}

function reject(reason: string): DeployOutcome {
	return {
		kind: "error",
		text: `STATUS: REJECTED\nstep: deploy\noutcome: ${reason}`,
		details: { status: "rejected", reason },
	};
}
