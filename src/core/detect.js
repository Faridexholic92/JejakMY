/**
 * Auto-detect kurier daripada corak nombor tracking.
 * Ini ciri yang membuatkan pengguna rasa aplikasi ini pintar: tampal nombor,
 * terus tahu kurier. Kita pulangkan senarai calon dengan keyakinan, bukan satu
 * tekaan buta - enjin akan cuba calon satu per satu bila corak berkongsi bentuk.
 */
export const COURIERS = [
	{ slug: "poslaju", name: "Pos Laju" },
	{ slug: "jt", name: "J&T Express" },
	{ slug: "ninjavan", name: "Ninja Van" },
	{ slug: "spx", name: "SPX Express" },
	{ slug: "dhl-ecommerce", name: "DHL eCommerce" },
	{ slug: "flash", name: "Flash Express" },
	{ slug: "citylink", name: "City-Link Express" },
	{ slug: "gdex", name: "GDex" },
	{ slug: "best", name: "Best Express" },
	{ slug: "skynet", name: "Skynet" },
	{ slug: "lineclear", name: "Line Clear Express" },
	{ slug: "ondemand", name: "Lalamove / Grab" },
]

export const COURIER_BY_SLUG = new Map(COURIERS.map(c => [c.slug, c]))

// Corak + keyakinan asas. Nombor 12 digit sengaja diberi keyakinan rendah
// kerana beberapa kurier berkongsi bentuk yang sama.
const PATTERNS = [
	{ slug: "poslaju", pattern: /^[A-Z]{2}\d{9}MY$/, confidence: 0.6, reason: "Format S10 antarabangsa (akhiran MY)" },
	{ slug: "jt", pattern: /^6\d{11}$/, confidence: 0.6, reason: "12 digit bermula dengan 6" },
	{ slug: "spx", pattern: /^SPX(MY)?[A-Z0-9]{8,}$/, confidence: 0.9, reason: "Awalan SPX" },
	{ slug: "ninjavan", pattern: /^(NV|NLMY)[A-Z0-9]{6,}$/, confidence: 0.85, reason: "Awalan Ninja Van" },
	{ slug: "dhl-ecommerce", pattern: /^(JD|JJD)\d{9,18}$/, confidence: 0.85, reason: "Awalan JD/JJD DHL eCommerce" },
	{ slug: "flash", pattern: /^[A-Z]{2}\d{10,12}$/, confidence: 0.4, reason: "Dua huruf diikuti 10-12 digit" },
	{ slug: "citylink", pattern: /^\d{12}$/, confidence: 0.3, reason: "12 digit tanpa awalan" },
	{ slug: "gdex", pattern: /^\d{12}$/, confidence: 0.28, reason: "12 digit tanpa awalan" },
]

/** Buang ruang, sengkang dan huruf kecil. */
export function normaliseTrackingNo(input) {
	return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/**
 * Digit semak S10 (UPU) - dipakai Pos Laju dan pos kebangsaan lain.
 * Ini menaikkan keyakinan dari tekaan corak kepada pengesahan matematik.
 */
export function s10ChecksumValid(trackingNo) {
	const match = /^[A-Z]{2}(\d{8})(\d)[A-Z]{2}$/.exec(normaliseTrackingNo(trackingNo))
	if (!match) return false
	const [, digits, checkDigit] = match
	const weights = [8, 6, 4, 2, 3, 5, 9, 7]
	const sum = digits.split("").reduce((total, digit, i) => total + Number(digit) * weights[i], 0)
	let check = 11 - (sum % 11)
	if (check === 10) check = 0
	if (check === 11) check = 5
	return check === Number(checkDigit)
}

/**
 * @returns {Array<{slug: string, name: string, confidence: number, reason: string}>}
 * disusun dari paling yakin ke paling kurang.
 */
export function detectCourier(input) {
	const trackingNo = normaliseTrackingNo(input)
	if (trackingNo.length < 6) return []

	const candidates = []
	for (const { slug, pattern, confidence, reason } of PATTERNS) {
		if (!pattern.test(trackingNo)) continue

		if (slug === "poslaju") {
			const valid = s10ChecksumValid(trackingNo)
			candidates.push({
				slug,
				name: COURIER_BY_SLUG.get(slug).name,
				confidence: valid ? 0.97 : 0.35,
				reason: valid ? "Format S10 dengan digit semak sah" : "Format S10 tetapi digit semak tidak sah",
			})
			continue
		}

		candidates.push({ slug, name: COURIER_BY_SLUG.get(slug).name, confidence, reason })
	}

	return candidates.sort((a, b) => b.confidence - a.confidence)
}

/** Dua calon teratas terlalu rapat: enjin patut probe kedua-duanya. */
export function isAmbiguous(candidates) {
	if (candidates.length < 2) return false
	return candidates[0].confidence - candidates[1].confidence < 0.15
}
