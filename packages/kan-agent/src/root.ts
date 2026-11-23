/**
 * Kan-Agent filesystem layout (HLD §4.6): one root prefix, real FHS paths underneath.
 *
 * Everything Kan-Agent writes lives below a single root so the same code serves both production and
 * testing: production uses the real filesystem (`root` is empty), a test uses a staging directory
 * (`root` is `/tmp/...`) that is a miniature rootfs. No test-only branches in the install pipeline.
 *
 *   <root>/opt/<tool>                          symlink into the store (the deployed tool)
 *   <root>/var/lib/kan-agent/workspace/        fetched artifacts
 *   <root>/var/lib/kan-agent/store/<tool>/<v>  artifacts, read-only, content-addressed
 *   <root>/var/lib/kan-agent/generations/<tool>/<N>.json + current -> N
 *
 * The state directory is `/var/lib/kan-agent` by FHS: that is where variable state for a program
 * belongs (dpkg uses /var/lib/dpkg, systemd /var/lib/systemd). Artifacts stay read-only; only the
 * state directory and the /opt symlink change after a deploy.
 */

import { join, resolve, sep } from "node:path";

export class UnsafePathError extends Error {}

/** Resolved paths below one root. */
export class KanPaths {
	/** Root prefix: "" for the real filesystem, "/tmp/x" for a staging tree. */
	readonly root: string;
	/** <root>/var/lib/kan-agent */
	readonly stateDir: string;
	/** <root>/var/lib/kan-agent/workspace */
	readonly workspaceDir: string;
	/** <root>/var/lib/kan-agent/store */
	readonly storeDir: string;
	/** <root>/var/lib/kan-agent/generations */
	readonly generationsDir: string;

	constructor(root: string) {
		this.root = root === "/" ? "" : root.replace(/\/+$/, "");
		this.stateDir = join(this.root, "var", "lib", "kan-agent");
		this.workspaceDir = join(this.stateDir, "workspace");
		this.storeDir = join(this.stateDir, "store");
		this.generationsDir = join(this.stateDir, "generations");
	}

	/** <root>/opt/<component> — where the deployed tool is reachable. */
	installRoot(component: string): string {
		return join(this.root, "opt", component);
	}

	/** <root>/var/lib/kan-agent/store/<component>/<version> */
	storePath(component: string, version: string): string {
		return join(this.storeDir, component, version);
	}

	/** <root>/var/lib/kan-agent/generations/<component> */
	generationDir(component: string): string {
		return join(this.generationsDir, component);
	}
}

/**
 * The one root for this process. `PI_KAN_ROOT` selects a staging tree; unset means the real
 * filesystem. Keeping it to a single variable is the point: one entry, one layout.
 */
export function resolveKanPaths(): KanPaths {
	return new KanPaths(process.env.PI_KAN_ROOT ?? "");
}

/**
 * Allowlist guard for removals (HLD §9: install-prebuilts.sh's safe_rm_rf becomes a substrate
 * primitive). The script runs as root, so a buggy path must never take out the system.
 *
 * Refuses: empty paths, the root itself, system root dirs, trailing slashes (rm -rf "$dir/" with
 * dir="" expands to /), paths with "..", and anything outside the state dir or the per-tool /opt
 * roots. Only what is already on disk is deleted; a missing target is a quiet no-op.
 */
export function assertSafeToRemove(paths: KanPaths, target: string): void {
	if (!target) throw new UnsafePathError("safe_rm_rf: refusing empty path");
	const normalized = resolve(target);
	if (normalized === paths.root || normalized === "" || normalized === sep) {
		throw new UnsafePathError(`safe_rm_rf: refusing to remove the root: ${target}`);
	}
	const systemRoots = [
		"/bin",
		"/boot",
		"/dev",
		"/etc",
		"/home",
		"/lib",
		"/lib64",
		"/opt",
		"/proc",
		"/root",
		"/run",
		"/sbin",
		"/srv",
		"/sys",
		"/tmp",
		"/usr",
		"/var",
	].map((d) => join(paths.root, d));
	if (systemRoots.includes(normalized)) {
		throw new UnsafePathError(`safe_rm_rf: refusing to remove system root dir ${target}`);
	}
	if (target.endsWith("/") || target.endsWith(sep)) {
		throw new UnsafePathError(`safe_rm_rf: refusing trailing slash (would expand to /): ${target}`);
	}
	if (target.includes("..")) {
		throw new UnsafePathError(`safe_rm_rf: refusing path with ..: ${target}`);
	}
	if (!target.startsWith("/")) {
		throw new UnsafePathError(`safe_rm_rf: refusing relative path: ${target}`);
	}

	const insideState = normalized === paths.stateDir || normalized.startsWith(`${paths.stateDir}${sep}`);
	const underOpt = normalized.startsWith(`${join(paths.root, "opt")}${sep}`);
	if (!insideState && !underOpt) {
		throw new UnsafePathError(`safe_rm_rf: refusing path outside allowlist: ${target}`);
	}
}
