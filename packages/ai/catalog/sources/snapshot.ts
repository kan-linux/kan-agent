/**
 * Vendored upstream snapshots for reproducible catalog generation.
 *
 * `generate-models` reads these files by default instead of fetching live sources, so every build
 * sees the same model catalog — the tests, the types derived from src/providers/data/, and a user
 * building from source all agree. `npm run update-model-snapshots` refreshes the snapshots from the
 * live sources; the result is committed like code, because it is the pinned input of every future
 * generation.
 *
 * Snapshots are gzip-compressed JSON on disk (the models.dev catalog alone is ~24 MB raw).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

export const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

/** The pinned upstream payload for `name` (e.g. "models-dev" -> snapshots/models-dev.json.gz). */
export function readSnapshot<T>(name: string): T {
	const path = join(SNAPSHOT_DIR, `${name}.json.gz`);
	if (!existsSync(path)) {
		throw new Error(
			`catalog snapshot ${path} is missing; run 'npm run update-model-snapshots' and commit the result`,
		);
	}
	return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as T;
}

/** Pin the just-fetched payload for `name`. Only called on a successful fetch. */
export function writeSnapshot(name: string, value: unknown): void {
	mkdirSync(SNAPSHOT_DIR, { recursive: true });
	writeFileSync(
		join(SNAPSHOT_DIR, `${name}.json.gz`),
		gzipSync(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"), { level: 9 }),
	);
}
