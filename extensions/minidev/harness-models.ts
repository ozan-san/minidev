/**
 * Host `ModelRegistry` → pi-ai `Models` bridge.
 *
 * pi-durable's `Harness` expects a pi-ai `Models` collection, while extensions only receive the host's synchronous
 * `ctx.modelRegistry` facade. This module adapts the structural subset the harness actually calls and makes the rest
 * fail loudly, so a missing host capability never silently degrades into a no-op.
 */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthResult,
	Context,
	Model,
	ModelType,
	ModelTypeMap,
	Models,
	ModelsApiStreamOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsSimpleStreamOptions,
	Provider,
} from "@earendil-works/pi-ai";

// Structural subset of the host's ModelRegistry that the harness needs.
export interface ModelRegistryLike {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAll(): readonly Model<Api>[];
	getAvailable(providerId?: string): Model<Api>[];
	getModelsOfType<T extends ModelType>(type: T, providerId?: string): readonly ModelTypeMap[T][];
	getModelOfType<T extends ModelType>(type: T, providerId: string, modelId: string): ModelTypeMap[T] | undefined;
	getAvailableOfType<T extends ModelType>(type: T, providerId?: string): Promise<readonly ModelTypeMap[T][]>;
	getProvider(providerId: string): Provider | undefined;
	getRegisteredProviderIds?(): readonly string[];
	getProviderAuth(providerId: string): Promise<AuthResult | undefined>;
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
	stream<T extends Api>(model: Model<T>, context: Context, options?: ModelsApiStreamOptions<T>): AssistantMessageEventStream;
	complete<T extends Api>(model: Model<T>, context: Context, options?: ModelsApiStreamOptions<T>): Promise<AssistantMessage>;
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
}

const ALL_MODEL_TYPES: readonly ModelType[] = ["chat", "image", "classifier"];

export function modelsFromRegistry(registry: ModelRegistryLike): Models {
	const unsupported = (feature: string) => () => {
		throw new Error(`minidev: ${feature} is not supported through the host model registry`);
	};
	return {
		// Provider discovery is optional on the host: fall back to no providers when it is absent.
		getProviders: (): readonly Provider[] =>
			(registry.getRegisteredProviderIds?.() ?? [])
				.map((id) => registry.getProvider(id))
				.filter((provider): provider is Provider => provider !== undefined),
		getProvider: (id: string) => registry.getProvider(id),
		getModels: (provider?: string) => registry.getModelsOfType("chat", provider),
		getModel: (provider: string, id: string) => registry.find(provider, id),
		getModelsOfType: <T extends ModelType>(type: T, provider?: string) => registry.getModelsOfType(type, provider),
		getModelOfType: <T extends ModelType>(type: T, provider: string, id: string) =>
			registry.getModelOfType(type, provider, id),
		getAllModels: (provider?: string) => ALL_MODEL_TYPES.flatMap((type) => registry.getModelsOfType(type, provider)),
		refresh: (options?: ModelsRefreshOptions) => registry.refresh(options),
		checkAuth: async () => undefined,
		getAvailable: async (providerId?: string) => registry.getAvailable(providerId),
		getAvailableOfType: <T extends ModelType>(type: T, providerId?: string) => registry.getAvailableOfType(type, providerId),
		getAllAvailable: async (providerId?: string) => registry.getAvailable(providerId),
		getAuth: async (providerOrModel: string | Model<Api>) =>
			registry.getProviderAuth(typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider),
		stream: <T extends Api>(model: Model<T>, context: Context, options?: ModelsApiStreamOptions<T>) =>
			registry.stream(model, context, options),
		complete: <T extends Api>(model: Model<T>, context: Context, options?: ModelsApiStreamOptions<T>) =>
			registry.complete(model, context, options),
		streamSimple: (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) =>
			registry.streamSimple(model, context, options),
		completeSimple: async (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) =>
			registry.streamSimple(model, context, options).result(),
		login: unsupported("login"),
		logout: unsupported("logout"),
		streamDeferred: unsupported("deferred responses"),
		fetchDeferred: unsupported("deferred responses"),
		cancelDeferred: unsupported("deferred responses"),
		generateImages: unsupported("image generation"),
		classify: unsupported("classification"),
		// The host registry covers everything the harness calls; the rest throws above.
	} as unknown as Models;
}

export interface ParsedModelRef {
	provider: string;
	modelId: string;
}

/** Split a `provider/model` reference at the first slash, so model ids may contain slashes. */
export function parseModelRef(ref: string): ParsedModelRef | undefined {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

/** Resolve a `provider/model` reference against the live registry, falling back to any available model that matches. */
export function resolveModelRef(registry: ModelRegistryLike, ref: string): ParsedModelRef | undefined {
	const parsed = parseModelRef(ref);
	if (!parsed) return undefined;
	if (registry.find(parsed.provider, parsed.modelId)) return parsed;
	const match = registry.getAvailable().find((m) => `${m.provider}/${m.id}` === ref || m.id === ref);
	return match ? { provider: match.provider, modelId: match.id } : undefined;
}
