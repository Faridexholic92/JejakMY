import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Ujian ini bukan mock: ia menghidupkan kurier tiruan sebenar (HTTP), server
// Jejak sebenar (HTTP), dan pangkalan data SQLite sebenar dalam folder sementara.
// Env mesti ditetapkan sebelum config.js dimuatkan kerana ia dibaca sekali sahaja.
process.env.DEMO_MODE = "1"
process.env.POLLER_ENABLED = "0"
process.env.WEBHOOK_SECRET = "ujian-rahsia"
process.env.WEBHOOK_REQUIRE_SIGNATURE = "1"
process.env.FAKE_COURIER_PORT = "0"
process.env.FAKE_COURIER_STEP_MS = "1200"

const { server: courierServer } = await import("../tools/fake-courier.js")
await new Promise(resolve => courierServer.listen(0, "127.0.0.1", resolve))
process.env.DEMO_COURIER_URL = `http://127.0.0.1:${courierServer.address().port}`

const { bootstrap } = await import("../src/server.js")
const { signPayload } = await import("../src/services/webhooks.js")

const tmpDir = mkdtempSync(join(tmpdir(), "jejak-ujian-"))
const { server, poller } = bootstrap({ dbPath: join(tmpDir, "ujian.db"), log: () => {} })
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}`

test.after(() => {
	poller.stop?.()
	server.close()
	courierServer.close()
	rmSync(tmpDir, { recursive: true, force: true })
})

async function api(path, init) {
	const res = await fetch(`${base}${path}`, init)
	const text = await res.text()
	let json = null
	try { json = JSON.parse(text) } catch { /* fail statik */ }
	return { status: res.status, json, text }
}

const TRACKING = "630123456789"
let parcelId = null

test("healthz melaporkan server dan poller hidup", async () => {
	const { status, json } = await api("/healthz")
	assert.equal(status, 200)
	assert.equal(json.ok, true)
	assert.equal(typeof json.poller.ticks, "number")
})

test("halaman UI dihidangkan dari server yang sama", async () => {
	const { status, text } = await api("/")
	assert.equal(status, 200)
	assert.match(text, /<\/html>/i)
})

test("rujukan kurier dan status tersedia untuk UI", async () => {
	const { status, json } = await api("/api/couriers")
	assert.equal(status, 200)
	assert.ok(json.couriers.some(c => c.slug === "poslaju"))
	assert.equal(json.statuses.length, 9)
	assert.equal(json.statuses.find(s => s.code === "DELIVERED").label, "Sudah sampai")
})

test("auto-detect kurier melalui API", async () => {
	const sah = await api("/api/detect?trackingNo=ER123456785MY")
	assert.equal(sah.json.candidates[0].slug, "poslaju")
	assert.ok(sah.json.candidates[0].confidence > 0.9)
	assert.equal(sah.json.ambiguous, false)

	const kabur = await api("/api/detect?trackingNo=123456789012")
	assert.equal(kabur.json.ambiguous, true)
})

test("tambah parcel sebenar: server pergi ambil data dari kurier", async () => {
	const { status, json } = await api("/api/parcels", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ trackingNo: TRACKING, nickname: "Kasut raya" }),
	})
	assert.equal(status, 201)
	assert.equal(json.created, true)
	assert.equal(json.parcel.courier.slug, "jt")
	assert.equal(json.parcel.nickname, "Kasut raya")
	assert.ok(json.parcel.events.length >= 1, "event sebenar dari kurier tiruan")
	assert.ok(json.parcel.adapter, "adapter yang berjaya direkodkan")
	parcelId = json.parcel.id
})

test("nombor yang sama tidak dijejak dua kali", async () => {
	const { status, json } = await api("/api/parcels", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ trackingNo: TRACKING }),
	})
	assert.equal(status, 200)
	assert.equal(json.created, false)
	assert.equal(json.parcel.id, parcelId)
})

test("nombor tidak sah ditolak dengan 400", async () => {
	const { status, json } = await api("/api/parcels", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ trackingNo: "123" }),
	})
	assert.equal(status, 400)
	assert.ok(json.error)
})

test("senarai parcel konsisten dengan parcel yang ditambah", async () => {
	const { json } = await api("/api/parcels")
	assert.equal(json.parcels.length, 1)
	assert.equal(json.parcels[0].id, parcelId)
})

test("refresh mengambil event baharu yang muncul kemudian", async () => {
	const sebelum = await api(`/api/parcels/${parcelId}`)
	const bilanganAsal = sebelum.json.parcel.events.length

	// Kurier tiruan menambah satu langkah setiap 1200ms - kita tunggu betul-betul.
	await new Promise(resolve => setTimeout(resolve, 1500))

	const { status, json } = await api(`/api/parcels/${parcelId}/refresh`, { method: "POST" })
	assert.equal(status, 200)
	assert.ok(json.inserted >= 1, "sekurang-kurangnya satu event baharu")
	assert.ok(json.parcel.events.length > bilanganAsal)
	assert.ok(json.parcel.eta, "ETA dikira untuk parcel yang belum sampai")
})

test("nama panggilan boleh dikemas kini", async () => {
	const { status, json } = await api(`/api/parcels/${parcelId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ nickname: "Kasut raya adik" }),
	})
	assert.equal(status, 200)
	assert.equal(json.parcel.nickname, "Kasut raya adik")
})

test("webhook tanpa tandatangan ditolak", async () => {
	const { status } = await api("/api/webhooks/jt", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ trackingNo: TRACKING, events: [] }),
	})
	assert.equal(status, 401)
})

test("webhook bertandatangan diterima dan menolak parcel ke DELIVERED", async () => {
	const body = JSON.stringify({
		trackingNo: TRACKING,
		events: [
			{
				status: "Delivered",
				description: "Diterima oleh penerima",
				location: "Shah Alam",
				timestamp: new Date().toISOString(),
			},
		],
	})

	const { status, json } = await api("/api/webhooks/jt", {
		method: "POST",
		headers: { "content-type": "application/json", "x-jejak-signature": signPayload(body) },
		body,
	})
	assert.equal(status, 200)
	assert.equal(json.accepted, true)

	const selepas = await api(`/api/parcels/${parcelId}`)
	assert.equal(selepas.json.parcel.status, "DELIVERED")
	assert.equal(selepas.json.parcel.pollState, "done", "berhenti dipoll selepas sampai")
	assert.equal(selepas.json.parcel.eta, null)
})

test("webhook untuk parcel yang tidak dijejak direkod tanpa ralat", async () => {
	const body = JSON.stringify({
		trackingNo: "600000000001",
		events: [{ status: "In transit", description: "Tiba di hab", timestamp: new Date().toISOString() }],
	})
	const { status, json } = await api("/api/webhooks/jt", {
		method: "POST",
		headers: { "content-type": "application/json", "x-jejak-signature": signPayload(body) },
		body,
	})
	assert.equal(status, 200)
	assert.equal(json.accepted, false)
})

test("notifikasi direkod bila status berubah", async () => {
	const { json } = await api("/api/notifications")
	assert.ok(json.notifications.length >= 1)
	assert.ok(json.notifications.some(n => n.status === "DELIVERED"))
})

test("statistik memadankan keadaan sebenar pangkalan data", async () => {
	const { json } = await api("/api/stats")
	assert.equal(json.total, 1)
	assert.equal(json.byStatus.DELIVERED, 1)
	assert.equal(typeof json.poller.ticks, "number")
})

test("strim SSE menghantar bingkai pembukaan", async () => {
	const controller = new AbortController()
	const res = await fetch(`${base}/api/stream`, { signal: controller.signal })
	assert.equal(res.status, 200)
	const reader = res.body.getReader()
	const { value } = await reader.read()
	assert.match(new TextDecoder().decode(value), /hello/)
	controller.abort()
})

test("padam parcel membuang rekod sepenuhnya", async () => {
	const padam = await api(`/api/parcels/${parcelId}`, { method: "DELETE" })
	assert.equal(padam.status, 200)
	assert.equal(padam.json.deleted, true)

	const semak = await api(`/api/parcels/${parcelId}`)
	assert.equal(semak.status, 404)
})
