import { createHash } from "node:crypto"
import { STATUSES, canTransition } from "./statuses.js"

/**
 * Peraturan pemetaan status. Susunan penting: yang paling spesifik dahulu.
 * Contoh: "Maklumat penghantaran diterima" mesti jadi INFO_RECEIVED, bukan
 * DELIVERED, walaupun kedua-duanya mengandungi perkataan "diterima".
 */
const RULES = [
	["DELIVERED", /deliver(ed|y success(ful)?)|signed (for|by)|received by (recipient|customer)|picked up by (customer|recipient)|diterima oleh|parcel diterima|berjaya dihantar|telah dihantar/i],
	["RETURNED", /return(ed|ing)?( to (sender|shipper))?|rts\b|dipulangkan|pulang ke penghantar/i],
	["FAILED_ATTEMPT", /failed (delivery )?attempt|delivery (attempt )?fail|unsuccessful|not at home|no one (at home|available)|recipient (not available|unavailable|absent)|gagal (hantar|dihantar|penghantaran)|cubaan.*gagal|penerima tiada|tiada di alamat/i],
	["EXCEPTION", /exception|customs|kastam|held|hold|detained|damaged|lost|rosak|hilang|ditahan|masalah|address issue|alamat tidak lengkap/i],
	["OUT_FOR_DELIVERY", /out for delivery|with (rider|courier|driver)|on vehicle|bersama rider|dalam penghantaran|keluar untuk penghantaran|sedang dihantar/i],
	["IN_TRANSIT", /in ?transit|departed|arrived|linehaul|hub|sorting|received at|picked ?up|collected|diambil|dalam perjalanan|tiba di|bertolak|hab/i],
	["INFO_RECEIVED", /info(rmation)? received|shipment created|order created|label created|manifest|awaiting (pickup|collection)|maklumat.*diterima|pesanan dibuat|menunggu (kutipan|pungutan)/i],
	["EXPIRED", /expired|no (further )?update|tiada kemas kini|tamat tempoh/i],
]

/** Petakan teks kurier (status mentah + keterangan) ke status kanonik. */
export function normaliseStatus(rawStatus = "", description = "") {
	const haystack = `${rawStatus ?? ""} ${description ?? ""}`.trim()
	if (!haystack) return "PENDING"
	for (const [status, pattern] of RULES) {
		if (pattern.test(haystack)) return status
	}
	return "PENDING"
}

/** Terima epoch (saat atau milisaat), ISO, atau "YYYY-MM-DD HH:mm:ss". */
export function toIso(value) {
	if (value === null || value === undefined || value === "") return null
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
	const text = String(value).trim()
	if (/^\d+$/.test(text)) {
		const n = Number(text)
		const date = new Date(n > 1e11 ? n : n * 1000)
		return Number.isNaN(date.getTime()) ? null : date.toISOString()
	}
	const date = new Date(text.replace(" ", "T"))
	return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const squash = value => String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim()

/**
 * Cap jari event. Kurier kerap menghantar semula event lama dengan ejaan atau
 * ruang berbeza, jadi kita bandingkan bentuk yang sudah dimampatkan.
 */
export function fingerprint({ parcelId, happenedAt, status, description, location }) {
	return createHash("sha1")
		.update([parcelId, happenedAt, status, squash(description), squash(location)].join("|"))
		.digest("hex")
}

/** Tukar event mentah adapter kepada bentuk kanonik yang boleh disimpan. */
export function normaliseEvent(raw, parcelId) {
	const rawStatus = raw.rawStatus ?? raw.raw_status ?? raw.status ?? ""
	const description = raw.description ?? raw.desc ?? ""
	const location = raw.location ?? raw.city ?? ""
	const happenedAt =
		toIso(raw.happenedAt ?? raw.happened_at ?? raw.time ?? raw.timestamp ?? raw.at) ??
		new Date().toISOString()
	const status = STATUSES.includes(raw.status) ? raw.status : normaliseStatus(rawStatus, description)

	return {
		parcelId,
		status,
		rawStatus: String(rawStatus),
		description: String(description),
		location: String(location),
		happenedAt,
		fingerprint: fingerprint({ parcelId, happenedAt, status, description, location }),
	}
}

const byTime = (a, b) => Date.parse(a.happenedAt) - Date.parse(b.happenedAt)

/** Event terkini mengikut masa berlaku (bukan masa kita menerimanya). */
export function latestEvent(events = []) {
	if (!events.length) return null
	return [...events].sort(byTime).at(-1)
}

/**
 * Kira status semasa daripada keseluruhan sejarah event.
 * Kita main semula event ikut turutan masa dan hormati peraturan peralihan,
 * jadi event lama yang tiba lewat tidak boleh memundurkan parcel yang sudah sampai.
 */
export function deriveStatus(events = [], current = null) {
	let status = current
	for (const event of [...events].sort(byTime)) {
		if (!event.status) continue
		if (!status || canTransition(status, event.status)) status = event.status
	}
	return status ?? (events.length ? "PENDING" : current)
}
