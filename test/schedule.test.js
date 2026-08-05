import test from "node:test"
import assert from "node:assert/strict"
import { planNextPoll, isoAfterMinutes, BASE_MINUTES } from "../src/services/schedule.js"

test("parcel yang sudah sampai berhenti dipoll terus", () => {
	for (const status of ["DELIVERED", "RETURNED", "EXPIRED"]) {
		const plan = planNextPoll({ status })
		assert.equal(plan.pollState, "done")
		assert.equal(plan.delayMinutes, null)
	}
})

test("parcel yang keluar untuk penghantaran dipoll paling kerap", () => {
	const hot = planNextPoll({ status: "OUT_FOR_DELIVERY" })
	const warm = planNextPoll({ status: "IN_TRANSIT" })
	const cold = planNextPoll({ status: "PENDING" })
	assert.equal(hot.delayMinutes, BASE_MINUTES.OUT_FOR_DELIVERY)
	assert.ok(hot.delayMinutes < warm.delayMinutes)
	assert.ok(warm.delayMinutes < cold.delayMinutes)
})

test("parcel senyap dilonggarkan supaya kos API tidak membengkak", () => {
	const fresh = planNextPoll({ status: "IN_TRANSIT", consecutiveEmpty: 0 })
	const quiet = planNextPoll({ status: "IN_TRANSIT", consecutiveEmpty: 6 })
	assert.equal(fresh.delayMinutes, 120)
	assert.equal(quiet.delayMinutes, 480)
})

test("selang tidak pernah melebihi 12 jam", () => {
	const plan = planNextPoll({ status: "PENDING", consecutiveEmpty: 9 })
	assert.equal(plan.delayMinutes, 720)
})

test("parcel yang tidak pernah bergerak akhirnya jadi dormant", () => {
	const plan = planNextPoll({ status: "PENDING", consecutiveEmpty: 12 })
	assert.equal(plan.pollState, "dormant")
	assert.equal(plan.delayMinutes, null)
})

test("kegagalan berturut menggunakan backoff eksponen", () => {
	assert.equal(planNextPoll({ status: "IN_TRANSIT", errored: true, attempts: 0 }).delayMinutes, 15)
	assert.equal(planNextPoll({ status: "IN_TRANSIT", errored: true, attempts: 2 }).delayMinutes, 60)
	assert.equal(planNextPoll({ status: "IN_TRANSIT", errored: true, attempts: 4 }).delayMinutes, 240)
})

test("gagal melebihi had percubaan berhenti mengganggu API kurier", () => {
	const plan = planNextPoll({ status: "IN_TRANSIT", errored: true, attempts: 8, maxAttempts: 8 })
	assert.equal(plan.pollState, "dormant")
	assert.equal(plan.delayMinutes, null)
})

test("isoAfterMinutes memulangkan null bila tiada poll seterusnya", () => {
	assert.equal(isoAfterMinutes(null), null)
	const from = Date.parse("2026-08-05T10:00:00.000Z")
	assert.equal(isoAfterMinutes(30, from), "2026-08-05T10:30:00.000Z")
})

test("had selang boleh diketatkan untuk demo atau SLA", () => {
	assert.equal(planNextPoll({ status: "IN_TRANSIT", capMinutes: 5 }).delayMinutes, 5)
	assert.equal(planNextPoll({ status: "OUT_FOR_DELIVERY", capMinutes: 60 }).delayMinutes, 15)
	assert.equal(planNextPoll({ status: "PENDING", consecutiveEmpty: 9, capMinutes: 30 }).delayMinutes, 30)
})
