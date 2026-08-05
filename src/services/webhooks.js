import { createHmac, timingSafeEqual } from "node:crypto"
import { config } from "../config.js"
import { normaliseStatus, toIso } from "../core/normalise.js"
import { normaliseTrackingNo } from "../core/detect.js"
import { TrackingError } from "./ingest.js"

/**
 * Webhook masuk. Push lebih murah dan lebih pantas daripada poll, jadi setiap
 * kurier yang menyokongnya patut dipindahkan ke sini.
 *
 * Dua peraturan keselamatan yang tidak boleh dikompromi:
 *   1. Sahkan tandatangan HMAC sebelum memproses apa-apa.
 *   2. Jangan percaya status dalam payload - normalisasi tetap dijalankan.
 */

export function signPayload(rawBody, secret = config.webhook.secret) {
	return createHmac("sha256", secret).update(rawBody).digest("hex")
}

export function verifySignature(rawBody, signature, secret = config.webhook.secret) {
	if (!signature) return false
	const expected = signPayload(rawBody, secret)
	const a = Buffer.from(expected, "utf8")
	const b = Buffer.from(String(signature), "utf8")
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}

/**
 * Petakan payload webhook pelbagai kurier kepada bentuk sama.
 * Setiap kurier ada bentuk sendiri; tambah kes baharu di sini sahaja.
 */
export function parseWebhookPayload(courierSlug, payload) {
	if (courierSlug === "ninjavan") {
		return {
			trackingNo: normaliseTrackingNo(payload.tracking_id ?? payload.tracking_number),
			events: [
				{
					rawStatus: payload.status,
					description: payload.comments ?? payload.status,
					location: payload.hub_name ?? "",
					happenedAt: toIso(payload.timestamp),
					status: normaliseStatus(payload.status, payload.comments ?? ""),
				},
			],
		}
	}

	// Bentuk generik: { trackingNo, events: [...] }
	const events = Array.isArray(payload.events) ? payload.events : [payload]
	return {
		trackingNo: normaliseTrackingNo(payload.trackingNo ?? payload.tracking_number),
		events: events
			.map(e => ({
				rawStatus: e.status ?? e.rawStatus ?? "",
				description: e.description ?? e.desc ?? "",
				location: e.location ?? "",
				happenedAt: toIso(e.happenedAt ?? e.timestamp ?? e.date),
				status: normaliseStatus(e.status ?? "", e.description ?? ""),
			}))
			.filter(e => e.happenedAt),
	}
}

export function createWebhookHandler({ store, engine }) {
	return async function handleWebhook({ courierSlug, rawBody, signature }) {
		if (config.webhook.requireSignature && !verifySignature(rawBody, signature)) {
			throw new TrackingError("Tandatangan webhook tidak sah", "BAD_SIGNATURE", 401)
		}

		let payload
		try {
			payload = JSON.parse(rawBody)
		} catch {
			throw new TrackingError("Payload bukan JSON sah", "BAD_PAYLOAD", 400)
		}

		const { trackingNo, events } = parseWebhookPayload(courierSlug, payload)
		if (!trackingNo) throw new TrackingError("Payload tiada nombor tracking", "BAD_PAYLOAD", 400)

		const parcel = store.getByTracking(trackingNo, courierSlug)
		if (!parcel) {
			// Kurier hantar push untuk parcel yang kita tidak jejak. Rekod sahaja.
			store.recordRaw({
				courierSlug,
				adapter: "webhook",
				ok: true,
				body: rawBody,
			})
			return { accepted: false, reason: "parcel tidak dijejak", trackingNo }
		}

		store.recordRaw({
			parcelId: parcel.id,
			courierSlug,
			adapter: "webhook",
			ok: true,
			body: rawBody,
		})

		const result = await engine.ingest({
			parcel,
			rawEvents: events,
			source: "webhook",
			adapter: "webhook",
		})

		return {
			accepted: true,
			trackingNo,
			inserted: result.inserted,
			status: result.status,
			statusChanged: result.statusChanged,
		}
	}
}
