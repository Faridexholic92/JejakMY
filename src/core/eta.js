import { isTerminal } from "./statuses.js"

const DAY_MS = 86_400_000

// Anggaran lalai bila kita belum ada data sejarah untuk kurier berkenaan.
const DEFAULT_DAYS = {
	PENDING: [2, 5],
	INFO_RECEIVED: [2, 4],
	IN_TRANSIT: [1, 3],
	FAILED_ATTEMPT: [1, 2],
	EXCEPTION: [2, 5],
}

const firstEventTime = events => {
	const times = events.map(e => Date.parse(e.happenedAt)).filter(Number.isFinite)
	return times.length ? Math.min(...times) : null
}

/**
 * Anggaran masa sampai. Kita lebih rela beri julat jujur daripada satu tarikh
 * yang nampak tepat tetapi salah.
 */
export function estimateEta({ status, events = [], courierMedianDays = null, now = Date.now() }) {
	if (isTerminal(status)) return null

	// Sudah bersama rider: hampir pasti hari ini.
	if (status === "OUT_FOR_DELIVERY") {
		const start = now + 60 * 60 * 1000
		const endOfDay = new Date(now)
		endOfDay.setHours(21, 0, 0, 0)
		const end = Math.max(endOfDay.getTime(), start + 60 * 60 * 1000)
		return {
			start: new Date(start).toISOString(),
			end: new Date(end).toISOString(),
			confidence: "high",
			basis: "Parcel sudah bersama rider hari ini",
		}
	}

	// Ada sejarah sebenar kurier ini: guna purata masa transitnya.
	if (status === "IN_TRANSIT" && courierMedianDays) {
		const first = firstEventTime(events) ?? now
		const middle = first + courierMedianDays * DAY_MS
		return {
			start: new Date(Math.max(middle - DAY_MS / 2, now)).toISOString(),
			end: new Date(Math.max(middle + DAY_MS / 2, now + DAY_MS / 2)).toISOString(),
			confidence: "medium",
			basis: `Purata ${courierMedianDays.toFixed(1)} hari untuk kurier ini`,
		}
	}

	const [minDays, maxDays] = DEFAULT_DAYS[status] ?? [2, 5]
	return {
		start: new Date(now + minDays * DAY_MS).toISOString(),
		end: new Date(now + maxDays * DAY_MS).toISOString(),
		confidence: "low",
		basis: "Anggaran umum mengikut status semasa",
	}
}
