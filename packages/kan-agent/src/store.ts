/**
 * Content-addressed store and generation records (HLD §4.6).
 *
 * A generation is one atomic deploy's state: the store path it made reachable, the config it
 * placed, and the health check it passed. Rollback is a symlink flip back to an earlier generation —
 * O(1) and atomic, never a file restore. Artifacts in the store are read-only; only the state dir
 * and the /opt symlink change on a deploy.
 *
 * Symlink flips use create-then-rename so a reader never observes a missing /opt/<tool>: rename(2)
 * over an existing symlink is atomic on POSIX.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { assertSafeToRemove, type KanPaths } from "./root.ts";

export interface GenerationRecord {
	/** Monotonic per component, starting at 1. */
	generation: number;
	component: string;
	version: string;
	/** ISO-8601 UTC. */
	created_at: string;
	/** Absolute path of the store directory this generation makes reachable. */
	store_path: string;
	/** Absolute path of the symlink that points at the store. */
	install_root: string;
	/** Declarative config placed by this deploy (ld.so.conf.d, profile.d, ...). */
	config_placement: string[];
	/** Health check command that ran after deploy, if any. */
	verify_cmd?: string;
	/** Captured output of that health check. */
	verify_output?: string;
	/** Integrity hash of the deployed artifact, when the catalog pinned one. */
	sha256?: string;
	/** The generation this one replaced, for the rollback chain. */
	parent_generation?: number;
	/** Set when this generation is a rollback rather than a deploy. */
	rolled_back_from?: number;
}

/** One component's generations: a numbered log plus a `current` pointer. */
export class GenerationStore {
	private readonly paths: KanPaths;

	constructor(paths: KanPaths) {
		this.paths = paths;
	}

	private dir(component: string): string {
		return this.paths.generationDir(component);
	}

	private recordPath(component: string, generation: number): string {
		return join(this.dir(component), `${generation}.json`);
	}

	private currentPath(component: string): string {
		return join(this.dir(component), "current");
	}

	/** The active generation for `component`, or undefined when it was never deployed. */
	current(component: string): GenerationRecord | undefined {
		const pointer = this.currentPath(component);
		if (!existsSync(pointer)) return undefined;
		// readlinkSync, not readFileSync: the pointer is a symlink and its NAME carries the number,
		// while its target file holds the record body.
		const target = basename(readlinkSync(pointer).trim());
		const generation = Number(target.endsWith(".json") ? target.slice(0, -".json".length) : target);
		if (!Number.isInteger(generation)) return undefined;
		return this.get(component, generation);
	}

	/** One generation record, or undefined. */
	get(component: string, generation: number): GenerationRecord | undefined {
		const path = this.recordPath(component, generation);
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as GenerationRecord;
	}

	/** Every recorded generation for `component`, oldest first. */
	list(component: string): GenerationRecord[] {
		const dir = this.dir(component);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((name) => /^\d+\.json$/.test(name))
			.map((name) => Number(name.slice(0, -".json".length)))
			.sort((a, b) => a - b)
			.map((generation) => this.get(component, generation))
			.filter((r): r is GenerationRecord => r !== undefined);
	}

	/**
	 * Record a new generation and make it current. `flipInstallRoot` is called after the record is
	 * written but before `current` moves, so a crash between the two leaves `current` pointing at
	 * the still-reachable previous generation.
	 */
	advance(
		component: string,
		fields: Omit<GenerationRecord, "generation" | "created_at" | "parent_generation">,
		flipInstallRoot: (storePath: string, installRoot: string) => void,
	): GenerationRecord {
		const previous = this.current(component);
		const generation = (previous?.generation ?? 0) + 1;
		const record: GenerationRecord = {
			...fields,
			generation,
			created_at: new Date().toISOString(),
			parent_generation: previous?.generation,
		};
		mkdirSync(this.dir(component), { recursive: true });
		writeFileSync(this.recordPath(component, generation), `${JSON.stringify(record, null, 2)}\n`, "utf8");
		flipInstallRoot(record.store_path, record.install_root);
		this.pointCurrent(component, generation);
		return record;
	}

	/** Make an existing generation current again, flipping /opt back to its store path. */
	rollbackTo(
		component: string,
		generation: number,
		flipInstallRoot: (storePath: string, installRoot: string) => void,
	): GenerationRecord {
		const target = this.get(component, generation);
		if (!target) {
			throw new Error(`${component}: generation ${generation} does not exist`);
		}
		const from = this.current(component);
		flipInstallRoot(target.store_path, target.install_root);
		this.pointCurrent(component, generation);
		if (from && from.generation !== generation) {
			// Record the rollback itself so the log shows the full history, then re-point at the
			// restored generation: the restored state is what a later deploy builds on.
			const rollbackRecord: GenerationRecord = {
				...target,
				generation: (this.list(component).at(-1)?.generation ?? generation) + 1,
				created_at: new Date().toISOString(),
				parent_generation: from.generation,
				rolled_back_from: from.generation,
			};
			writeFileSync(
				this.recordPath(component, rollbackRecord.generation),
				`${JSON.stringify(rollbackRecord, null, 2)}\n`,
				"utf8",
			);
		}
		return target;
	}

	private pointCurrent(component: string, generation: number): void {
		const pointer = this.currentPath(component);
		const temp = `${pointer}.tmp-${process.pid}`;
		// Point at the record file, not at bare "N": a symlink to a number has no target, so
		// existsSync() reports false and readers see a dangling pointer.
		symlinkSync(`${generation}.json`, temp);
		renameSync(temp, pointer);
	}
}

/** Atomically make `installRoot` point at `storePath`. A relative symlink keeps the tree movable. */
export function flipSymlink(storePath: string, installRoot: string): void {
	mkdirSync(dirname(installRoot), { recursive: true });
	const target = relative(dirname(installRoot), storePath) || ".";
	const temp = `${installRoot}.tmp-${process.pid}`;
	rmSync(temp, { force: true });
	symlinkSync(target, temp);
	renameSync(temp, installRoot);
}

/**
 * Move a staged directory into the store as `<component>/<version>` and make it read-only.
 * The store holds artifacts only; nothing writes to it after this returns.
 */
export function commitToStore(paths: KanPaths, component: string, version: string, stagedDir: string): string {
	const destination = paths.storePath(component, version);
	if (existsSync(destination)) {
		// A redeploy of the same version replaces the store entry; the previous generation still
		// holds its own record, so history is preserved even though the bytes move. The store is
		// read-only by construction, so write permission has to come back before it can go.
		assertSafeToRemove(paths, destination);
		makeWritable(destination);
		rmSync(destination, { recursive: true, force: true });
	}
	mkdirSync(dirname(destination), { recursive: true });
	renameSync(stagedDir, destination);
	makeReadOnly(destination);
	return destination;
}

/** Recursively restore write permission so a read-only store tree can be replaced. */
function makeWritable(dir: string): void {
	chmodSync(dir, 0o755);
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			makeWritable(path);
		} else {
			chmodSync(path, 0o644);
		}
	}
}

/**
 * Recursively strip WRITE permission so the store is read-only by construction. Execute and read
 * bits survive: the store holds executables, and chmod 0444 on them would strip the execute bit and
 * make the deployed tool unrunnable.
 */
function makeReadOnly(dir: string): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			makeReadOnly(path);
		}
		chmodSync(path, statSync(path).mode & ~0o222);
	}
	chmodSync(dir, statSync(dir).mode & ~0o222);
}

/** Whether `path` is a directory that exists. */
export function isDirectory(path: string): boolean {
	return existsSync(path) && statSync(path).isDirectory();
}
