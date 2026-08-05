import process from "node:process"

/**
 * Isi enjin dengan tiga parcel demo supaya UI ada sesuatu untuk ditunjuk.
 * Ia bercakap dengan API sebenar, jadi ia juga berfungsi sebagai smoke test.
 */

const host = process.env.HOST ?? "127.0.0.1"
const port = process.env.PORT ?? "4000"
const base = process.env.BASE_URL ?? `http://${host}:${port}`

const PARCELS = [
	{ trackingNo: "630123456789", nickname: "Kasut Raya" },
	{ trackingNo: "ER123456785MY", nickname: "Dokumen bank" },
	{ trackingNo: "SPXMY041234567", nickname: "Casing telefon" },
]

const results = []
for (const parcel of PARCELS) {
	const res = await fetch(`${base}/api/parcels`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(parcel),
	})
	const body = await res.json()
	results.push({
		trackingNo: parcel.trackingNo,
		http: res.status,
		courier: body.parcel?.courier?.name ?? "-",
		status: body.parcel?.status ?? body.error,
		events: body.parcel?.events?.length ?? 0,
	})
}

console.table(results)
