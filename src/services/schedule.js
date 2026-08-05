import { isTerminal } from "../core/statuses.js"

/**
 * Jadual poll adaptif (minit). Ini yang menentukan kos infrastruktur kau:
 * poll semua parcel setiap 5 minit adalah cara paling cepat bakar duit.
 */
export const BASE_MINUTES = {
	PENDING: 360,
	INFO_RECEIVED: 180,
	IN_TRANSIT: 120,
	OUT_FOR_DELIVERY: 15,
	FAILED_ATTEMPT: 60,
	EXCEPTION: 120,
}

const MAX_MINUTES = 720 // 12 jam
const DORMANT_AFTER_EMPTY = 12 // ~3 hari tiada apa-apa untuk parcel PENDING

/**
 * @param {object} args
 * @param {string} args.status status kanonik selepas ingest
 * @param {number} [args.consecutiveEmpty] bilangan poll berturut tanpa event baharu
 * @param {number} [args.attempts] bilangan kegagalan berturut
 * @param {boolean} [args.errored] adakah poll terakhir gagal
 * @param {number} [args.maxAttempts]
 * @param {number} [args.capMinutes] had atas selang, untuk demo atau SLA
 * @returns {{pollState: "active"|"done"|"dormant", delayMinutes: number|null}}
 */
export function planNextPoll({
	status,
	consecutiveEmpty = 0,
	attempts = 0,
	errored = false,
	maxAttempts = 8,
	capMinutes = MAX_MINUTES,
}) {
	// Had atas boleh diketatkan oleh pemanggil, tetapi tidak pernah melebihi
	// had global 12 jam.
	const cap = Math.min(capMinutes ?? MAX_MINUTES, MAX_MINUTES)

	// 1. Parcel tamat: berhenti terus. Tiada sebab poll parcel yang sudah sampai.
	if (isTerminal(status)) return { pollState: "done", delayMinutes: null }

	// 2. Gagal berulang kali: rehatkan, jangan hentam API kurier.
	if (errored) {
		if (attempts >= maxAttempts) return { pollState: "dormant", delayMinutes: null }
		const backoff = Math.min(15 * 2 ** attempts, cap)
		return { pollState: "active", delayMinutes: backoff }
	}

	// 3. Parcel yang tidak pernah bergerak: lama-lama jadi dormant.
	if (status === "PENDING" && consecutiveEmpty >= DORMANT_AFTER_EMPTY) {
		return { pollState: "dormant", delayMinutes: null }
	}

	// 4. Kadar biasa, dilonggarkan bila parcel senyap beberapa pusingan.
	const base = BASE_MINUTES[status] ?? 180
	const slack = Math.min(2 ** Math.floor(consecutiveEmpty / 3), 6)
	return { pollState: "active", delayMinutes: Math.min(base * slack, cap) }
}

export function isoAfterMinutes(minutes, from = Date.now()) {
	if (minutes === null || minutes === undefined) return null
	return new Date(from + minutes * 60_000).toISOString()
}
