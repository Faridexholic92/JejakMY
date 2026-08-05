import { test } from "node:test"
import assert from "node:assert/strict"
import {
	deriveStatus,
	fingerprint,
	latestEvent,
	normaliseEvent,
	normaliseStatus,
} from "../src/core/normalise.js"

test("istilah kurier yang berbeza dipetakan ke status yang sama", () => {
	assert.equal(normaliseStatus("Out for delivery"), "OUT_FOR_DELIVERY")
	assert.equal(normaliseStatus("With rider"), "OUT_FOR_DELIVERY")
	assert.equal(normaliseStatus("", "Parcel dalam penghantaran"), "OUT_FOR_DELIVERY")
	assert.equal(normaliseStatus("Delivered"), "DELIVERED")
	assert.equal(normaliseStatus("", "Diterima oleh penerima"), "DELIVERED")
})

test("cubaan hantar gagal tidak disalah anggap sebagai berjaya", () => {
	assert.equal(normaliseStatus("Failed delivery attempt"), "FAILED_ATTEMPT")
	assert.equal(normaliseStatus("Unsuccessful delivery"), "FAILED_ATTEMPT")
	assert.equal(normaliseStatus("", "Penerima tiada di alamat"), "FAILED_ATTEMPT")
})

test("masalah kastam menjadi EXCEPTION", () => {
	assert.equal(normaliseStatus("Customs hold"), "EXCEPTION")
	assert.equal(normaliseStatus("Parcel damaged"), "EXCEPTION")
})

test("status yang tidak dikenali jatuh ke PENDING, bukan meletup", () => {
	assert.equal(normaliseStatus("XYZ-99"), "PENDING")
	assert.equal(normaliseStatus(""), "PENDING")
})

test("cap jari stabil untuk event yang sama dan berbeza bila lokasi berubah", () => {
	const base = {
		parcelId: "p1",
		happenedAt: "2026-08-05T10:00:00.000Z",
		status: "IN_TRANSIT",
		description: "Tiba di hub",
		location: "Shah Alam",
	}
	assert.equal(fingerprint(base), fingerprint({ ...base }))
	// Perbezaan huruf besar/kecil dan ruang tidak patut mencipta event baharu
	assert.equal(fingerprint(base), fingerprint({ ...base, location: " shah alam " }))
	assert.notEqual(fingerprint(base), fingerprint({ ...base, location: "Ipoh" }))
})

test("event mentah ditukar kepada bentuk kanonik dengan cap jari", () => {
	const event = normaliseEvent(
		{ rawStatus: "Out for delivery", description: "Bersama rider", location: "Ipoh", happenedAt: "2026-08-05T02:00:00Z" },
		"p1",
	)
	assert.equal(event.status, "OUT_FOR_DELIVERY")
	assert.equal(event.happenedAt, "2026-08-05T02:00:00.000Z")
	assert.match(event.fingerprint, /^[a-f0-9]{40}$/)
})

test("status diambil dari event terbaru walaupun senarai tidak tersusun", () => {
	const events = [
		{ status: "IN_TRANSIT", happenedAt: "2026-08-04T10:00:00Z" },
		{ status: "OUT_FOR_DELIVERY", happenedAt: "2026-08-05T01:00:00Z" },
		{ status: "INFO_RECEIVED", happenedAt: "2026-08-03T09:00:00Z" },
	]
	assert.equal(deriveStatus(events), "OUT_FOR_DELIVERY")
	assert.equal(latestEvent(events).status, "OUT_FOR_DELIVERY")
})

test("parcel yang sudah sampai tidak berundur bila kurier hantar event lewat", () => {
	const events = [
		{ status: "OUT_FOR_DELIVERY", happenedAt: "2026-08-05T01:00:00Z" },
		{ status: "DELIVERED", happenedAt: "2026-08-05T04:00:00Z" },
		{ status: "IN_TRANSIT", happenedAt: "2026-08-05T06:00:00Z" },
	]
	assert.equal(deriveStatus(events), "DELIVERED")
})

test("pemulangan selepas serahan tetap dibenarkan", () => {
	const events = [
		{ status: "DELIVERED", happenedAt: "2026-08-05T04:00:00Z" },
		{ status: "RETURNED", happenedAt: "2026-08-06T04:00:00Z" },
	]
	assert.equal(deriveStatus(events), "RETURNED")
})

test("gagal hantar selepas keluar hantar diterima", () => {
	const events = [
		{ status: "OUT_FOR_DELIVERY", happenedAt: "2026-08-05T01:00:00Z" },
		{ status: "FAILED_ATTEMPT", happenedAt: "2026-08-05T09:00:00Z" },
	]
	assert.equal(deriveStatus(events), "FAILED_ATTEMPT")
})
