/**
 * Shared, lazily-resolved model list.
 *
 * Both the synchronous `opencode` tool and the background-delegation tools need
 * the same answer to "is this model id real?", and listing models spawns a
 * process, so the answer is cached for the life of the runtime. `session_start`
 * clears it so an OpenCode upgrade is picked up without restarting Pi.
 *
 * This is every id the CLI reports, free and paid alike. The default model is
 * free, but nothing here forbids a paid one - the caller decides what to spend.
 */

import { findOpencodeCli, listModels } from "./cli.ts";

let cache: Promise<string[]> | null = null;

export function resetModels(): void {
	cache = null;
}

/** Every model id the CLI reports, or an empty list when it cannot be asked. */
export function getModels(): Promise<string[]> {
	if (!cache) {
		const cli = findOpencodeCli();
		cache = cli
			? listModels(cli).catch(() => [])
			: Promise.resolve([]);
	}
	return cache;
}
