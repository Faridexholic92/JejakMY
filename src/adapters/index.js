import { demoAdapter } from "./demo.js"
import { aggregatorAdapter } from "./aggregator.js"
import { ninjaVanAdapter } from "./ninjavan.js"

/**
 * Rantaian adapter mengikut keutamaan:
 *   1. API rasmi kurier (paling tepat, paling murah bila ada)
 *   2. Agregator berbayar (liputan luas, kos per jejakan)
 *   3. Demo tempatan (pembangunan dan ujian tanpa internet)
 *
 * Enjin cuba satu per satu sehingga ada yang pulangkan event.
 */
export const ADAPTERS = [ninjaVanAdapter, aggregatorAdapter, demoAdapter]

export function adapterChainFor(courierSlug) {
	return ADAPTERS.filter(a => a.enabled && a.supports(courierSlug))
}

export function adapterByName(name) {
	return ADAPTERS.find(a => a.name === name) ?? null
}

/**
 * Cuba setiap adapter sehingga satu berjaya.
 * @returns {Promise<{ok: boolean, adapter: string|null, events: Array, httpStatus: number|null, error: string|null, raw: string}>}
 */
export async function fetchTracking({ trackingNo, courierSlug }) {
	const chain = adapterChainFor(courierSlug)
	if (chain.length === 0) {
		return {
			ok: false,
			adapter: null,
			events: [],
			httpStatus: null,
			error: `tiada adapter aktif untuk ${courierSlug} - set kunci API atau hidupkan DEMO_MODE`,
			raw: "",
		}
	}

	let lastError = null
	for (const adapter of chain) {
		try {
			const result = await adapter.fetchTracking({ trackingNo, courierSlug })
			if (result.ok && result.events.length > 0) {
				return { ...result, adapter: adapter.name, error: null }
			}
			lastError = result.error ?? "tiada event dipulangkan"
			// Adapter menjawab tetapi kosong: simpan dan cuba adapter seterusnya.
			if (result.ok) {
				lastError = null
				return { ...result, adapter: adapter.name, error: null }
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error)
		}
	}

	return {
		ok: false,
		adapter: chain.at(-1)?.name ?? null,
		events: [],
		httpStatus: null,
		error: lastError ?? "semua adapter gagal",
		raw: "",
	}
}
