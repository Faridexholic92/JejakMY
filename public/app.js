// UI Jejak. Vanilla JS, tiada framework, tiada langkah bina.
// Semua data datang dari API tempatan; tiada data palsu dalam fail ini.

const state = {
	parcels: [],
	statuses: {},
	filter: "all",
	openId: null,
}

const $ = id => document.getElementById(id)
const api = async (path, options = {}) => {
	const res = await fetch(path, {
		headers: { "content-type": "application/json" },
		...options,
	})
	const json = await res.json().catch(() => ({}))
	if (!res.ok) throw new Error(json.error ?? `Ralat ${res.status}`)
	return json
}

/* ---------- pembantu paparan ---------- */

const RELATIVE = new Intl.RelativeTimeFormat("ms", { numeric: "auto" })
const DATE_FMT = new Intl.DateTimeFormat("ms-MY", {
	day: "numeric",
	month: "short",
	hour: "2-digit",
	minute: "2-digit",
})

function timeAgo(iso) {
	if (!iso) return "belum ada"
	const diffMin = Math.round((new Date(iso) - Date.now()) / 60000)
	if (Math.abs(diffMin) < 60) return RELATIVE.format(diffMin, "minute")
	const diffHour = Math.round(diffMin / 60)
	if (Math.abs(diffHour) < 24) return RELATIVE.format(diffHour, "hour")
	return RELATIVE.format(Math.round(diffHour / 24), "day")
}

function fmtDate(iso) {
	return iso ? DATE_FMT.format(new Date(iso)) : "-"
}

function statusInfo(code) {
	return state.statuses[code] ?? { label: code, tone: "neutral" }
}

function etaText(parcel) {
	if (!parcel.eta?.start) return null
	const { start, end, confidence, basis } = parcel.eta
	const confidenceLabel =
		{ high: "yakin tinggi", medium: "yakin sederhana", low: "anggaran kasar" }[confidence] ??
		"anggaran"
	const sameDay = end && new Date(start).toDateString() === new Date(end).toDateString()
	const window = sameDay ? fmtDate(start) : `${fmtDate(start)} - ${fmtDate(end)}`
	return `Anggaran sampai: ${window} · ${confidenceLabel} · ${basis}`
}

const ATTENTION = new Set(["FAILED_ATTEMPT", "EXCEPTION", "RETURNED"])
const DONE = new Set(["DELIVERED", "EXPIRED"])

function matchesFilter(parcel) {
	if (state.filter === "all") return true
	if (state.filter === "attention") return ATTENTION.has(parcel.status)
	if (state.filter === "done") return DONE.has(parcel.status)
	return !DONE.has(parcel.status) && !ATTENTION.has(parcel.status)
}

/* ---------- render ---------- */

function renderStats() {
	const total = state.parcels.length
	const moving = state.parcels.filter(p => ["IN_TRANSIT", "OUT_FOR_DELIVERY"].includes(p.status)).length
	const attention = state.parcels.filter(p => ATTENTION.has(p.status)).length
	const done = state.parcels.filter(p => DONE.has(p.status)).length

	$("stats").innerHTML = [
		{ n: total, k: "parcel dijejak" },
		{ n: moving, k: "sedang bergerak" },
		{ n: attention, k: "perlu tindakan" },
		{ n: done, k: "selesai" },
	]
		.map(s => `<div class="stat"><div class="n">${s.n}</div><div class="k">${s.k}</div></div>`)
		.join("")
}

function renderCards() {
	const visible = state.parcels.filter(matchesFilter)
	const container = $("cards")

	if (visible.length === 0) {
		container.innerHTML = `<div class="empty">${
			state.parcels.length === 0
				? "Belum ada parcel. Masukkan satu nombor tracking di atas untuk mula."
				: "Tiada parcel dalam tapisan ini."
		}</div>`
		return
	}

	container.innerHTML = visible
		.map(parcel => {
			const info = statusInfo(parcel.status)
			const eta = etaText(parcel)
			const title = parcel.nickname || parcel.trackingNo
			const sub = parcel.nickname ? `${parcel.trackingNo} · ` : ""
			return `
				<button class="card" data-id="${parcel.id}" type="button">
					<div>
						<div class="who">${parcel.courier.name}</div>
						<div class="name">${title}</div>
						<div class="last">${sub}${parcel.lastDescription || "Menunggu scan pertama"}${
							parcel.lastLocation ? ` · ${parcel.lastLocation}` : ""
						} · ${timeAgo(parcel.lastEventAt)}</div>
					</div>
					<span class="badge" data-tone="${info.tone}">${info.label}</span>
					${eta ? `<div class="eta">${eta}</div>` : ""}
				</button>`
		})
		.join("")
}

function renderDrawer() {
	const parcel = state.parcels.find(p => p.id === state.openId)
	const drawer = $("drawer")
	const open = Boolean(parcel)
	drawer.dataset.open = String(open)
	drawer.setAttribute("aria-hidden", String(!open))
	$("backdrop").dataset.open = String(open)
	if (!parcel) return

	const info = statusInfo(parcel.status)
	$("drawer-title").textContent = parcel.nickname || parcel.trackingNo
	$("drawer-sub").innerHTML = `${parcel.courier.name} · ${parcel.trackingNo} <span class="badge" data-tone="${info.tone}">${info.label}</span>`

	const eta = etaText(parcel)
	$("drawer-meta").innerHTML = [
		eta ? `<div>${eta}</div>` : "",
		`<div>Sumber data: ${parcel.adapter ?? "belum ada"}</div>`,
		`<div>Poll seterusnya: ${
			parcel.pollState === "done"
				? "berhenti (parcel tamat)"
				: parcel.nextPollAt
					? `${fmtDate(parcel.nextPollAt)} (${timeAgo(parcel.nextPollAt)})`
					: "segera"
		}</div>`,
		parcel.lastError ? `<div>Isu terakhir: ${parcel.lastError}</div>` : "",
	]
		.filter(Boolean)
		.join("")

	$("timeline").innerHTML = parcel.events.length
		? parcel.events
				.map(event => {
					const tone = statusInfo(event.status).tone
					return `
						<li data-tone="${tone}">
							<div class="t-status">${statusInfo(event.status).label}</div>
							<div class="t-desc">${event.description || "-"}</div>
							<div class="t-meta">${fmtDate(event.happenedAt)}${
								event.location ? ` · ${event.location}` : ""
							}<span class="src">${event.source}</span></div>
						</li>`
				})
				.join("")
		: `<li><div class="t-desc">Belum ada event. Kurier belum scan parcel ini.</div></li>`
}

function render() {
	renderStats()
	renderCards()
	renderDrawer()
}

/* ---------- data ---------- */

async function loadAll() {
	const [{ parcels }, { statuses }] = await Promise.all([
		api("/api/parcels"),
		api("/api/couriers"),
	])
	state.statuses = Object.fromEntries(statuses.map(s => [s.code, s]))
	state.parcels = parcels
	render()
}

function upsertParcel(parcel) {
	const index = state.parcels.findIndex(p => p.id === parcel.id)
	if (index === -1) state.parcels.unshift(parcel)
	else state.parcels[index] = parcel
	render()
}

/* ---------- detect langsung semasa menaip ---------- */

let detectTimer = null
$("tracking").addEventListener("input", event => {
	const value = event.target.value.trim()
	clearTimeout(detectTimer)
	if (value.length < 6) {
		$("detect").innerHTML = ""
		return
	}
	detectTimer = setTimeout(async () => {
		try {
			const { candidates, ambiguous } = await api(`/api/detect?trackingNo=${encodeURIComponent(value)}`)
			if (candidates.length === 0) {
				$("detect").innerHTML = `<span class="chip weak">Kurier tidak dikenali</span> Kami tetap boleh cuba.`
				return
			}
			$("detect").innerHTML =
				candidates
					.slice(0, 3)
					.map(
						(c, i) =>
							`<span class="chip ${i === 0 ? "" : "weak"}">${c.name} ${Math.round(c.confidence * 100)}%</span>`,
					)
					.join("") +
				(ambiguous ? "<span>Dua calon rapat - kami akan cuba kedua-duanya.</span>" : `<span>${candidates[0].reason}</span>`)
		} catch {
			$("detect").innerHTML = ""
		}
	}, 180)
})

/* ---------- tindakan ---------- */

$("add-form").addEventListener("submit", async event => {
	event.preventDefault()
	const button = $("add-btn")
	const trackingNo = $("tracking").value.trim()
	const nickname = $("nickname").value.trim() || null
	if (!trackingNo) return

	button.disabled = true
	button.textContent = "Mencari…"
	$("form-error").hidden = true
	try {
		const { parcel } = await api("/api/parcels", {
			method: "POST",
			body: JSON.stringify({ trackingNo, nickname }),
		})
		upsertParcel(parcel)
		state.openId = parcel.id
		renderDrawer()
		$("tracking").value = ""
		$("nickname").value = ""
		$("detect").innerHTML = ""
	} catch (error) {
		$("form-error").textContent = error.message
		$("form-error").hidden = false
	} finally {
		button.disabled = false
		button.textContent = "Jejak"
	}
})

$("cards").addEventListener("click", event => {
	const card = event.target.closest(".card")
	if (!card) return
	state.openId = card.dataset.id
	renderDrawer()
})

$("filters").addEventListener("click", event => {
	const button = event.target.closest("button[data-filter]")
	if (!button) return
	state.filter = button.dataset.filter
	for (const b of $("filters").querySelectorAll("button")) {
		b.setAttribute("aria-pressed", String(b === button))
	}
	renderCards()
})

function closeDrawer() {
	state.openId = null
	renderDrawer()
}

$("drawer-close").addEventListener("click", closeDrawer)
$("backdrop").addEventListener("click", closeDrawer)
document.addEventListener("keydown", event => {
	if (event.key === "Escape") closeDrawer()
})

$("refresh-btn").addEventListener("click", async () => {
	const id = state.openId
	if (!id) return
	const button = $("refresh-btn")
	button.disabled = true
	button.textContent = "Mengemas kini…"
	try {
		const { parcel } = await api(`/api/parcels/${id}/refresh`, { method: "POST" })
		upsertParcel(parcel)
	} catch (error) {
		alert(error.message)
	} finally {
		button.disabled = false
		button.textContent = "Kemas kini sekarang"
	}
})

$("delete-btn").addEventListener("click", async () => {
	const id = state.openId
	if (!id) return
	await api(`/api/parcels/${id}`, { method: "DELETE" })
	state.parcels = state.parcels.filter(p => p.id !== id)
	closeDrawer()
	render()
})

/* ---------- strim langsung ---------- */

function connectStream() {
	const source = new EventSource("/api/stream")
	source.onopen = () => {
		$("live").dataset.state = "live"
		$("live-text").textContent = "Kemas kini langsung"
	}
	source.onerror = () => {
		$("live").dataset.state = "down"
		$("live-text").textContent = "Sambungan terputus"
	}
	source.onmessage = event => {
		const payload = JSON.parse(event.data)
		if (payload.type === "parcel:update") upsertParcel(payload.parcel)
	}
}

loadAll().then(connectStream).catch(error => {
	$("cards").innerHTML = `<div class="empty">Tidak dapat sambung ke enjin: ${error.message}</div>`
})
