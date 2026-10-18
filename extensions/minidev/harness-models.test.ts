import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { modelsFromRegistry, parseModelRef, resolveModelRef, type ModelRegistryLike } from "./harness-models.ts";

/** Minimal `Model<Api>` stand-in; only `provider` and `id` are needed by the bridge. */
function model(provider: string, id: string): never {
	return { provider, id } as never;
}

function fakeRegistry(overrides: Partial<ModelRegistryLike> = {}): ModelRegistryLike {
	return {
		find: () => undefined,
		getAll: () => [],
		getAvailable: () => [],
		getModelsOfType: () => [],
		getModelOfType: () => undefined,
		getAvailableOfType: async () => [],
		getProvider: () => undefined,
		getProviderAuth: async () => undefined,
		refresh: async () => ({}) as never,
		stream: () => {
			throw new Error("unexpected stream");
		},
		complete: async () => {
			throw new Error("unexpected complete");
		},
		streamSimple: () => {
			throw new Error("unexpected streamSimple");
		},
		...overrides,
	} as unknown as ModelRegistryLike;
}

describe("parseModelRef", () => {
	test("splits at the first slash so model ids may contain slashes", () => {
		assert.deepEqual(parseModelRef("openrouter/anthropic/claude-opus-5.5"), {
			provider: "openrouter",
			modelId: "anthropic/claude-opus-5.5",
		});
		assert.deepEqual(parseModelRef("openai/gpt-5"), { provider: "openai", modelId: "gpt-5" });
	});

	test("trims surrounding whitespace", () => {
		assert.deepEqual(parseModelRef("  openai/gpt-5  "), { provider: "openai", modelId: "gpt-5" });
	});

	test("rejects refs without both sides of a slash", () => {
		assert.equal(parseModelRef("gpt-5"), undefined);
		assert.equal(parseModelRef("/gpt-5"), undefined);
		assert.equal(parseModelRef("openai/"), undefined);
		assert.equal(parseModelRef(""), undefined);
	});
});

describe("resolveModelRef", () => {
	test("returns the registry's provider/modelId when find hits", () => {
		const found = model("openai", "gpt-5");
		const registry = fakeRegistry({ find: () => found as never });
		assert.deepEqual(resolveModelRef(registry, "openai/gpt-5"), { provider: "openai", modelId: "gpt-5" });
	});

	test("falls back to an available model matched by fully-qualified ref", () => {
		const available = [model("openrouter", "anthropic/claude-opus-5.5")];
		const registry = fakeRegistry({ getAvailable: () => available as never });
		assert.deepEqual(resolveModelRef(registry, "openrouter/anthropic/claude-opus-5.5"), {
			provider: "openrouter",
			modelId: "anthropic/claude-opus-5.5",
		});
	});

	test("falls back to an available model whose id equals the ref", () => {
		const available = [model("proxy", "openai/gpt-5")];
		const registry = fakeRegistry({ getAvailable: () => available as never });
		assert.deepEqual(resolveModelRef(registry, "openai/gpt-5"), { provider: "proxy", modelId: "openai/gpt-5" });
	});

	test("returns undefined when nothing matches", () => {
		const registry = fakeRegistry();
		assert.equal(resolveModelRef(registry, "openai/gpt-5"), undefined);
		assert.equal(resolveModelRef(registry, "nope"), undefined);
	});
});

describe("modelsFromRegistry", () => {
	test("getModel delegates to find", () => {
		const found = model("p", "m");
		let asked: [string, string] | undefined;
		const registry = fakeRegistry({
			find: (provider, id) => {
				asked = [provider, id];
				return found as never;
			},
		});
		assert.equal(modelsFromRegistry(registry).getModel("p", "m"), found);
		assert.deepEqual(asked, ["p", "m"]);
	});

	test("getAvailable awaits the sync host method and forwards the provider", async () => {
		const available = [model("p", "a")];
		let asked: string | undefined;
		const registry = fakeRegistry({
			getAvailable: (providerId) => {
				asked = providerId;
				return available as never;
			},
		});
		assert.deepEqual(await modelsFromRegistry(registry).getAvailable("p"), available);
		assert.equal(asked, "p");
	});

	test("completeSimple resolves streamSimple(...).result()", async () => {
		const answer = { role: "assistant", content: [] };
		const stream = { result: () => Promise.resolve(answer) };
		const registry = fakeRegistry({ streamSimple: () => stream as never });
		const result = await modelsFromRegistry(registry).completeSimple(model("p", "m"), {} as never);
		assert.equal(result, answer);
	});

	test("getProviders maps registered ids through getProvider and drops misses", () => {
		const providers = [model("a", "x"), model("b", "y")];
		const registry = fakeRegistry({
			getRegisteredProviderIds: () => ["a", "missing", "b"],
			getProvider: (id) => (id === "missing" ? undefined : providers[id === "a" ? 0 : 1]),
		});
		assert.deepEqual(modelsFromRegistry(registry).getProviders(), providers);
	});

	test("getProviders is empty when the host cannot enumerate providers", () => {
		assert.deepEqual(modelsFromRegistry(fakeRegistry()).getProviders(), []);
	});

	test("unsupported capabilities throw a descriptive error", () => {
		const models = modelsFromRegistry(fakeRegistry()) as unknown as {
			login(): unknown;
			fetchDeferred(): unknown;
			classify(): unknown;
		};
		assert.throws(() => models.login(), /minidev: login is not supported through the host model registry/);
		assert.throws(() => models.fetchDeferred(), /minidev: deferred responses is not supported/);
		assert.throws(() => models.classify(), /minidev: classification is not supported/);
	});
});
