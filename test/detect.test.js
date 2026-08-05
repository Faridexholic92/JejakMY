import { test } from "node:test"
import assert from "node:assert/strict"
import {
	detectCourier,
	isAmbiguous,
	normaliseTrackingNo,
	s10ChecksumValid,
} from "../src/core/detect.js"

test("nombor dibersihkan sebelum dipadankan", () => {
	assert.equal(normaliseTrackingNo(" er 123456785-my "), "ER123456785MY")
	assert.equal(normaliseTrackingNo("630-123-456-789"), "630123456789")
})

test("digit semak S10 membezakan Pos Laju betul dan salah", () => {
	assert.equal(s10ChecksumValid("ER123456785MY"), true)
	assert.equal(s10ChecksumValid("ER123456789MY"), false)
})

test("Pos Laju dengan digit semak sah mendapat keyakinan tinggi", () => {
	const [best] = detectCourier("ER123456785MY")
	assert.equal(best.slug, "poslaju")
	assert.equal(best.confidence, 0.97)
})

test("corak sepadan tetapi digit semak gagal menurunkan keyakinan", () => {
	const [best] = detectCourier("ER123456789MY")
	assert.equal(best.slug, "poslaju")
	assert.ok(best.confidence < 0.5, "keyakinan patut rendah bila checksum gagal")
})

test("12 digit bermula 6 diutamakan kepada J&T", () => {
	const candidates = detectCourier("630123456789")
	assert.equal(candidates[0].slug, "jt")
	assert.ok(candidates.length > 1, "kurier 12 digit lain patut kekal sebagai calon")
	assert.equal(isAmbiguous(candidates), false)
})

test("12 digit biasa adalah kabur antara City-Link dan GDex", () => {
	const candidates = detectCourier("123456789012")
	assert.ok(candidates.length >= 2)
	assert.equal(isAmbiguous(candidates), true)
})

test("awalan jelas dikesan tepat", () => {
	assert.equal(detectCourier("SPXMY041234567")[0].slug, "spx")
	assert.equal(detectCourier("NVMY12345678")[0].slug, "ninjavan")
	assert.equal(detectCourier("JD014600006281230852")[0].slug, "dhl-ecommerce")
})

test("input terlalu pendek tidak menghasilkan tekaan", () => {
	assert.deepEqual(detectCourier("123"), [])
})
