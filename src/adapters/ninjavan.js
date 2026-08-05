import { config } from "../config.js"
import { fetchJson } from "../lib/http.js"
import { normaliseStatus, toIso } from "../core/normalise.js"

/**
 * Adapter Ninja Van (API rasmi, OAuth2 client credentials).
 *
 * PENTING: laluan endpoint di bawah mesti disahkan dengan api-docs.ninjavan.co
 * untuk akaun kau sendiri sebelum guna di produksi. Ia boleh ditetapkan melalui
 * env NINJAVAN_TRACK_PATH tanpa mengubah kod.
 *
 * Token di-cache dalam memori sehingga 60 saat sebelum tamat tempoh.
 */

let tokenCache = { token: null, expiresAt: 0 }

export function _resetTokenCache() {
	tokenCache = { token: null, expiresAt: 0 }
}

export async function getAccessToken() {
	const now = Date.now()
	if (tokenCache.token && tokenCache.expiresAt - 60_000 > now) return tokenCache.token

	const url = `${config.ninjaVan.baseUrl}/${config.ninjaVan.countryCode}/2.0/oauth/access_token`
	const { ok, json, status } = await fetchJson(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_id: config.ninjaVan.clientId,
			client_secret: config.ninjaVan.clientSecret,
			grant_type: "client_credentials",
		}),
	})
	if (!ok || !json?.access_token) {
		throw new Error(`Ninja Van OAuth gagal (HTTP ${status})`)
	}
	tokenCache = {
		token: json.access_token,
		expiresAt: now + (Number(json.expires_in ?? 3600) * 1000),
	}
	return tokenCache.token
}

/** Petakan event Ninja Van -> event kanonik. */
export function parseNinjaVanPayload(json) {
	const events = json?.events ?? json?.data?.events ?? []
	return events
		.map(e => ({
			rawStatus: e.status ?? e.shipper_ref_status ?? "",
			description: e.comments ?? e.description ?? e.status ?? "",
			location: e.hub_name ?? e.location ?? "",
			happenedAt: toIso(e.timestamp ?? e.created_at),
			status: normaliseStatus(e.status ?? "", e.comments ?? ""),
		}))
		.filter(e => e.happenedAt)
}

export const ninjaVanAdapter = {
	name: "ninjavan",
	kind: "official",
	get enabled() {
		return config.ninjaVan.enabled
	},
	supports(slug) {
		return slug === "ninjavan"
	},
	async fetchTracking({ trackingNo }) {
		const token = await getAccessToken()
		const path = (process.env.NINJAVAN_TRACK_PATH ??
			"/{country}/1.0/orders/{trackingNumber}/events")
			.replace("{country}", config.ninjaVan.countryCode)
			.replace("{trackingNumber}", encodeURIComponent(trackingNo))

		const { status, ok, json, text } = await fetchJson(`${config.ninjaVan.baseUrl}${path}`, {
			headers: { authorization: `Bearer ${token}` },
		})

		if (!ok) {
			return { ok: false, httpStatus: status, error: `Ninja Van balas ${status}`, events: [], raw: text }
		}
		return { ok: true, httpStatus: status, events: parseNinjaVanPayload(json), raw: text }
	},
}

export default ninjaVanAdapter
