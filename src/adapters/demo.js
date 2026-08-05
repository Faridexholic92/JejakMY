import { config } from "../config.js"
import { fetchJson } from "../lib/http.js"
import { normaliseStatus, toIso } from "../core/normalise.js"

/**
 * Adapter demo. Ia bercakap dengan tools/fake-courier.js, sebuah server yang
 * meniru TIGA bentuk respons berbeza (Pos Laju, J&T, SPX) supaya lapisan
 * penormalan diuji betul-betul, bukan sekadar satu format ideal.
 *
 * Bila kau dapat kunci API sebenar, adapter lain akan didahulukan dan fail ini
 * boleh kekal untuk ujian tempatan dan demo tanpa internet.
 */

function parsePoslaju(json) {
	// Bentuk: { item: { trackingNo, events: [{ dateTime, process, location }] } }
	const events = json?.item?.events ?? []
	return events.map(e => ({
		rawStatus: e.process,
		description: e.process,
		location: e.location,
		happenedAt: toIso(e.dateTime),
		status: normaliseStatus(e.process, e.process),
	}))
}

function parseJt(json) {
	// Bentuk: { code: 1, data: { details: [{ scanTime, scanType, desc, city }] } }
	const details = json?.data?.details ?? []
	return details.map(d => ({
		rawStatus: d.scanType,
		description: d.desc,
		location: d.city,
		happenedAt: toIso(d.scanTime),
		status: normaliseStatus(d.scanType, d.desc),
	}))
}

function parseSpx(json) {
	// Bentuk: { tracking_number, tracking_list: [{ timestamp, status_code, description, location }] }
	const list = json?.tracking_list ?? []
	return list.map(t => ({
		rawStatus: t.status_code,
		description: t.description,
		location: t.location,
		// SPX guna epoch saat
		happenedAt: toIso(typeof t.timestamp === "number" ? t.timestamp * 1000 : t.timestamp),
		status: normaliseStatus(t.status_code, t.description),
	}))
}

const PARSERS = {
	poslaju: parsePoslaju,
	jt: parseJt,
	spx: parseSpx,
}

export const demoAdapter = {
	name: "demo",
	kind: "demo",
	get enabled() {
		return config.demo.enabled
	},
	supports(slug) {
		return Boolean(PARSERS[slug]) || true // fallback ke bentuk generik
	},
	async fetchTracking({ trackingNo, courierSlug }) {
		const url = `${config.demo.baseUrl}/api/${courierSlug}/track/${encodeURIComponent(trackingNo)}`
		const { status, ok, json, text } = await fetchJson(url, {
			headers: { "x-demo-key": "demo" },
		})
		if (!ok) {
			return { ok: false, httpStatus: status, error: `kurier balas ${status}`, events: [], raw: text }
		}
		const parser = PARSERS[courierSlug]
		const events = parser
			? parser(json)
			: (json?.events ?? []).map(e => ({
					rawStatus: e.status,
					description: e.description,
					location: e.location,
					happenedAt: toIso(e.happenedAt),
					status: normaliseStatus(e.status, e.description),
				}))
		return {
			ok: true,
			httpStatus: status,
			events: events.filter(e => e.happenedAt),
			raw: text,
		}
	},
}

export default demoAdapter
