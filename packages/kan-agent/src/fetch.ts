/**
 * Substrate fetch primitive for the install pipelines (HLD §9 absorption mapping: "fetch (临时落盘 +
 * 改名 + 重试)" becomes a system-substrate primitive shared by both install classes).
 *
 * Mirrors the safety conventions of kan-linux's vendor/install-prebuilts.sh `fetch()`: download to a
 * temporary `.part` file and rename into place so a failed download never leaves a truncated
 * artifact, retry transient network errors, and reject empty downloads. All removals stay inside
 * the caller's scratch directory.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";

export type FetchOutcome = { kind: "fetched"; bytes: number; sha256: string } | { kind: "failed"; reason: string };

export interface FetchOptions {
	/** How many attempts before giving up (install-prebuilts.sh uses 3). */
	attempts?: number;
	/** Expected sha256. When present a mismatch fails the fetch. */
	sha256?: string;
	signal?: AbortSignal;
}

const DEFAULT_ATTEMPTS = 3;

/** Download `url` to `dest`, never leaving a partial file at `dest`. */
export async function fetchToFile(url: string, dest: string, options: FetchOptions = {}): Promise<FetchOutcome> {
	const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
	const part = `${dest}.part`;
	let lastReason = "download failed";

	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (options.signal?.aborted) return { kind: "failed", reason: "aborted" };
		await rm(part, { force: true });
		const result = await attemptOnce(url, part, options.signal);
		if (result.kind === "ok") {
			const size = (await stat(part)).size;
			if (size === 0) {
				await rm(part, { force: true });
				lastReason = `download empty: ${url}`;
				continue;
			}
			const sha256 = await hashFile(part);
			if (options.sha256 && options.sha256 !== sha256) {
				await rm(part, { force: true });
				return { kind: "failed", reason: `integrity mismatch: expected sha256 ${options.sha256}, got ${sha256}` };
			}
			await rename(part, dest);
			return { kind: "fetched", bytes: size, sha256 };
		}
		lastReason = result.reason;
	}
	await rm(part, { force: true });
	return { kind: "failed", reason: `${lastReason} (${attempts} attempts)` };
}

type AttemptOutcome = { kind: "ok" } | { kind: "error"; reason: string };

async function attemptOnce(url: string, part: string, signal?: AbortSignal): Promise<AttemptOutcome> {
	try {
		const response = await fetch(url, { redirect: "follow", signal });
		if (!response.ok || !response.body) {
			return { kind: "error", reason: `HTTP ${response.status} for ${url}` };
		}
		const sink = createWriteStream(part);
		try {
			const reader = response.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				await new Promise<void>((resolve, reject) => {
					sink.write(value, (err) => (err ? reject(err) : resolve()));
				});
			}
		} finally {
			await new Promise<void>((resolve) => sink.end(resolve));
		}
		return { kind: "ok" };
	} catch (e) {
		return { kind: "error", reason: (e as Error).message };
	}
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	const { readFile } = await import("node:fs/promises");
	hash.update(await readFile(path));
	return hash.digest("hex");
}
