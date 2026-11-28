/**
 * atomic_deploy and system_rollback (HLD §4.5).
 *
 * Deploy is: stage -> extract -> place in-tree config -> commit to the read-only store -> record a
 * generation -> flip the /opt symlink -> place system config -> health check. Every step is either
 * atomic or recorded, so a failure leaves a recoverable state and rollback is a symlink flip plus a
 * config restore, not a file restore. This is what replaces install-prebuilts.sh's `replace_dir`
 * (delete-then-install), which the design deprecates because it cannot roll back.
 *
 * These tools are high-risk and are confirmation-gated by the permission layer; nothing here runs
 * without that gate having passed.
 */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ComponentCatalog, ResolvedSource } from "./catalog.ts";
import { extractArtifact } from "./extract.ts";
import {
	applyInTreeProfile,
	captureSystemConfig,
	detectVm,
	restoreConfigState,
	runHooks,
	writeSystemConfig,
} from "./profile.ts";
import { assertSafeToRemove, checkFreeSpace, type KanPaths, requireWritableRoots } from "./root.ts";
import { commitToStore, flipSymlink, type GenerationRecord, GenerationStore, makeWritable } from "./store.ts";

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

/** Environment overrides for tests that need a fixed VM verdict; production uses detection. */
export interface DeployOptions {
	vm?: boolean;
}

/**
 * Deploy an official prebuilt into the store and make it reachable at /opt/<component>.
 *
 * `artifact` is the fetched package from repo_fetch. The catalog's extract spec turns it into the
 * tool tree (the same layout install-prebuilts.sh produced by extracting straight into /opt), the
 * deploy profile places its config, and the store + generation make the result revertible.
 */
export async function atomicDeployBinary(
	args: DeployArgs,
	paths: KanPaths,
	catalog: ComponentCatalog,
	options?: DeployOptions,
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
	let resolved: ResolvedSource;
	try {
		resolved = catalog.resolve(args.component, args.version);
	} catch (e) {
		return reject((e as Error).message);
	}
	const version = resolved.version;
	const artifact = resolveArtifact(resolved, args.artifact);
	if (artifact.kind === "rejected") return reject(artifact.reason);
	const rootError = requireWritableRoots(paths);
	if (rootError) return reject(rootError);
	const space = checkFreeSpace(paths, catalog.freeSpacePreflightMb);
	if (space.kind === "failed") return reject(space.reason);

	const staging = join(paths.workspaceDir, ".staging", `${args.component}-${version}-${process.pid}`);
	assertSafeToRemove(paths, dirname(staging));
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });

	const extracted = await extractArtifact(entry, artifact.path, staging, version);
	if (extracted.kind === "error") {
		assertSafeToRemove(paths, staging);
		rmSync(staging, { recursive: true, force: true });
		return reject(extracted.reason);
	}

	const vm = options?.vm ?? detectVm();
	const profileNotes: string[] = [];
	try {
		profileNotes.push(...applyInTreeProfile(entry, extracted.contentDir, paths, vm).notes);
	} catch (e) {
		assertSafeToRemove(paths, staging);
		rmSync(staging, { recursive: true, force: true });
		return reject((e as Error).message);
	}

	// A rolling download link names no version in its artifact; the payload's own version keys
	// the store entry, so successive deploys keep their own trees and a rollback reaches the
	// tree its record names. Formats without a declared version keep the resolved one.
	const deployedVersion = extracted.version ?? version;
	const storePath = commitToStore(paths, args.component, deployedVersion, extracted.contentDir);
	rmSync(staging, { recursive: true, force: true });
	// commitToStore moved contentDir out; drop the now-empty staging shell.
	assertSafeToRemove(paths, staging);
	rmSync(staging, { recursive: true, force: true });

	const installRoot = paths.installRoot(entry.install_root);
	const generations = new GenerationStore(paths);
	const verifyCmd = args.verify_cmd ?? entry.verify_cmd;
	const placement = captureSystemConfig(entry, paths, storePath);

	let record: GenerationRecord;
	try {
		record = generations.advance(
			args.component,
			{
				component: args.component,
				version: deployedVersion,
				store_path: storePath,
				install_root: installRoot,
				config_placement: entry.config_placement,
				verify_cmd: verifyCmd,
				sha256: resolved.sha256,
				config_undo: placement.configUndo,
				hooks: placement.hooks,
			},
			(store, root) => {
				displaceLegacyInstallRoot(paths, root);
				flipSymlink(store, root);
				profileNotes.push(...writeSystemConfig(entry, paths, root, vm));
			},
		);
	} catch (e) {
		// The record was written before the flip callback ran; undo this deploy's config writes
		// so a half-applied profile cannot leak into the live system.
		const written = generations.list(args.component).at(-1);
		if (written) {
			restoreConfigState(paths, generations, args.component, written.generation - 1, written.generation);
		}
		return reject(`deploy failed: ${(e as Error).message}`);
	}

	const hookOutcomes = await runHooks(placement.hooks, paths);

	const verify = verifyCmd
		? await runVerify(verifyCmd, installRoot)
		: {
				output: verifyExists(entry.verify_exists ?? [], installRoot),
				passed: verifyExistsPassed(entry.verify_exists ?? [], installRoot),
			};
	if (!verify.passed) {
		const parent = record.parent_generation;
		let rolledBack = false;
		recordLastFailure(paths, args.component, record.generation);
		// Undo this deploy's config writes either way; with a parent, flip the tree back too.
		const hooks = restoreConfigState(paths, generations, args.component, record.generation - 1, record.generation);
		await runHooks(hooks, paths);
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
				`version: ${deployedVersion}`,
				`store_path: ${storePath}`,
				`verify_cmd: ${verifyCmd ?? "(verify_exists)"}`,
				`verify_output: ${verify.output}`,
				"action: config writes of this deploy were rolled back",
				rolledBack ? `action: rolled back to generation ${parent}` : "action: no parent generation to roll back to",
			].join("\n"),
			details: {
				status: "failed",
				reason: "verify_failed",
				component: args.component,
				version: deployedVersion,
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
			`version: ${deployedVersion}`,
			`generation: ${record.generation}`,
			`store_path: ${storePath}`,
			`install_root: ${installRoot} -> ${storePath}`,
			...extracted.notes.map((n) => `extract: ${n}`),
			...profileNotes.map((n) => `profile: ${n}`),
			...placement.notes.map((n) => `profile: ${n}`),
			...hookOutcomes.map((n) => `hook: ${n}`),
			`verify_cmd: ${verifyCmd ?? "(verify_exists)"}`,
			`verify_output: ${verify.output}`,
		].join("\n"),
		details: {
			status: "ok",
			tool: "atomic_deploy",
			component: args.component,
			version: deployedVersion,
			generation: record.generation,
			store_path: storePath,
			install_root: installRoot,
			verify_output: verify.output,
		},
	};
}

/**
 * Roll a component back to a historical generation: restore the system config of the writes made
 * after that generation, flip /opt/<tool> to its store path, and re-point `current`. The rollback
 * is itself atomic and lands in the generation log.
 */
export async function systemRollback(
	args: RollbackArgs,
	paths: KanPaths,
	catalog: ComponentCatalog,
): Promise<DeployOutcome> {
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
	const notes: string[] = [];
	let hooks: string[] = [];
	if (from !== undefined && from.generation > generation) {
		// Backward rollback restores the config pre-images of every generation after the target.
		const restored = restoreConfigState(paths, generations, component, generation, from.generation);
		hooks = await runHooks(restored, paths);
		notes.push(`config: restored to generation ${generation} state`);
	} else if (from !== undefined && from.generation < generation) {
		// Rolling forward across generations flips the tree; system config of the newer
		// generation is not reconstructed (its post-images are not recorded) and stays as-is.
		notes.push("config: left as-is (roll-forward; config restore is for backward rollback)");
	}

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
			...notes,
			...hooks.map((h) => `hook: ${h}`),
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
 * The binary is resolved inside the deployed install root — `bin/<name>`, then `<name>` at the tree
 * root (firefox lives there). Falling back to a host binary on PATH would silently health-check
 * the wrong program — a passed verify that proves nothing is worse than a failed one.
 */
async function runVerify(verifyCmd: string, installRoot: string): Promise<{ output: string; passed: boolean }> {
	const forbidden = /[;&|`$(){}<>*?~\n\\]/;
	if (forbidden.test(verifyCmd)) {
		return { output: `verify_cmd rejected: contains shell metacharacters: ${verifyCmd}`, passed: false };
	}
	const tokens = verifyCmd.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { output: "verify_cmd is empty", passed: false };
	const deployed = resolveVerifyBinary(tokens[0], installRoot);
	if (!deployed) {
		return {
			output: `verify_cmd rejected: ${tokens[0]} is not in the deployed install root (${installRoot})`,
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

/**
 * The package file to extract. `artifact` is the file repo_fetch reported in its `artifact` field;
 * a workspace directory is accepted and resolved to the fetched package inside it, because callers
 * routinely hand back the workspace path instead of the file within — the intent is unambiguous and
 * a wrong guess here would otherwise fail deep inside extraction.
 */
function resolveArtifact(
	resolved: ResolvedSource,
	artifact: string,
): { kind: "file"; path: string } | { kind: "rejected"; reason: string } {
	if (!existsSync(artifact)) {
		return {
			kind: "rejected",
			reason: `artifact not found: ${artifact}. Pass the artifact value repo_fetch reported (its workspace joined with its tarball).`,
		};
	}
	if (statSync(artifact).isFile()) return { kind: "file", path: artifact };
	const candidate = join(artifact, resolved.tarball);
	if (existsSync(candidate) && statSync(candidate).isFile()) {
		return { kind: "file", path: candidate };
	}
	return {
		kind: "rejected",
		reason: `artifact must be the fetched package file; ${artifact} is a directory without ${resolved.tarball} in it. Pass the artifact value repo_fetch reported.`,
	};
}

/** A verify binary inside the install root: a slash path as-is, a bare name in bin/ then at the root. */
function resolveVerifyBinary(binary: string, installRoot: string): string | undefined {
	const candidates = binary.includes("/")
		? [join(installRoot, binary)]
		: [join(installRoot, "bin", binary), join(installRoot, binary)];
	return candidates.find((c) => existsSync(c));
}

function verifyExists(paths: string[], installRoot: string): string {
	if (paths.length === 0) return "(no verify step)";
	return paths.map((p) => `${p}: ${existsSync(join(installRoot, p)) ? "present" : "MISSING"}`).join("; ");
}

function verifyExistsPassed(paths: string[], installRoot: string): boolean {
	return paths.every((p) => existsSync(join(installRoot, p)));
}

/**
 * A leftover real directory at /opt/<tool> (an install-prebuilts.sh install) cannot be rename'd
 * over by the symlink flip. The new content is already safe in the store at this point, so the
 * stale tree goes — that is the adoption path from script installs to store installs.
 */
function displaceLegacyInstallRoot(paths: KanPaths, installRoot: string): void {
	if (!existsSync(installRoot) && !isSymlink(installRoot)) return;
	if (isSymlink(installRoot)) return;
	assertSafeToRemove(paths, installRoot, installRoot);
	makeWritable(installRoot);
	rmSync(installRoot, { recursive: true, force: true });
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function reject(reason: string): DeployOutcome {
	return {
		kind: "error",
		text: `STATUS: REJECTED\nstep: deploy\noutcome: ${reason}`,
		details: { status: "rejected", reason },
	};
}
