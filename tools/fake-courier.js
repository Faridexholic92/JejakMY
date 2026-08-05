import http from "node:http"
import process from "node:process"

/**
 * Server kurier tiruan untuk pembangunan dan ujian.
 *
 * Kenapa ini wujud: kurier Malaysia tidak beri sandbox awam, dan kita tidak
 * mahu enjin diuji terhadap satu bentuk JSON yang sempurna. Server ini
 * meniru TIGA bentuk respons berbeza dan parcel yang benar-benar bergerak
 * mengikut masa, supaya poller, dedup dan notifikasi diuji dengan jujur.
 *
 * Setiap parcel ada garis masa relatif kepada masa ia mula-mula diminta,
 * dipercepatkan supaya satu "hari" berlalu dalam beberapa saat.
 */

const PORT = Number(process.env.FAKE_COURIER_PORT ?? 4010)
// Berapa milisaat mewakili satu langkah perjalanan.
const STEP_MS = Number(process.env.FAKE_COURIER_STEP_MS ?? 4000)

const SCRIPTS = {
	// Perjalanan normal sehingga selesai
	normal: [
		{ status: "Shipment created", desc: "Maklumat penghantaran diterima", loc: "Shah Alam, SGR" },
		{ status: "Picked up", desc: "Parcel diambil dari penghantar", loc: "Shah Alam, SGR" },
		{ status: "In transit", desc: "Tiba di hub penyusunan", loc: "Hub Subang, SGR" },
		{ status: "In transit", desc: "Bertolak ke hub destinasi", loc: "Hub Subang, SGR" },
		{ status: "In transit", desc: "Tiba di hub destinasi", loc: "Hub Ipoh, PRK" },
		{ status: "Out for delivery", desc: "Parcel bersama rider", loc: "Ipoh, PRK" },
		{ status: "Delivered", desc: "Diterima oleh penerima", loc: "Ipoh, PRK" },
	],
	// Cubaan hantar gagal, kemudian berjaya
	failed: [
		{ status: "Shipment created", desc: "Maklumat penghantaran diterima", loc: "Johor Bahru, JHR" },
		{ status: "In transit", desc: "Dalam perjalanan ke destinasi", loc: "Hub Senai, JHR" },
		{ status: "Out for delivery", desc: "Parcel bersama rider", loc: "Kuantan, PHG" },
		{ status: "Failed delivery attempt", desc: "Penerima tiada di alamat", loc: "Kuantan, PHG" },
		{ status: "Out for delivery", desc: "Cubaan kedua, parcel bersama rider", loc: "Kuantan, PHG" },
		{ status: "Delivered", desc: "Diterima oleh penerima", loc: "Kuantan, PHG" },
	],
	// Tersangkut di kastam
	stuck: [
		{ status: "Info received", desc: "Maklumat penghantaran diterima", loc: "Singapore" },
		{ status: "In transit", desc: "Bertolak ke Malaysia", loc: "Singapore" },
		{ status: "Customs hold", desc: "Ditahan untuk pemeriksaan kastam", loc: "KLIA, SGR" },
	],
}

/** Peta nombor tracking -> skrip. Nombor lain diberi skrip normal. */
const ASSIGNED = new Map([
	["630123456789", "normal"],
	["ER123456785MY", "failed"],
	["SPXMY041234567", "stuck"],
])

/** Masa mula setiap parcel (kali pertama ia diminta). */
const firstSeen = new Map()

function eventsFor(trackingNo) {
	if (!firstSeen.has(trackingNo)) firstSeen.set(trackingNo, Date.now())
	const start = firstSeen.get(trackingNo)
	const script = SCRIPTS[ASSIGNED.get(trackingNo) ?? "normal"]
	const steps = Math.min(script.length, Math.floor((Date.now() - start) / STEP_MS) + 1)
	return script.slice(0, steps).map((step, index) => ({
		...step,
		at: new Date(start + index * STEP_MS).toISOString(),
	}))
}

/** Setiap kurier balas dengan bentuk JSON sendiri. Ini sengaja. */
const SHAPES = {
	poslaju: (trackingNo, events) => ({
		item: {
			trackingNo,
			events: events.map(e => ({ dateTime: e.at, process: `${e.status} - ${e.desc}`, location: e.loc })),
		},
	}),
	jt: (trackingNo, events) => ({
		code: 1,
		msg: "success",
		data: {
			billCode: trackingNo,
			details: events.map(e => ({ scanTime: e.at, scanType: e.status, desc: e.desc, city: e.loc })),
		},
	}),
	spx: (trackingNo, events) => ({
		tracking_number: trackingNo,
		tracking_list: events.map(e => ({
			timestamp: Math.floor(new Date(e.at).getTime() / 1000),
			status_code: e.status,
			description: e.desc,
			location: e.loc,
		})),
	}),
	default: (trackingNo, events) => ({
		trackingNo,
		events: events.map(e => ({
			status: e.status,
			description: e.desc,
			location: e.loc,
			happenedAt: e.at,
		})),
	}),
}

const server = http.createServer((req, res) => {
	const match = /^\/api\/([\w-]+)\/track\/([\w-]+)/.exec(req.url ?? "")
	if (!match) {
		res.writeHead(404, { "content-type": "application/json" })
		return res.end(JSON.stringify({ error: "not found" }))
	}

	const [, courier, trackingNo] = match

	// Kurier sebenar menolak permintaan tanpa kunci; tiru kelakuan itu.
	if (!req.headers["x-demo-key"]) {
		res.writeHead(401, { "content-type": "application/json" })
		return res.end(JSON.stringify({ error: "missing api key" }))
	}

	// Nombor yang memang tidak wujud
	if (trackingNo.startsWith("NOTFOUND")) {
		res.writeHead(404, { "content-type": "application/json" })
		return res.end(JSON.stringify({ error: "tracking number not found" }))
	}

	const shape = SHAPES[courier] ?? SHAPES.default
	const body = JSON.stringify(shape(trackingNo, eventsFor(trackingNo)))
	res.writeHead(200, { "content-type": "application/json" })
	res.end(body)
})

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
	server.listen(PORT, "127.0.0.1", () => {
		console.log(`[fake-courier] port ${PORT}, satu langkah = ${STEP_MS}ms`)
		console.log("[fake-courier] nombor demo: 630123456789 (normal), ER123456785MY (gagal hantar), SPXMY041234567 (tersangkut)")
	})
}

export { server, eventsFor, SCRIPTS }
