import {
	DEFAULT_RADIUS_GATEWAY,
	getRadiusModelsFromConfig,
	loadRadiusGatewayConfig,
} from "../../src/providers/radius-config.ts";
import type { Model } from "../../src/types.ts";
import {
	MODELS_DEV_DECISIONS_URL,
	MODELS_DEV_URL,
	type ModelsDevDecisionMetadata,
	type ModelsDevV2Catalog,
} from "./models-dev.ts";
import { fetchOpenRouterCatalog, type OpenRouterCatalog } from "./openrouter.ts";
import { readSnapshot, writeSnapshot } from "./snapshot.ts";
import { type AiGatewayCatalog, fetchAiGatewayCatalog } from "./vercel-ai-gateway.ts";

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** Everything fetched from upstream before the catalog is built. */
export interface CatalogSources {
	modelsDev: ModelsDevV2Catalog;
	modelsDevDecisions: Record<string, ModelsDevDecisionMetadata>;
	openRouter: OpenRouterCatalog;
	aiGateway: AiGatewayCatalog;
	/** Live NVIDIA NIM ids, keyed by both the raw and the normalized id. */
	nvidiaModelIds: Map<string, string>;
	radius: Model<"pi-messages">[];
}

export interface CatalogSourceOptions {
	/**
	 * How to obtain the sources: "snapshot" (default) reads the pinned snapshots, "pin" fetches
	 * the live sources and re-pins them, "fetch" fetches without touching the snapshots (what the
	 * generation tests use — they mock globalThis.fetch with fixture catalogs).
	 */
	mode?: "snapshot" | "pin" | "fetch";
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${label} returned ${response.status}`);
	return (await response.json()) as T;
}

export function normalizeNvidiaModelId(modelId: string): string {
	return modelId.toLowerCase().replaceAll("_", ".");
}

/** The raw NVIDIA NIM response, as pinned in the snapshot. */
export interface NvidiaModelsResponse {
	data?: { id: string }[];
}

export function buildNvidiaModelIds(data: NvidiaModelsResponse): Map<string, string> {
	const modelIds = new Map<string, string>();
	for (const model of data.data ?? []) {
		modelIds.set(model.id, model.id);
		modelIds.set(normalizeNvidiaModelId(model.id), model.id);
	}
	return modelIds;
}

async function fetchNvidiaModelsResponse(): Promise<NvidiaModelsResponse> {
	return await fetchJson<NvidiaModelsResponse>(`${NVIDIA_BASE_URL}/models`, "NVIDIA NIM API");
}

async function fetchRadiusModels(): Promise<Model<"pi-messages">[]> {
	const config = await loadRadiusGatewayConfig(DEFAULT_RADIUS_GATEWAY);
	const models = getRadiusModelsFromConfig("radius", config);
	if (models.length === 0) throw new Error("Radius API returned no models");
	return models;
}

/**
 * Fetch every upstream source. In strict mode any failure aborts generation;
 * otherwise a failed source contributes nothing.
 *
 * By default the pinned snapshots under sources/snapshots/ are read so generation is deterministic
 * and offline; `mode: "pin"` fetches the live sources and re-pins them; `mode: "fetch"` fetches
 * without writing snapshots.
 */
export async function loadCatalogSources(strict: boolean, options?: CatalogSourceOptions): Promise<CatalogSources> {
	const mode = options?.mode ?? "snapshot";

	async function load<T>(label: string, snapshotName: string, fetcher: () => Promise<T>, fallback: T): Promise<T> {
		if (mode === "snapshot") {
			try {
				console.log(`Reading snapshot ${snapshotName}...`);
				return readSnapshot<T>(snapshotName);
			} catch (error) {
				console.error(`Failed to read snapshot ${snapshotName}:`, error);
				if (strict) throw error;
				return fallback;
			}
		}
		try {
			console.log(`Fetching ${label}...`);
			const value = await fetcher();
			if (mode === "pin") writeSnapshot(snapshotName, value);
			return value;
		} catch (error) {
			console.error(`Failed to fetch ${label}:`, error);
			if (strict) throw error;
			return fallback;
		}
	}

	const modelsDev = await load(
		"models.dev catalog",
		"models-dev",
		() => fetchJson<ModelsDevV2Catalog>(MODELS_DEV_URL, "models.dev API"),
		{},
	);
	const modelsDevDecisions = await load(
		"models.dev decision models",
		"models-dev-decisions",
		() => fetchJson<Record<string, ModelsDevDecisionMetadata>>(MODELS_DEV_DECISIONS_URL, "models.dev decision API"),
		{},
	);
	const nvidiaModelIds = modelsDev.nvidia?.models
		? buildNvidiaModelIds(await load("NVIDIA NIM models", "nvidia-models", fetchNvidiaModelsResponse, { data: [] }))
		: new Map<string, string>();
	const openRouter = await load("OpenRouter models", "openrouter", fetchOpenRouterCatalog, {
		chat: [],
		images: [],
		classifiers: [],
	});
	if (strict && openRouter.images.length === 0) throw new Error("OpenRouter API returned no usable image models");
	const aiGateway = await load("Vercel AI Gateway models", "ai-gateway", fetchAiGatewayCatalog, {
		chat: [],
		classifiers: [],
	});
	const radius = await load("Radius models", "radius", fetchRadiusModels, []);

	return { modelsDev, modelsDevDecisions, openRouter, aiGateway, nvidiaModelIds, radius };
}
