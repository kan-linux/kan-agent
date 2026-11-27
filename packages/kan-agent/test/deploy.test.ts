/**
 * atomic_deploy and system_rollback (HLD §4.5).
 *
 * The health-check test is the point of this file: a deploy once reported success while the health
 * check had silently run a HOST binary instead of the deployed one, because the store's read-only
 * pass had stripped the execute bit. The fake tool prints a marker string so the test can tell the
 * deployed binary apart from any host binary of the same name.
 */

import { mkdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComponentCatalog } from "../src/catalog.ts";
import { atomicDeployBinary, systemRollback } from "../src/deploy.ts";
import { KanPaths } from "../src/root.ts";
import { GenerationStore } from "../src/store.ts";
import { fetchedArtifact, makeFakeTarball, makeStagingRoot, removeStagingRoot } from "./fixture.ts";

const base = join(import.meta.dirname, ".tmp");
const DEPLOYED_MARKER = "marker-from-deployed-binary";

let root: string;
let paths: KanPaths;
// The shipped catalog pins a ~10G preflight for real installs; tests deploy into a staging root
// and state their own (zero) requirement instead of asserting the developer's free disk.
const catalog = new ComponentCatalog(ComponentCatalog.load().entries(), { free_space_preflight_mb: 0 });

beforeEach(() => {
	root = makeStagingRoot(base, "deploy-test");
	process.env.PI_KAN_ROOT = root;
	paths = new KanPaths(root);
});

afterEach(() => {
	removeStagingRoot(root);
	delete process.env.PI_KAN_ROOT;
});

/** A fetched `go` tarball at the path repo_fetch would have left it. */
function stageFetchedGo(tarball: string, report: string): string {
	const artifact = fetchedArtifact(root, "go", tarball);
	makeFakeTarball(base, { name: "go", binary: "go", report, output: artifact });
	return artifact;
}

describe("atomicDeployBinary", () => {
	it("deploys to the store, flips /opt, and records a generation", async () => {
		const artifact = stageFetchedGo("go1.27.4.linux-amd64.tar.gz", DEPLOYED_MARKER);
		const outcome = await atomicDeployBinary({ component: "go", version: "1.27.4", artifact }, paths, catalog);
		expect(outcome.kind).toBe("ok");
		expect(readlinkSync(paths.installRoot("/opt/go"))).toBe("..".concat("/var/lib/kan-agent/store/go/1.27.4"));
		expect(new GenerationStore(paths).current("go")?.generation).toBe(1);
	});

	it("health-checks the DEPLOYED binary, not a host one", async () => {
		const artifact = stageFetchedGo("go1.27.4.linux-amd64.tar.gz", DEPLOYED_MARKER);
		const outcome = await atomicDeployBinary(
			{ component: "go", version: "1.27.4", artifact, verify_cmd: "go version" },
			paths,
			catalog,
		);
		expect(outcome.kind).toBe("ok");
		// The regression: this once reported the HOST tool's output because the stored binary had
		// lost its execute bit and PATH lookup silently fell through to the host.
		expect(outcome.text).toContain(DEPLOYED_MARKER);
	});

	it("resolves the fetched package when the artifact is the workspace directory", async () => {
		const artifact = stageFetchedGo("go1.27.4.linux-amd64.tar.gz", DEPLOYED_MARKER);
		const workspace = artifact.slice(0, artifact.lastIndexOf("/"));
		const outcome = await atomicDeployBinary(
			{ component: "go", version: "1.27.4", artifact: workspace },
			paths,
			catalog,
		);
		expect(outcome.kind).toBe("ok");
		expect(readlinkSync(paths.installRoot("/opt/go"))).toContain("store");
	});

	it("rejects a directory artifact that does not hold the fetched package", async () => {
		const artifact = stageFetchedGo("go1.27.4.linux-amd64.tar.gz", DEPLOYED_MARKER);
		const workspace = artifact.slice(0, artifact.lastIndexOf("/"));
		const other = join(workspace, "not-the-package");
		mkdirSync(other, { recursive: true });
		const outcome = await atomicDeployBinary({ component: "go", version: "1.27.4", artifact: other }, paths, catalog);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("must be the fetched package file");
	});

	it("rejects a component that is not in the catalog", async () => {
		const artifact = stageFetchedGo("go1.27.4.linux-amd64.tar.gz", DEPLOYED_MARKER);
		const outcome = await atomicDeployBinary({ component: "nope", version: "1", artifact }, paths, catalog);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("not in the official component catalog");
	});

	it("rejects a version that is not in the catalog", async () => {
		const artifact = stageFetchedGo("go1.27.4.linux-amd64.tar.gz", DEPLOYED_MARKER);
		const outcome = await atomicDeployBinary({ component: "go", version: "99.99", artifact }, paths, catalog);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("not in the catalog");
	});

	it("rejects a verify_cmd with shell metacharacters", async () => {
		const artifact = stageFetchedGo("go1.27.4.linux-amd64.tar.gz", DEPLOYED_MARKER);
		const outcome = await atomicDeployBinary(
			{ component: "go", version: "1.27.4", artifact, verify_cmd: "go version; rm -rf /" },
			paths,
			catalog,
		);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("shell metacharacters");
	});

	it("rejects a verify_cmd whose binary is not in the deployed install root", async () => {
		const artifact = stageFetchedGo("go1.27.4.linux-amd64.tar.gz", DEPLOYED_MARKER);
		const outcome = await atomicDeployBinary(
			{ component: "go", version: "1.27.4", artifact, verify_cmd: "definitely-not-here --version" },
			paths,
			catalog,
		);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("not in the deployed install root");
	});

	it("rolls back to the previous generation when the health check fails", async () => {
		const good = await atomicDeployBinary(
			{
				component: "go",
				version: "1.27.4",
				artifact: stageFetchedGo("go1.27.4.linux-amd64.tar.gz", "good"),
				verify_cmd: "go version",
			},
			paths,
			catalog,
		);
		expect(good.kind).toBe("ok");

		const outcome = await atomicDeployBinary(
			{
				component: "go",
				version: "1.27.3",
				artifact: stageFetchedGo("go1.27.3.linux-amd64.tar.gz", "bad"),
				verify_cmd: "go --not-a-real-flag",
			},
			paths,
			catalog,
		);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("verify");
		// The failed deploy must not stay current: the previous generation is restored.
		expect(new GenerationStore(paths).current("go")?.generation).toBe(1);
	});
});

describe("systemRollback", () => {
	it("rolls back to a named generation", async () => {
		await atomicDeployBinary(
			{ component: "go", version: "1.27.4", artifact: stageFetchedGo("go1.27.4.linux-amd64.tar.gz", "one") },
			paths,
			catalog,
		);
		await atomicDeployBinary(
			{ component: "go", version: "1.27.3", artifact: stageFetchedGo("go1.27.3.linux-amd64.tar.gz", "two") },
			paths,
			catalog,
		);
		expect(new GenerationStore(paths).current("go")?.generation).toBe(2);

		const outcome = await systemRollback({ component: "go", generation: "1" }, paths, catalog);
		expect(outcome.kind).toBe("ok");
		expect(new GenerationStore(paths).current("go")?.generation).toBe(1);
		expect(readlinkSync(paths.installRoot("/opt/go"))).toContain("1.27.4");
	});

	it("rejects a generation that does not exist", async () => {
		const outcome = await systemRollback({ component: "go", generation: "99" }, paths, catalog);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("does not exist");
	});

	it("rejects a non-numeric generation", async () => {
		const outcome = await systemRollback({ component: "go", generation: "latest" }, paths, catalog);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("positive integer");
	});

	it("needs a component and has no failure to default to", async () => {
		const outcome = await systemRollback({ generation: "1" }, paths, catalog);
		expect(outcome.kind).toBe("error");
		expect(outcome.text).toContain("no recorded failed deploy");
	});

	it("defaults to the component of the last failed deploy", async () => {
		await atomicDeployBinary(
			{ component: "go", version: "1.27.4", artifact: stageFetchedGo("go1.27.4.linux-amd64.tar.gz", "one") },
			paths,
			catalog,
		);
		const failed = await atomicDeployBinary(
			{
				component: "go",
				version: "1.27.3",
				artifact: stageFetchedGo("go1.27.3.linux-amd64.tar.gz", "two"),
				verify_cmd: "go --not-a-real-flag",
			},
			paths,
			catalog,
		);
		expect(failed.kind).toBe("error");

		const rolled = await systemRollback({ generation: "1" }, paths, catalog);
		expect(rolled.kind).toBe("ok");
		expect(rolled.text).toContain("component: go");
	});
});
