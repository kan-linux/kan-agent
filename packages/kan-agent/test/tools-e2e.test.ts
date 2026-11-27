/**
 * Tool-layer end-to-end: the binary install pipeline as a single run, without a model.
 *
 * This is the chain that was run by hand against Go and is now fixed in place: repo_fetch ->
 * install_audit -> atomic_deploy -> verify -> system_rollback, plus the anti-fabrication and
 * permission boundaries. It drives the real tool implementations, so the fetch is a real HTTP
 * download with real sha256 verification — but it is served from a local server against a test
 * catalog, so the run is offline and fast enough for CI. No model, no llama-server.
 */

import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CatalogEntry, ComponentCatalog } from "../src/catalog.ts";
import { atomicDeployBinary, systemRollback } from "../src/deploy.ts";
import { HIGH_RISK_TOOLS, registerPermissionGate } from "../src/permission.ts";
import { installAuditBinary, repoFetchBinary } from "../src/pipeline-binary.ts";
import { KanPaths } from "../src/root.ts";
import { GenerationStore } from "../src/store.ts";
import { makeFakeTarball, makeStagingRoot, removeStagingRoot } from "./fixture.ts";

const base = join(import.meta.dirname, ".tmp");
/** Scratch for this file's tarballs, so cleanup never touches other test files' staging roots. */
const artifactsDir = join(base, "e2e-artifacts");
const COMPONENT = "e2e-tool";
/** Two versions with distinguishable content, so a rollback can be observed in the bytes. */
const VERSIONS = [
	{ version: "1.0.0", report: "content-of-1.0.0" },
	{ version: "1.0.1", report: "content-of-1.0.1" },
];

let root: string;
let paths: KanPaths;
let server: Server;
let baseUrl: string;
let catalog: ComponentCatalog;
const artifacts = new Map<string, { sha256: string; tarball: string }>();

/** Serve each version's tarball so repo_fetch does a real HTTP download. */
beforeAll(async () => {
	server = createServer((req, res) => {
		const hit = [...artifacts.entries()].find(([name]) => req.url === `/${name}`);
		if (!hit) {
			res.writeHead(404).end("not found");
			return;
		}
		const bytes = readFileSync(join(artifactsDir, hit[0]));
		res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
		res.end(bytes);
	});

	for (const { version, report } of VERSIONS) {
		const tarball = `${COMPONENT}-${version}.tar.gz`;
		const path = makeFakeTarball(base, {
			name: COMPONENT,
			binary: COMPONENT,
			report,
			output: join(artifactsDir, tarball),
		});
		artifacts.set(tarball, {
			tarball,
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		});
	}

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	removeStagingRoot(artifactsDir);
});

/**
 * A one-component catalog pointed at the local server. `origin` stays "official" because that field
 * is the human-audited marker on a catalog entry, not something derived from the URL; the pipeline
 * mechanics under test here are the same either way.
 */
function writeTestCatalog(dir: string, hashOverride?: Record<string, string>): string {
	const entry: CatalogEntry = {
		name: COMPONENT,
		description: "Tool-layer e2e fixture component.",
		source_type: "binary",
		origin: "official",
		image_class: "optional",
		tarball_pattern: `${COMPONENT}-{version}.tar.gz`,
		url_pattern: `${baseUrl}/{tarball}`,
		versions: VERSIONS.map((v) => v.version),
		default_version: VERSIONS[0].version,
		install_root: `/opt/${COMPONENT}`,
		extract_root: "/opt",
		extract: { kind: "tar_topdir" },
		verify_cmd: `${COMPONENT} --version`,
		config_placement: [],
		dependencies: [],
		sha256:
			hashOverride ??
			Object.fromEntries(
				VERSIONS.map((v) => [v.version, artifacts.get(`${COMPONENT}-${v.version}.tar.gz`)!.sha256]),
			),
	};
	const path = join(dir, "catalog.json");
	writeFileSync(
		path,
		JSON.stringify({ schema_version: "0.2.0", free_space_preflight_mb: 0, components: [entry] }, null, 2),
		"utf8",
	);
	return path;
}

function fetchedDir(): string {
	return join(paths.workspaceDir, COMPONENT);
}

function artifactOf(version: string): string {
	return join(fetchedDir(), `${COMPONENT}-${version}.tar.gz`);
}

beforeEach(() => {
	root = makeStagingRoot(base, "e2e");
	process.env.PI_KAN_ROOT = root;
	paths = new KanPaths(root);
	catalog = ComponentCatalog.load(writeTestCatalog(root));
});

afterEach(() => {
	removeStagingRoot(root);
	delete process.env.PI_KAN_ROOT;
});

describe("binary install pipeline", () => {
	it("runs fetch -> audit -> deploy -> verify as one install", async () => {
		const fetched = await repoFetchBinary({ source_type: "binary", component: COMPONENT }, paths, catalog);
		expect(fetched.kind).toBe("ok");
		expect(fetched.text).toContain(artifacts.get(`${COMPONENT}-1.0.0.tar.gz`)!.sha256);

		const audit = await installAuditBinary(
			{ source_type: "binary", workspace: fetchedDir(), scan_scope: "full" },
			catalog,
		);
		expect(audit.kind).toBe("ok");
		expect(audit.text).toContain("origin: official");
		expect(audit.text).toContain("sha256 pinned");

		const deployed = await atomicDeployBinary(
			{ component: COMPONENT, version: "1.0.0", artifact: artifactOf("1.0.0") },
			paths,
			catalog,
		);
		expect(deployed.kind).toBe("ok");
		// The health check must have run the DEPLOYED binary, not any host one.
		expect(deployed.text).toContain("content-of-1.0.0");
		expect(readlinkSync(paths.installRoot(COMPONENT))).toContain("1.0.0");
		expect(new GenerationStore(paths).current(COMPONENT)?.generation).toBe(1);
	});

	it("refuses a caller-supplied URL for source_type=binary", async () => {
		const outcome = await repoFetchBinary(
			{ source_type: "binary", component: COMPONENT, url: "https://evil.example.com/x.tgz" },
			paths,
			catalog,
		);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("does not accept a caller-supplied url");
	});

	it("refuses a component that is not in the catalog", async () => {
		const outcome = await repoFetchBinary({ source_type: "binary", component: "not-in-catalog" }, paths, catalog);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("not in the official component catalog");
	});

	it("refuses a version that is not in the catalog", async () => {
		const outcome = await repoFetchBinary(
			{ source_type: "binary", component: COMPONENT, ref: "9.9.9" },
			paths,
			catalog,
		);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("not in the catalog");
	});

	it("fails the fetch when the downloaded bytes do not match the pinned sha256", async () => {
		const tampered = ComponentCatalog.load(
			writeTestCatalog(root, Object.fromEntries(VERSIONS.map((v) => [v.version, "0".repeat(64)]))),
		);
		const outcome = await repoFetchBinary({ source_type: "binary", component: COMPONENT }, paths, tampered);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("integrity mismatch");
	});

	it("reuses a complete artifact on retry instead of re-downloading", async () => {
		const first = await repoFetchBinary(
			{ source_type: "binary", component: COMPONENT, ref: "1.0.0" },
			paths,
			catalog,
		);
		expect(first.kind).toBe("ok");
		expect(first.details.reused).toBe(false);

		const second = await repoFetchBinary(
			{ source_type: "binary", component: COMPONENT, ref: "1.0.0" },
			paths,
			catalog,
		);
		expect(second.kind).toBe("ok");
		expect(second.details.reused).toBe(true);
		expect(second.text).toContain("artifact_reused: true");
		// The retry reports the same artifact facts as the first fetch.
		expect(second.details.sha256).toBe(first.details.sha256);
	});

	it("reports the full artifact path for the deploy step to consume", async () => {
		const outcome = await repoFetchBinary(
			{ source_type: "binary", component: COMPONENT, ref: "1.0.1" },
			paths,
			catalog,
		);
		expect(outcome.kind).toBe("ok");
		expect(outcome.details.artifact).toBe(`${outcome.details.workspace}/${outcome.details.tarball}`);
		expect(outcome.text).toContain(`artifact: ${outcome.details.artifact}`);
	});

	it("rolls back the CONTENT to the previous generation when the health check fails", async () => {
		await repoFetchBinary({ source_type: "binary", component: COMPONENT }, paths, catalog);
		await atomicDeployBinary(
			{ component: COMPONENT, version: "1.0.0", artifact: artifactOf("1.0.0") },
			paths,
			catalog,
		);
		expect(new GenerationStore(paths).current(COMPONENT)?.generation).toBe(1);

		// Fetch and deploy the second version, whose health check must fail: the deployed binary
		// rejects this flag. The failed deploy must not stay current.
		await repoFetchBinary({ source_type: "binary", component: COMPONENT, ref: "1.0.1" }, paths, catalog);
		const failed = await atomicDeployBinary(
			{
				component: COMPONENT,
				version: "1.0.1",
				artifact: artifactOf("1.0.1"),
				verify_cmd: `${COMPONENT} --not-a-real-flag`,
			},
			paths,
			catalog,
		);
		expect(failed.kind).toBe("error");
		expect(failed.text).toContain("verify");
		expect(failed.text).toContain("rolled back to generation 1");
		expect(new GenerationStore(paths).current(COMPONENT)?.generation).toBe(1);
		expect(readlinkSync(paths.installRoot(COMPONENT))).toContain("1.0.0");
	});

	it("rolls back to a named generation and restores its content", async () => {
		await repoFetchBinary({ source_type: "binary", component: COMPONENT }, paths, catalog);
		await atomicDeployBinary(
			{ component: COMPONENT, version: "1.0.0", artifact: artifactOf("1.0.0") },
			paths,
			catalog,
		);
		await repoFetchBinary({ source_type: "binary", component: COMPONENT, ref: "1.0.1" }, paths, catalog);
		await atomicDeployBinary(
			{ component: COMPONENT, version: "1.0.1", artifact: artifactOf("1.0.1") },
			paths,
			catalog,
		);
		expect(new GenerationStore(paths).current(COMPONENT)?.generation).toBe(2);

		const rolled = await systemRollback({ component: COMPONENT, generation: "1" }, paths, catalog);
		expect(rolled.kind).toBe("ok");
		expect(new GenerationStore(paths).current(COMPONENT)?.generation).toBe(1);
		expect(readlinkSync(paths.installRoot(COMPONENT))).toContain("1.0.0");
	});

	it("rejects a rollback to a generation that does not exist", async () => {
		const outcome = await systemRollback({ component: COMPONENT, generation: "42" }, paths, catalog);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("does not exist");
	});
});

/**
 * The permission gate: high-risk tools must not run without an explicit decision. These drive the
 * gate's handler directly with a stub context, so no pi runtime and no UI are needed.
 */
describe("permission gate", () => {
	function stubExtension() {
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const pi = {
			on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
				handlers[event] = handler;
				return () => {
					delete handlers[event];
				};
			},
		} as unknown as ExtensionAPI;
		registerPermissionGate(pi);
		return (event: unknown, ctx: unknown): Promise<ToolCallEventResult | undefined> =>
			handlers.tool_call(event, ctx) as Promise<ToolCallEventResult | undefined>;
	}

	// The gate only reads hasUI and ui.confirm, so a partial context is enough here.
	function stubContext(options: { hasUI: boolean; confirmed: boolean }): ExtensionContext {
		return {
			hasUI: options.hasUI,
			ui: { confirm: async () => options.confirmed },
		} as unknown as ExtensionContext;
	}

	it("gates the tools the design marks high-risk", () => {
		for (const name of ["atomic_deploy", "system_rollback", "source_patch", "sandbox_build"]) {
			expect(HIGH_RISK_TOOLS.has(name), name).toBe(true);
		}
		expect(HIGH_RISK_TOOLS.has("sys_inspect")).toBe(false);
		expect(HIGH_RISK_TOOLS.has("install_audit")).toBe(false);
	});

	it("allows a high-risk call without a UI: the headless run is the run-level authorization", async () => {
		const fire = stubExtension();
		const result = await fire(
			{ toolName: "atomic_deploy", input: { component: COMPONENT } },
			stubContext({ hasUI: false, confirmed: true }),
		);
		expect(result).toBeUndefined();
	});

	it("blocks a destructive operation even in a headless run", async () => {
		const fire = stubExtension();
		const result = await fire(
			{ toolName: "atomic_deploy", input: { component: "go", verify_cmd: "rm -rf /opt" } },
			stubContext({ hasUI: false, confirmed: true }),
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("destructive");
	});

	it("blocks a high-risk call the user declined", async () => {
		const fire = stubExtension();
		const result = await fire(
			{ toolName: "atomic_deploy", input: {} },
			stubContext({ hasUI: true, confirmed: false }),
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("declined");
	});

	it("lets a high-risk call through once the user confirms it", async () => {
		const fire = stubExtension();
		const result = await fire(
			{ toolName: "atomic_deploy", input: {} },
			stubContext({ hasUI: true, confirmed: true }),
		);
		expect(result?.block).toBeUndefined();
	});

	it("does not gate a read-only tool", async () => {
		const fire = stubExtension();
		const result = await fire(
			{ toolName: "sys_inspect", input: { action: "check_env" } },
			stubContext({ hasUI: false, confirmed: false }),
		);
		expect(result).toBeUndefined();
	});

	it("blocks destructive operations outright, even with confirmation", async () => {
		const fire = stubExtension();
		const destructive: Record<string, unknown>[] = [
			{ component: "go", verify_cmd: "rm -rf /" },
			{ component: "go", verify_cmd: "rm -rf /opt" },
			{ component: "go", verify_cmd: "rm -rf /etc" },
			{ component: "go", verify_cmd: "rm -rf /usr" },
			{ component: "go", verify_cmd: "rm -rf / usr" },
			{ component: "go", verify_cmd: "rm -fr /usr && true" },
			{ command: "dd if=/dev/zero of=/dev/sda" },
			{ content: "mkfs.ext4 /dev/sda1" },
			{ command: ":(){ :|:& };:" },
		];
		for (const input of destructive) {
			const result = await fire({ toolName: "atomic_deploy", input }, stubContext({ hasUI: true, confirmed: true }));
			expect(result?.block, JSON.stringify(input)).toBe(true);
			expect(result?.reason).toContain("destructive");
		}
	});

	it("does not flag ordinary tool arguments as destructive", async () => {
		const fire = stubExtension();
		const ordinary: Record<string, unknown>[] = [
			{ source_type: "binary", component: "go" },
			{ component: "go", verify_cmd: "bin/go version" },
			{ component: "go", verify_cmd: "rm -f /opt/go/bin/stale-file" },
			{ content: "fix the build script to echo ok" },
		];
		for (const input of ordinary) {
			const result = await fire({ toolName: "repo_fetch", input }, stubContext({ hasUI: false, confirmed: true }));
			expect(result, JSON.stringify(input)).toBeUndefined();
		}
	});
});
