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

import { accessSync, constants, existsSync, statfsSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

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
		// Leading-slash segments keep join() absolute under an empty root ("" would make it
		// cwd-relative, i.e. wrong for the live filesystem).
		this.stateDir = join(this.root, "/var", "/lib", "/kan-agent");
		this.workspaceDir = join(this.stateDir, "/workspace");
		this.storeDir = join(this.stateDir, "/store");
		this.generationsDir = join(this.stateDir, "/generations");
	}

	/** <root>/opt/<component> — where the deployed tool is reachable. */
	installRoot(component: string): string {
		return join(this.root, "/opt", component);
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
	// Under /opt only a tool root itself may be removed (install-prebuilts.sh's per-tool
	// allowlist), never an arbitrary depth and never /opt itself: /opt/<tool> is the unit the
	// store replaces. With root on a live system this is the hard boundary for rm -rf.
	const underOpt = dirname(normalized) === join(paths.root, "opt");
	if (!insideState && !underOpt) {
		throw new UnsafePathError(`safe_rm_rf: refusing path outside allowlist: ${target}`);
	}
}

/** Free-space preflight verdict (install-prebuilts.sh: about 10G on the /opt filesystem). */
export type FreeSpaceCheck = { kind: "ok"; availMb: number } | { kind: "failed"; reason: string };

/**
 * Substrate disk preflight (HLD §9: install-prebuilts.sh's require_free_space becomes a shared
 * primitive). Checked on the filesystem that will hold the installs: the /opt directory, or its
 * nearest existing ancestor when /opt is not there yet (a staging root under test).
 */
export function checkFreeSpace(paths: KanPaths, needMb: number): FreeSpaceCheck {
	const dir = nearestExisting(join(paths.root, "opt"));
	try {
		const fs = statfsSync(dir);
		const availMb = Math.floor((fs.bavail * fs.bsize) / (1024 * 1024));
		if (availMb < needMb) {
			return {
				kind: "failed",
				reason: `not enough free disk space on ${dir}: ${availMb} MiB free, need about ${needMb} MiB`,
			};
		}
		return { kind: "ok", availMb };
	} catch (e) {
		return { kind: "failed", reason: `cannot determine free disk space for ${dir}: ${(e as Error).message}` };
	}
}

/**
 * Write access is the privilege boundary, not the uid: kan-linux ships /opt user-writable, and a
 * root-owned /var/lib/kan-agent can be relaxed per install. Refuse only when a root we must write
 * is genuinely not writable, naming the path — the same failure would otherwise surface later as
 * a raw EACCES mid-deploy. install-prebuilts.sh required root; this is the equivalent gate, judged
 * by the filesystem instead of id -u.
 */
export function requireWritableRoots(paths: KanPaths): string | undefined {
	for (const dir of [join(paths.root, "/opt"), paths.stateDir]) {
		if (!writableTarget(dir)) {
			return `cannot write ${dir}: install/update needs write access there (on a stock system /opt and /var are root-only — run with sudo, e.g. sudo kan-agent ...)`;
		}
	}
	return undefined;
}

/** Whether `path` or, when it does not exist yet, its nearest existing ancestor is writable. */
function writableTarget(path: string): boolean {
	const probe = existsSync(path) ? path : nearestExisting(path);
	try {
		accessSync(probe, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Bound on system-config writes: a deploy profile may only write under /etc, /usr or /opt (of the
 * root it targets). Trust boundary: the catalog file is external data, so a malformed profile must
 * not be able to aim a write at, say, /boot or /home.
 */
export function assertSystemWriteAllowed(paths: KanPaths, target: string): void {
	const normalized = resolve(target);
	for (const dir of ["etc", "usr", "opt"]) {
		const base = join(paths.root, `/${dir}`);
		if (normalized === base || normalized.startsWith(`${base}${sep}`)) return;
	}
	throw new UnsafePathError(`deploy profile: refusing write outside /etc, /usr, /opt: ${target}`);
}

/** The nearest existing ancestor of `path` (a fresh staging root has no /opt yet). */
function nearestExisting(path: string): string {
	let dir = resolve(path);
	for (;;) {
		if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
		const parent = dirname(dir);
		if (parent === dir) return sep;
		dir = parent;
	}
}
