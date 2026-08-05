import http from "node:http"
import { readFile } from "node:fs/promises"
import { join, extname } from "node:path"
import process from "node:process"

import { config } from "./config.js"
import { openDb, createStore, toParcelDto } from "./db.js"
import { createEngine, TrackingError } from "./services/ingest.js"
import { createPoller } from "./services/poller.js"
import { createNotifier } from "./services/notify.js"
import { createWebhookHandler } from "./services/webhooks.js"
import { detectCourier, isAmbiguous, COURIERS } from "./core/detect.js"
import { LABEL_MS, TONE, STATUSES } from "./core/statuses.js"

const PUBLIC_DIR = join(import.meta.dirname, "..", "public")
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload)
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	})
	res.end(body)
}

async function readBody(req, limitBytes = 1_000_000) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > limitBytes) throw new TrackingError("Payload terlalu besar", "PAYLOAD_TOO_LARGE", 413)
		chunks.push(chunk)
	}
	return Buffer.concat(chunks).toString("utf8")
}

async function readJsonBody(req) {
	const raw = await readBody(req)
	if (!raw) return {}
	try {
		return JSON.parse(raw)
	} catch {
		throw new TrackingError("Body bukan JSON sah", "BAD_JSON", 400)
	}
}

export function createApp({ store, engine, poller, handleWebhook }) {
	const sseClients = new Set()

	engine.bus.on("parcel:update", ({ parcel, inserted, statusChanged }) => {
		const payload = JSON.stringify({
			type: "parcel:update",
			inserted,
			statusChanged,
			parcel: toParcelDto(parcel, store.listEvents(parcel.id)),
		})
		for (const res of sseClients) res.write(`data: ${payload}\n\n`)
	})

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`)
		const path = url.pathname
		const method = req.method ?? "GET"

		try {
			// --- Kesihatan -------------------------------------------------
			if (path === "/healthz") {
				return sendJson(res, 200, {
					ok: true,
					uptimeSec: Math.round(process.uptime()),
					poller: poller.stats(),
				})
			}

			// --- Rujukan ---------------------------------------------------
			if (path === "/api/couriers" && method === "GET") {
				return sendJson(res, 200, {
					couriers: COURIERS.map(c => ({ slug: c.slug, name: c.name, priority: c.priority })),
					statuses: STATUSES.map(s => ({ code: s, label: LABEL_MS[s], tone: TONE[s] })),
				})
			}

			if (path === "/api/detect" && method === "GET") {
				const trackingNo = url.searchParams.get("trackingNo") ?? ""
				const candidates = detectCourier(trackingNo)
				return sendJson(res, 200, {
					trackingNo,
					candidates,
					ambiguous: isAmbiguous(candidates),
				})
			}

			// --- Parcel ----------------------------------------------------
			if (path === "/api/parcels" && method === "GET") {
				const rows = store.listParcels()
				return sendJson(res, 200, {
					parcels: rows.map(row => toParcelDto(row, store.listEvents(row.id).slice(0, 3))),
				})
			}

			if (path === "/api/parcels" && method === "POST") {
				const body = await readJsonBody(req)
				const result = await engine.addParcel({
					trackingNo: body.trackingNo,
					courierSlug: body.courier ?? null,
					nickname: body.nickname ?? null,
				})
				return sendJson(res, result.created ? 201 : 200, {
					created: result.created,
					probe: result.probe,
					parcel: toParcelDto(result.parcel, store.listEvents(result.parcel.id)),
				})
			}

			const parcelMatch = /^\/api\/parcels\/([\w-]+)(\/refresh)?$/.exec(path)
			if (parcelMatch) {
				const [, id, refreshSuffix] = parcelMatch

				if (refreshSuffix && method === "POST") {
					const result = await engine.refresh(id, { source: "manual" })
					return sendJson(res, 200, {
						inserted: result.inserted,
						statusChanged: result.statusChanged,
						parcel: toParcelDto(result.parcel, store.listEvents(id)),
					})
				}

				if (!refreshSuffix && method === "GET") {
					const row = store.getParcel(id)
					if (!row) return sendJson(res, 404, { error: "Parcel tidak dijumpai" })
					return sendJson(res, 200, { parcel: toParcelDto(row, store.listEvents(id)) })
				}

				if (!refreshSuffix && method === "PATCH") {
					const body = await readJsonBody(req)
					if (!store.getParcel(id)) return sendJson(res, 404, { error: "Parcel tidak dijumpai" })
					store.setNickname(id, body.nickname ?? null)
					return sendJson(res, 200, {
						parcel: toParcelDto(store.getParcel(id), store.listEvents(id)),
					})
				}

				if (!refreshSuffix && method === "DELETE") {
					const deleted = store.deleteParcel(id)
					return sendJson(res, deleted ? 200 : 404, { deleted })
				}
			}

			// --- Statistik dan notifikasi ----------------------------------
			if (path === "/api/stats" && method === "GET") {
				const byStatus = Object.fromEntries(store.statsByStatus().map(r => [r.status, r.n]))
				return sendJson(res, 200, {
					total: Object.values(byStatus).reduce((a, b) => a + b, 0),
					byStatus,
					poller: poller.stats(),
				})
			}

			if (path === "/api/notifications" && method === "GET") {
				return sendJson(res, 200, { notifications: store.listNotifications(50) })
			}

			// --- Webhook kurier --------------------------------------------
			const webhookMatch = /^\/api\/webhooks\/([\w-]+)$/.exec(path)
			if (webhookMatch && method === "POST") {
				const rawBody = await readBody(req)
				const result = await handleWebhook({
					courierSlug: webhookMatch[1],
					rawBody,
					signature: req.headers[config.webhook.signatureHeader],
				})
				return sendJson(res, 200, result)
			}

			// --- Strim langsung (SSE) --------------------------------------
			if (path === "/api/stream" && method === "GET") {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				})
				res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`)
				sseClients.add(res)
				const ping = setInterval(() => res.write(": ping\n\n"), 25_000)
				ping.unref?.()
				req.on("close", () => {
					clearInterval(ping)
					sseClients.delete(res)
				})
				return undefined
			}

			// --- Fail statik ------------------------------------------------
			if (method === "GET") {
				const file = path === "/" ? "index.html" : path.replace(/^\/+/, "")
				if (!file.includes("..")) {
					try {
						const content = await readFile(join(PUBLIC_DIR, file))
						res.writeHead(200, {
							"content-type": MIME[extname(file)] ?? "application/octet-stream",
						})
						return res.end(content)
					} catch {
						// jatuh ke 404 di bawah
					}
				}
			}

			return sendJson(res, 404, { error: "Laluan tidak wujud", path })
		} catch (error) {
			const status = error?.statusCode ?? 500
			if (status >= 500) console.error("[server]", error)
			return sendJson(res, status, {
				error: error?.message ?? "Ralat pelayan",
				code: error?.code ?? "INTERNAL",
			})
		}
	})

	server.on("close", () => {
		for (const res of sseClients) res.end()
		sseClients.clear()
	})

	return server
}

/** Pasang semua bahagian. Dipakai oleh server sebenar dan oleh ujian. */
export function bootstrap({ dbPath = config.dbPath, log = console.log } = {}) {
	const db = openDb(dbPath)
	const store = createStore(db)
	const notifier = createNotifier({ store, log })
	const engine = createEngine({ store, notifier, log })
	const poller = createPoller({ store, engine, log })
	const handleWebhook = createWebhookHandler({ store, engine })
	const server = createApp({ store, engine, poller, handleWebhook })
	return { db, store, engine, poller, server, handleWebhook }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
	const { server, poller } = bootstrap()
	server.listen(config.port, config.host, () => {
		console.log(`[jejak] http://${config.host}:${config.port}`)
		console.log(`[jejak] demo mode: ${config.demo.enabled ? "hidup" : "mati"}`)
		if (config.poller.enabled) poller.start()
	})
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			poller.stop()
			server.close(() => process.exit(0))
		})
	}
}
