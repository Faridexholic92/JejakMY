/**
 * Perbendaharaan status kanonik. Setiap kurier ada istilah sendiri; semuanya
 * dipetakan ke sembilan status ini supaya UI, notifikasi dan ETA hanya perlu
 * memahami satu bahasa.
 */
export const STATUSES = [
	"PENDING",
	"INFO_RECEIVED",
	"IN_TRANSIT",
	"OUT_FOR_DELIVERY",
	"DELIVERED",
	"FAILED_ATTEMPT",
	"EXCEPTION",
	"RETURNED",
	"EXPIRED",
]

/** Kedudukan dalam perjalanan parcel. Digunakan untuk halang status berundur. */
export const RANK = {
	PENDING: 0,
	INFO_RECEIVED: 1,
	IN_TRANSIT: 2,
	OUT_FOR_DELIVERY: 3,
	FAILED_ATTEMPT: 3,
	EXCEPTION: 3,
	DELIVERED: 4,
	RETURNED: 4,
	EXPIRED: 4,
}

export const TERMINAL = new Set(["DELIVERED", "RETURNED", "EXPIRED"])

export const TONE = {
	PENDING: "neutral",
	INFO_RECEIVED: "neutral",
	IN_TRANSIT: "progress",
	OUT_FOR_DELIVERY: "progress",
	DELIVERED: "done",
	FAILED_ATTEMPT: "warn",
	EXCEPTION: "danger",
	RETURNED: "warn",
	EXPIRED: "neutral",
}

export const LABEL_MS = {
	PENDING: "Menunggu maklumat",
	INFO_RECEIVED: "Maklumat diterima",
	IN_TRANSIT: "Dalam perjalanan",
	OUT_FOR_DELIVERY: "Keluar untuk penghantaran",
	DELIVERED: "Sudah sampai",
	FAILED_ATTEMPT: "Cubaan hantar gagal",
	EXCEPTION: "Ada masalah",
	RETURNED: "Dipulangkan",
	EXPIRED: "Tiada kemas kini",
}

export const isTerminal = status => TERMINAL.has(status)

/**
 * Bolehkah status berubah dari `from` ke `to`?
 * Parcel yang sudah tamat tidak boleh berundur - kecuali barang yang sudah
 * sampai kemudian dipulangkan, yang memang berlaku.
 */
export function canTransition(from, to) {
	if (!from) return true
	if (from === to) return false
	if (isTerminal(from)) return from === "DELIVERED" && to === "RETURNED"
	return true
}
