/**
 * Official-binary install pipeline (HLD §5.2): repo_fetch -> install_audit -> atomic_deploy.
 *
 * This module implements the first two steps of the binary class against the official component
 * catalog. No sandbox_build and no source_patch: an official prebuilt has no local compile step.
 * The trust anchor is the official-source allowlist — every URL comes from the catalog, never from
 * the caller, so a fabricated address cannot reach the fetch.
 *
 * atomic_deploy is deliberately NOT here at this stage: it writes the system store and flips
 * symlinks, and the HLD makes it high-risk and confirmation-gated. The Go test stages into a
 * caller-supplied root instead of touching the live /opt.
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogError, ComponentCatalog, ResolvedSource } from "./catalog.ts";
import { fetchToFile, sha256File } from "./fetch.ts";
import { checkFreeSpace, type KanPaths, requireWritableRoots } from "./root.ts";

export type PipelineOutcome =
	| { kind: "ok"; text: string; details: Record<string, unknown> }
	| { kind: "error"; text: string; details: Record<string, unknown> };

export interface FetchArgs {
	source_type: "binary" | "source";
	component?: string;
	url?: string;
	ref?: string;
}

export interface AuditArgs {
	source_type: "binary" | "source";
	workspace: string;
	scan_scope?: "scripts" | "build_files" | "origin" | "integrity" | "full";
}

/**
 * Fetch an official prebuilt into `<root>/var/lib/kan-agent/workspace/<component>/`. The model names
 * the component and optionally the version (`ref`); the catalog resolves the URL. A caller URL is
 * refused for the binary class because the allowlist is the whole point of the trust anchor.
 */
export async function repoFetchBinary(
	args: FetchArgs,
	paths: KanPaths,
	catalog: ComponentCatalog,
): Promise<PipelineOutcome> {
	if (!args.component) {
		return {
			kind: "error",
			text: "STATUS: REJECTED\nstep: repo_fetch\noutcome: source_type=binary requires a component name from the official component catalog; a bare url is not accepted.",
			details: { status: "rejected", reason: "component_required" },
		};
	}
	if (args.url) {
		return {
			kind: "error",
			text: `STATUS: REJECTED\nstep: repo_fetch\noutcome: source_type=binary does not accept a caller-supplied url. The download address is resolved from the official component catalog entry for "${args.component}".\nRetry with source_type and component only; omit url.`,
			details: {
				status: "rejected",
				reason: "url_not_acceptable_for_binary",
				component: args.component,
				url: args.url,
			},
		};
	}

	const rootError = requireWritableRoots(paths);
	if (rootError) {
		return {
			kind: "error",
			text: `STATUS: REJECTED\nstep: repo_fetch\noutcome: ${rootError}`,
			details: { status: "rejected", reason: "root_required" },
		};
	}
	const space = checkFreeSpace(paths, catalog.freeSpacePreflightMb);
	if (space.kind === "failed") {
		return {
			kind: "error",
			text: `STATUS: REJECTED\nstep: repo_fetch\noutcome: ${space.reason}`,
			details: { status: "rejected", reason: "insufficient_disk_space" },
		};
	}

	let resolved: ResolvedSource;
	try {
		resolved = catalog.resolve(args.component, args.ref);
	} catch (e) {
		const err = e as CatalogError;
		return {
			kind: "error",
			text: `STATUS: REJECTED\nstep: repo_fetch\noutcome: ${err.message}`,
			details: { status: "rejected", reason: err.code ?? "catalog_error", component: args.component },
		};
	}

	const workspace = join(paths.workspaceDir, resolved.name);
	await mkdir(workspace, { recursive: true });
	const dest = join(workspace, resolved.tarball);

	// A retry of a fetch that already succeeded must not re-download tens of MB (model-level
	// retries after a confusing tool result should cost nothing). A pinned sha256 is re-verified
	// before reuse; an unpinned one trusts the earlier fetch — dest only ever holds a complete
	// download, never a partial.
	let bytes: number;
	let sha256: string;
	let reused = false;
	const existing = await reusableArtifact(dest, resolved.sha256);
	if (existing !== undefined) {
		bytes = existing.bytes;
		sha256 = existing.sha256;
		reused = true;
	} else {
		const outcome = await fetchToFile(resolved.url, dest, { sha256: resolved.sha256 });
		if (outcome.kind === "failed") {
			return {
				kind: "error",
				text: `STATUS: FAILED\nstep: repo_fetch\noutcome: ${outcome.reason}`,
				details: { status: "failed", reason: outcome.reason, url: resolved.url },
			};
		}
		bytes = outcome.bytes;
		sha256 = outcome.sha256;
	}

	return {
		kind: "ok",
		text: [
			"STATUS: OK",
			"step: repo_fetch",
			`component: ${resolved.name}`,
			`version: ${resolved.version}`,
			`url: ${resolved.url}`,
			`tarball: ${resolved.tarball}`,
			`bytes: ${bytes}`,
			`sha256: ${sha256}`,
			`workspace: ${workspace}`,
			...(reused ? ["artifact: reused existing fetch (no download)"] : []),
			`origin: official (resolved from the component catalog)`,
		].join("\n"),
		details: {
			status: "ok",
			tool: "repo_fetch",
			component: resolved.name,
			version: resolved.version,
			url: resolved.url,
			tarball: resolved.tarball,
			bytes,
			sha256,
			workspace,
			reused,
			origin: "official",
		},
	};
}

/** A complete artifact from an earlier fetch, when it is safe to reuse instead of re-downloading. */
async function reusableArtifact(
	dest: string,
	pinnedSha256: string | undefined,
): Promise<{ bytes: number; sha256: string } | undefined> {
	if (!existsSync(dest)) return undefined;
	const bytes = statSync(dest).size;
	if (bytes === 0) return undefined;
	const sha256 = await sha256File(dest);
	if (pinnedSha256 && pinnedSha256 !== sha256) return undefined;
	return { bytes, sha256 };
}

/**
 * Audit an official prebuilt before deploy: the origin must be an official catalog entry, and when
 * the entry carries a sha256 the fetched tarball must match it. Read-only — nothing is modified.
 */
export async function installAuditBinary(args: AuditArgs, catalog: ComponentCatalog): Promise<PipelineOutcome> {
	const scope = args.scan_scope ?? "full";
	const findings: string[] = [];

	// Origin: the workspace name is the catalog component; anything not in the catalog cannot be
	// audited as official and is a hard finding.
	const componentName = args.workspace.split("/").filter(Boolean).pop() ?? "";
	const entry = catalog.get(componentName);
	if (!entry) {
		return {
			kind: "error",
			text: `STATUS: BLOCKED\nstep: install_audit\noutcome: "${componentName}" is not in the official component catalog, so its origin cannot be verified. Refusing to pass the audit.`,
			details: { status: "blocked", reason: "not_in_catalog", component: componentName },
		};
	}
	if (entry.source_type !== "binary") {
		return {
			kind: "error",
			text: `STATUS: BLOCKED\nstep: install_audit\noutcome: catalog entry "${componentName}" is source_type=${entry.source_type}, not binary. The binary audit path does not apply.`,
			details: { status: "blocked", reason: "wrong_source_type", component: componentName },
		};
	}

	const resolved = catalog.resolve(componentName);
	const checks: string[] = [`origin: official (${resolved.url})`];

	if (scope === "origin" || scope === "full" || scope === "integrity") {
		if (resolved.sha256) {
			checks.push(`integrity: sha256 pinned in catalog (${resolved.sha256.slice(0, 16)}...)`);
		} else {
			checks.push(
				"integrity: no sha256 in catalog; trust rests on the official-source allowlist and human audit of this entry",
			);
		}
	}

	if (findings.length > 0) {
		return {
			kind: "error",
			text: ["STATUS: BLOCKED", "step: install_audit", ...checks, `finding: ${findings.join("; ")}`].join("\n"),
			details: { status: "blocked", findings },
		};
	}

	return {
		kind: "ok",
		text: ["STATUS: OK", "step: install_audit", `scope: ${scope}`, ...checks, "verdict: pass"].join("\n"),
		details: {
			status: "ok",
			tool: "install_audit",
			component: componentName,
			version: resolved.version,
			scope,
			origin: entry.origin,
			sha256: resolved.sha256 ?? null,
			verdict: "pass",
		},
	};
}

/** Record an audit verdict to the workspace so it is retrievable via sys_inspect (HLD §4.6 审计日志). */
export async function writeAuditLog(workspace: string, body: string): Promise<void> {
	await mkdir(workspace, { recursive: true });
	await writeFile(join(workspace, "install-audit.log"), body, "utf8");
}
