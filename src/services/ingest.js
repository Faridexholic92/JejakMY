import { EventEmitter } from "node:events"
import { COURIER_BY_SLUG, detectCourier, normaliseTrackingNo } from "../core/detect.js"
import { deriveStatus, latestEvent, normaliseEvent } from "../core/normalise.js"
import { estimateEta } from "../core/eta.js"
import { fetchTracking as defaultFetchTracking } from "../adapters/index.js"
import { planNextPoll, isoAfterMinutes } from "./schedule.js"
import { config } from "../config.js"

export class TrackingError extends Error {
	constructor(message, code = "TRACKING_ERROR", status = 400) {
		super(message)
		this.code = code
		this.statusCode = status
	}
}

/**
 * Enjin ingest: satu-satunya tempat yang menulis status parcel.
 * Poller, webhook dan permintaan manual semuanya melalui sini, jadi peraturan
 * dedup, peralihan status dan notifikasi tidak pernah berbeza ikut sumber.
 */
export function createEngine({ store, fetchTracking = defaultFetchTracking, notifier, log = () => {} }) {
	const bus = new EventEmitter()
	bus.setMaxListeners(0)

	/** Simpan event baharu, kira status, jadualkan poll seterusnya, beritahu. */
	async function ingest({ parcel, rawEvents, source = "poll", adapter = null, error = null }) {
		const previousStatus = parcel.status
		const canonical = rawEvents.map(e => normaliseEvent(e, parcel.id))

		let inserted = 0
		for (const event of canonical) {
			if (store.insertEvent(event, source)) inserted += 1
		}

		const allEvents = store.listEvents(parcel.id).map(row => ({
			status: row.status,
			description: row.description,
			location: row.location,
			happenedAt: row.happened_at,
		}))

		const status = deriveStatus(allEvents, null) || previousStatus
		const last = latestEvent(allEvents)
		const eta = estimateEta({
			status,
			events: allEvents,
			courierMedianDays: store.medianTransitDays(parcel.courier_slug),
		})

		const errored = Boolean(error)
		const attempts = errored ? (parcel.poll_attempts ?? 0) + 1 : 0
		const consecutiveEmpty = inserted > 0 ? 0 : (parcel.consecutive_empty ?? 0) + 1
		const plan = planNextPoll({
			status,
			consecutiveEmpty,
			attempts,
			errored,
			maxAttempts: config.poller.maxAttempts,
			capMinutes: config.poller.maxIntervalMinutes,
		})

		const updated = store.updateAfterIngest(parcel.id, {
			status,
			lastDescription: last?.description ?? parcel.last_description,
			lastLocation: last?.location ?? parcel.last_location,
			lastEventAt: last?.happenedAt ?? parcel.last_event_at,
			eta,
			pollState: plan.pollState,
			nextPollAt: isoAfterMinutes(plan.delayMinutes),
			pollAttempts: attempts,
			consecutiveEmpty,
			lastError: error,
			adapter: adapter ?? parcel.adapter,
		})

		const statusChanged = status !== previousStatus
		if (statusChanged && notifier) {
			await notifier.dispatch({ parcel: updated, status, previousStatus })
		}
		if (inserted > 0 || statusChanged) {
			bus.emit("parcel:update", { parcel: updated, inserted, statusChanged, previousStatus })
		}

		return { parcel: updated, inserted, statusChanged, previousStatus, status }
	}

	/** Ambil data terkini dari kurier untuk satu parcel, kemudian ingest. */
	async function refresh(parcelId, { source = "poll" } = {}) {
		const parcel = store.getParcel(parcelId)
		if (!parcel) throw new TrackingError("Parcel tidak dijumpai", "NOT_FOUND", 404)

		const result = await fetchTracking({
			trackingNo: parcel.tracking_no,
			courierSlug: parcel.courier_slug,
		})

		store.recordRaw({
			parcelId: parcel.id,
			courierSlug: parcel.courier_slug,
			adapter: result.adapter ?? "none",
			httpStatus: result.httpStatus ?? null,
			ok: result.ok,
			body: result.raw ?? "",
		})

		return ingest({
			parcel,
			rawEvents: result.ok ? result.events : [],
			source,
			adapter: result.adapter,
			error: result.ok ? null : result.error,
		})
	}

	/**
	 * Tambah parcel baharu.
	 * Kalau kurier tidak diberi, kita detect. Kalau detect kabur, kita PROBE:
	 * cuba calon satu per satu sehingga ada yang pulangkan event sebenar.
	 */
	async function addParcel({ trackingNo: rawTrackingNo, courierSlug = null, nickname = null }) {
		const trackingNo = normaliseTrackingNo(rawTrackingNo)
		if (trackingNo.length < 6) {
			throw new TrackingError("Nombor tracking terlalu pendek", "INVALID_TRACKING_NO")
		}

		const candidates = courierSlug
			? [{ slug: courierSlug, name: COURIER_BY_SLUG.get(courierSlug)?.name ?? courierSlug, confidence: 1 }]
			: detectCourier(trackingNo)

		if (candidates.length === 0) {
			throw new TrackingError(
				"Tidak dapat kenal pasti kurier daripada nombor ini. Pilih kurier secara manual.",
				"COURIER_UNKNOWN",
			)
		}

		// Sudah dijejak? Pulangkan yang sedia ada, jangan buat pendua.
		for (const candidate of candidates) {
			const existing = store.getByTracking(trackingNo, candidate.slug)
			if (existing) return { parcel: existing, created: false, probe: null }
		}

		const attempts = []
		for (const candidate of candidates) {
			const result = await fetchTracking({ trackingNo, courierSlug: candidate.slug })
			attempts.push({
				courier: candidate.slug,
				ok: result.ok,
				events: result.events.length,
				error: result.error,
			})
			store.recordRaw({
				courierSlug: candidate.slug,
				adapter: result.adapter ?? "none",
				httpStatus: result.httpStatus ?? null,
				ok: result.ok,
				body: result.raw ?? "",
			})

			if (result.ok && result.events.length > 0) {
				const parcel = store.createParcel({
					trackingNo,
					courierSlug: candidate.slug,
					courierName: candidate.name,
					nickname,
					adapter: result.adapter,
				})
				const ingested = await ingest({
					parcel,
					rawEvents: result.events,
					source: "manual",
					adapter: result.adapter,
				})
				log(`[ingest] ${trackingNo} -> ${candidate.slug} (${ingested.inserted} event)`)
				return { parcel: ingested.parcel, created: true, probe: attempts }
			}
		}

		// Tiada kurier pulangkan event. Kita tetap simpan parcel dengan calon
		// terbaik supaya poller boleh cuba lagi nanti - parcel baharu memang
		// selalunya belum ada scan pertama.
		const best = candidates[0]
		const parcel = store.createParcel({
			trackingNo,
			courierSlug: best.slug,
			courierName: best.name,
			nickname,
		})
		const ingested = await ingest({
			parcel,
			rawEvents: [],
			source: "manual",
			error: "belum ada rekod di kurier",
		})
		return { parcel: ingested.parcel, created: true, probe: attempts }
	}

	return { bus, ingest, refresh, addParcel }
}
