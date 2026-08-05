import { config } from "../config.js"
import { fetchJson } from "../lib/http.js"
import { normaliseStatus, toIso } from "../core/normalise.js"

/**
 * Adapter agregator (TrackingMore v4; AfterShip sangat serupa).
 *
 * Kenapa agregator dulu: kebanyakan kurier Malaysia tiada API awam, jadi
 * fasa pertama kita beli liputan. Setiap respons mentah disimpan supaya bila
 * kita tukar ke API rasmi, sejarah parcel tidak hilang.
 *
 * Kod ini tidak dapat diuji terhadap API sebenar tanpa kunci; ia diuji
 * terhadap fixture bentuk respons TrackingMore dalam test/adapters.test.js.
 */

const COURIER_CODE = {
	poslaju: "malaysia-post",
	jt: "jtexpress-my",
	spx: "spx-my",
	ninjavan: "ninjavan-my",
	"dhl-ecommerce": "dhl-ecommerce-asia",
	flash: "flash-express-my",
	citylink: "city-link-express",
	gdex: "gdex",
}

/** Petakan respons TrackingMore -> event kanonik. */
export function parseAggregatorPayload(json) {
	const records = json?.data ?? []
	const first = Array.isArray(records) ? records[0] : records
	const checkpoints = first?.origin_info?.trackinfo ?? first?.trackinfo ?? []
	return checkpoints
		.map(cp => ({
			rawStatus: cp.checkpoint_delivery_status ?? cp.checkpoint_status ?? "",
			description: cp.tracking_detail ?? cp.description ?? "",
			location: cp.location ?? cp.checkpoint_delivery_substatus ?? "",
			happenedAt: toIso(cp.checkpoint_date ?? cp.date),
			status: normaliseStatus(
				cp.checkpoint_delivery_status ?? "",
				cp.tracking_detail ?? cp.description ?? "",
			),
		}))
		.filter(e => e.happenedAt)
}

export const aggregatorAdapter = {
	name: "aggregator",
	kind: "aggregator",
	get enabled() {
		return config.aggregator.enabled
	},
	supports(slug) {
		return Boolean(COURIER_CODE[slug])
	},
	async fetchTracking({ trackingNo, courierSlug }) {
		const courierCode = COURIER_CODE[courierSlug]
		const url = `${config.aggregator.baseUrl}/v4/trackings/get?tracking_numbers=${encodeURIComponent(
			trackingNo,
		)}&courier_code=${encodeURIComponent(courierCode)}`

		const { status, ok, json, text } = await fetchJson(url, {
			headers: { [config.aggregator.apiKeyHeader]: config.aggregator.apiKey },
		})

		if (!ok) {
			return {
				ok: false,
				httpStatus: status,
				error: `agregator balas ${status}`,
				events: [],
				raw: text,
			}
		}
		return { ok: true, httpStatus: status, events: parseAggregatorPayload(json), raw: text }
	},
}

export default aggregatorAdapter
