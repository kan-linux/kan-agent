/**
 * The safe_rm_rf allowlist (HLD §9: install-prebuilts.sh's guard becomes a substrate primitive).
 * The pipeline runs as root on a live system, so removal must be bounded to the state dir and
 * tool roots under /opt — never /, /opt itself, a system root, or an arbitrary deep path. A
 * nested install root (vendor layout like /opt/google/chrome) is removable only as the exact
 * root its catalog entry declares.
 */

import { describe, expect, it } from "vitest";
import { assertSafeToRemove, KanPaths, UnsafePathError } from "../src/root.ts";

const paths = new KanPaths("/staging");

describe("assertSafeToRemove", () => {
	it("refuses the root, /opt itself, and system root dirs", () => {
		for (const target of ["/", "/opt", "/usr", "/etc", "/var", "/home", "/staging"]) {
			expect(() => assertSafeToRemove(paths, target), target).toThrow(UnsafePathError);
		}
	});

	it("refuses empty, relative, trailing-slash and parent-walking paths", () => {
		for (const target of ["", "opt/go", "/opt/go/", "/opt/go/../usr", "/staging/opt/../../etc", ".."]) {
			expect(() => assertSafeToRemove(paths, target), target).toThrow(UnsafePathError);
		}
	});

	it("refuses arbitrary depths below /opt: only a tool root itself is removable", () => {
		expect(() => assertSafeToRemove(paths, "/opt/go/bin")).toThrow(UnsafePathError);
		expect(() => assertSafeToRemove(paths, "/opt/go/bin/go")).toThrow(UnsafePathError);
		expect(() => assertSafeToRemove(paths, "/opt")).toThrow(UnsafePathError);
	});

	it("allows a nested install root only as the exact declared root", () => {
		expect(() => assertSafeToRemove(paths, "/staging/opt/google/chrome", "/staging/opt/google/chrome")).not.toThrow();
		// Without the declaration a nested root is still outside the one-level allowlist.
		expect(() => assertSafeToRemove(paths, "/staging/opt/google/chrome")).toThrow(UnsafePathError);
		expect(() =>
			assertSafeToRemove(paths, "/staging/opt/google/chrome/locales", "/staging/opt/google/chrome"),
		).toThrow(UnsafePathError);
		// A declared root deeper than one vendor level is never a tool root.
		expect(() => assertSafeToRemove(paths, "/staging/opt/a/b/c", "/staging/opt/a/b/c")).toThrow(UnsafePathError);
	});

	it("allows the state dir subtree and one-level tool roots under /opt", () => {
		for (const target of [
			"/staging/var/lib/kan-agent",
			"/staging/var/lib/kan-agent/workspace/go",
			"/staging/var/lib/kan-agent/store/go/1.27.4",
			"/staging/opt/go",
			"/staging/opt/libreoffice26.8",
		]) {
			expect(() => assertSafeToRemove(paths, target), target).not.toThrow();
		}
	});

	it("is a no-op for paths that do not exist inside the allowlist", () => {
		expect(() => assertSafeToRemove(paths, "/staging/opt/not-there")).not.toThrow();
	});
});

/**
 * The live filesystem (empty root prefix) is where the deploy actually runs as root. The staging
 * cases above cannot catch empty-root path bugs — a `join("", "opt")` is relative and silently
 * fails every allowlist comparison against "/opt".
 */
describe("assertSafeToRemove on the live root", () => {
	const live = new KanPaths("");

	it("allows removing a tool root under /opt", () => {
		expect(() => assertSafeToRemove(live, "/opt/go")).not.toThrow();
		expect(() => assertSafeToRemove(live, "/opt/libreoffice26.8")).not.toThrow();
	});

	it("allows removing inside the live state dir", () => {
		expect(() => assertSafeToRemove(live, "/var/lib/kan-agent/workspace/go")).not.toThrow();
	});

	it("still refuses the system roots and deep /opt paths", () => {
		for (const target of ["/", "/opt", "/usr", "/etc", "/opt/go/bin"]) {
			expect(() => assertSafeToRemove(live, target), target).toThrow(UnsafePathError);
		}
	});
});
