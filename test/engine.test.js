import test from "node:test"
import assert from "node:assert/strict"
import { openDb, createStore } from "../src/db.js"
import { createEngine, TrackingError } from "../src/services/ingest.js"

// Kurier tiruan dalam memori: kita kawal betul-betul apa yang "kurier" jawab,
// jadi ujian ini menguji enjin, bukan rangkaian.
function scriptedCourier(script) {
	let step = 0
	return {
		advance: () => { step += 1 },
		get calls() { return step },
		async fetchTracking({ trackingNo, courierSlug }) {
			const events = script[Math.min(step, script.length - 1)]
			if (events === null) {
				return { ok: false, adapter: "ujian", events: [], httpStatus: 503, error: "kurier down", raw: "" }
			}
			return { ok: true, adapter: "ujian", events, httpStatus: 200, error: null, raw: JSON.stringify(events) }
		},
	}
}

function collectingNotifier() {
	const sent = []
	return { sent, async dispatch(payload) { sent.push(payload) } }
}

function freshEngine(script) {
	const store = createStore(openDb(":memory:"))
	const courier = scriptedCourier(script)
	const notifier = collectingNotifier()
	const engine = createEngine({
		store,
		notifier,
		fetchTracking: args => courier.fetchTracking(args),
	})
	return { store, courier, notifier, engine }
}

const EV = (rawStatus, description, happenedAt, location = "Kuala Lumpur") => ({
	rawStatus, description, happenedAt, location,
})

const STEP0 = [EV("Shipment created", "Maklumat penghantaran diterima", "2026-08-01T02:00:00Z")]
const STEP1 = [...STEP0, EV("In transit", "Tiba di hab penyusunan", "2026-08-01T09:00:00Z")]
const STEP2 = [...STEP1, EV("Out for delivery", "Parcel bersama rider", "2026-08-02T01:00:00Z")]
const STEP3 = [...STEP2, EV("Delivered", "Diterima oleh penerima", "2026-08-02T05:00:00Z")]

test("tambah parcel: kurier dikesan automatik dan event pertama disimpan", async () => {
	const { engine, store } = freshEngine([STEP0])
	const { parcel, created } = await engine.addParcel({ trackingNo: "630123456789", nickname: "Kasut raya" })

	assert.equal(created, true)
	assert.equal(parcel.courier_slug, "jt")
	assert.equal(parcel.tracking_no, "630123456789")
	assert.equal(parcel.status, "INFO_RECEIVED")
	assert.equal(parcel.nickname, "Kasut raya")
	assert.equal(store.countEvents(parcel.id), 1)
})

test("nombor yang sama tidak menghasilkan parcel pendua", async () => {
	const { engine } = freshEngine([STEP0])
	const first = await engine.addParcel({ trackingNo: "630123456789" })
	const second = await engine.addParcel({ trackingNo: " 6301-2345 6789 " })

	assert.equal(second.created, false)
	assert.equal(second.parcel.id, first.parcel.id)
})

test("nombor tidak sah ditolak dengan sebab yang jelas", async () => {
	const { engine } = freshEngine([STEP0])
	await assert.rejects(() => engine.addParcel({ trackingNo: "123" }), err => {
		assert.ok(err instanceof TrackingError)
		assert.equal(err.code, "INVALID_TRACKING_NO")
		return true
	})
	await assert.rejects(() => engine.addParcel({ trackingNo: "ZZZZZZZZZZ" }), err => {
		assert.equal(err.code, "COURIER_UNKNOWN")
		return true
	})
})

test("refresh berulang tidak menyimpan event yang sama dua kali", async () => {
	const { engine, store } = freshEngine([STEP1])
	const { parcel } = await engine.addParcel({ trackingNo: "630123456789" })
	assert.equal(store.countEvents(parcel.id), 2)

	const again = await engine.refresh(parcel.id)
	assert.equal(again.inserted, 0)
	assert.equal(again.statusChanged, false)
	assert.equal(store.countEvents(parcel.id), 2)
})

test("parcel bergerak melalui kitaran penuh dan berhenti dipoll bila sampai", async () => {
	const { engine, courier, notifier, store } = freshEngine([STEP0, STEP1, STEP2, STEP3])
	const { parcel } = await engine.addParcel({ trackingNo: "630123456789" })
	assert.equal(parcel.status, "INFO_RECEIVED")

	courier.advance()
	const transit = await engine.refresh(parcel.id)
	assert.equal(transit.parcel.status, "IN_TRANSIT")
	assert.equal(transit.inserted, 1)

	courier.advance()
	const rider = await engine.refresh(parcel.id)
	assert.equal(rider.parcel.status, "OUT_FOR_DELIVERY")
	assert.equal(rider.parcel.eta_confidence, "high")
	assert.equal(rider.parcel.poll_state, "active")

	courier.advance()
	const done = await engine.refresh(parcel.id)
	assert.equal(done.parcel.status, "DELIVERED")
	assert.equal(done.parcel.poll_state, "done")
	assert.equal(done.parcel.next_poll_at, null)
	assert.equal(done.parcel.eta_start, null, "parcel yang sudah sampai tidak perlu ETA")
	assert.equal(store.countEvents(parcel.id), 4)

	const statuses = notifier.sent.map(n => n.status)
	assert.deepEqual(statuses, ["INFO_RECEIVED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"])
})

test("event lewat tidak memundurkan parcel yang sudah sampai", async () => {
	const late = [...STEP3, EV("In transit", "Bertolak dari hab", "2026-08-02T03:00:00Z")]
	const { engine, courier } = freshEngine([STEP3, late])
	const { parcel } = await engine.addParcel({ trackingNo: "630123456789" })
	assert.equal(parcel.status, "DELIVERED")

	courier.advance()
	const after = await engine.refresh(parcel.id)
	assert.equal(after.inserted, 1, "event tetap disimpan untuk audit")
	assert.equal(after.parcel.status, "DELIVERED", "tetapi status tidak berundur")
})

test("kurier tumbang: parcel ditanda ralat dan dijadual cuba lagi", async () => {
	const { engine, courier } = freshEngine([STEP1, null])
	const { parcel } = await engine.addParcel({ trackingNo: "630123456789" })

	courier.advance()
	const failed = await engine.refresh(parcel.id)
	assert.equal(failed.parcel.last_error, "kurier down")
	assert.equal(failed.parcel.poll_attempts, 1)
	assert.equal(failed.parcel.poll_state, "active")
	assert.ok(failed.parcel.next_poll_at, "masih dijadual cuba lagi")
	assert.equal(failed.parcel.status, "IN_TRANSIT", "status lama dikekalkan")
})

test("bus menyiarkan kemas kini untuk UI langsung", async () => {
	const { engine, courier } = freshEngine([STEP0, STEP1])
	const seen = []
	engine.bus.on("parcel:update", payload => seen.push(payload))

	const { parcel } = await engine.addParcel({ trackingNo: "630123456789" })
	courier.advance()
	await engine.refresh(parcel.id)

	assert.equal(seen.length, 2)
	assert.equal(seen[1].statusChanged, true)
	assert.equal(seen[1].previousStatus, "INFO_RECEIVED")
})

test("parcel belum ada rekod tetap disimpan untuk dipoll kemudian", async () => {
	const { engine } = freshEngine([[]])
	const { parcel, created } = await engine.addParcel({ trackingNo: "630123456789" })
	assert.equal(created, true)
	assert.equal(parcel.status, "PENDING")
	assert.ok(parcel.next_poll_at)
})
