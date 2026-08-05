import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parcels (
	id TEXT PRIMARY KEY,
	tracking_no TEXT NOT NULL,
	courier_slug TEXT NOT NULL,
	courier_name TEXT NOT NULL,
	nickname TEXT,
	status TEXT NOT NULL DEFAULT 'PENDING',
	last_description TEXT,
	last_location TEXT,
	last_event_at TEXT,
	eta_start TEXT,
	eta_end TEXT,
	eta_confidence TEXT,
	eta_basis TEXT,
	poll_state TEXT NOT NULL DEFAULT 'active',
	next_poll_at TEXT,
	poll_attempts INTEGER NOT NULL DEFAULT 0,
	consecutive_empty INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	adapter TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (tracking_no, courier_slug)
);

CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	parcel_id TEXT NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
	fingerprint TEXT NOT NULL,
	status TEXT NOT NULL,
	raw_status TEXT,
	description TEXT,
	location TEXT,
	happened_at TEXT NOT NULL,
	received_at TEXT NOT NULL,
	source TEXT NOT NULL DEFAULT 'poll',
	UNIQUE (parcel_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS notifications (
	id TEXT PRIMARY KEY,
	parcel_id TEXT NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
	status TEXT NOT NULL,
	channel TEXT NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at TEXT NOT NULL,
	delivered_at TEXT,
	error TEXT
);

-- Simpan respons mentah supaya boleh main semula bila parser berubah atau
-- bila kita tukar sumber data dari agregator ke API rasmi.
CREATE TABLE IF NOT EXISTS raw_responses (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	parcel_id TEXT,
	courier_slug TEXT NOT NULL,
	adapter TEXT NOT NULL,
	http_status INTEGER,
	ok INTEGER NOT NULL DEFAULT 0,
	body TEXT,
	fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_parcel ON events (parcel_id, happened_at DESC);
CREATE INDEX IF NOT EXISTS idx_parcels_poll ON parcels (poll_state, next_poll_at);
CREATE INDEX IF NOT EXISTS idx_raw_parcel ON raw_responses (parcel_id, fetched_at DESC);
`

export function openDb(path = ":memory:") {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
	const db = new DatabaseSync(path)
	db.exec("PRAGMA journal_mode = WAL;")
	db.exec("PRAGMA foreign_keys = ON;")
	db.exec(SCHEMA)
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
	return db
}

const nowIso = () => new Date().toISOString()

export function createStore(db) {
	const q = {
		insertParcel: db.prepare(`
			INSERT INTO parcels (id, tracking_no, courier_slug, courier_name, nickname,
				status, poll_state, next_poll_at, adapter, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'PENDING', 'active', ?, ?, ?, ?)
		`),
		getParcel: db.prepare("SELECT * FROM parcels WHERE id = ?"),
		getByTracking: db.prepare(
			"SELECT * FROM parcels WHERE tracking_no = ? AND courier_slug = ?",
		),
		listParcels: db.prepare("SELECT * FROM parcels ORDER BY datetime(updated_at) DESC"),
		deleteParcel: db.prepare("DELETE FROM parcels WHERE id = ?"),
		setNickname: db.prepare(
			"UPDATE parcels SET nickname = ?, updated_at = ? WHERE id = ?",
		),
		updateAfterIngest: db.prepare(`
			UPDATE parcels SET status = ?, last_description = ?, last_location = ?,
				last_event_at = ?, eta_start = ?, eta_end = ?, eta_confidence = ?, eta_basis = ?,
				poll_state = ?, next_poll_at = ?, poll_attempts = ?, consecutive_empty = ?,
				last_error = ?, adapter = ?, updated_at = ?
			WHERE id = ?
		`),
		duePolls: db.prepare(`
			SELECT * FROM parcels
			WHERE poll_state = 'active'
				AND (next_poll_at IS NULL OR datetime(next_poll_at) <= datetime(?))
			ORDER BY datetime(next_poll_at) ASC
			LIMIT ?
		`),
		insertEvent: db.prepare(`
			INSERT OR IGNORE INTO events
				(parcel_id, fingerprint, status, raw_status, description, location,
				 happened_at, received_at, source)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`),
		listEvents: db.prepare(
			"SELECT * FROM events WHERE parcel_id = ? ORDER BY datetime(happened_at) DESC, id DESC",
		),
		countEvents: db.prepare("SELECT COUNT(*) AS n FROM events WHERE parcel_id = ?"),
		insertNotification: db.prepare(`
			INSERT INTO notifications (id, parcel_id, status, channel, title, body, created_at, delivered_at, error)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`),
		listNotifications: db.prepare(
			"SELECT * FROM notifications ORDER BY datetime(created_at) DESC LIMIT ?",
		),
		insertRaw: db.prepare(`
			INSERT INTO raw_responses (parcel_id, courier_slug, adapter, http_status, ok, body, fetched_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`),
		statsByStatus: db.prepare(
			"SELECT status, COUNT(*) AS n FROM parcels GROUP BY status",
		),
		medianTransit: db.prepare(`
			SELECT AVG(julianday(last_event_at) - julianday(created_at)) AS avg_days
			FROM parcels WHERE courier_slug = ? AND status = 'DELIVERED'
		`),
	}

	return {
		db,
		raw: q,

		createParcel({ trackingNo, courierSlug, courierName, nickname = null, adapter = null }) {
			const id = randomUUID()
			const ts = nowIso()
			q.insertParcel.run(id, trackingNo, courierSlug, courierName, nickname, ts, adapter, ts, ts)
			return q.getParcel.get(id)
		},

		getParcel: id => q.getParcel.get(id) ?? null,
		getByTracking: (trackingNo, courierSlug) =>
			q.getByTracking.get(trackingNo, courierSlug) ?? null,
		listParcels: () => q.listParcels.all(),
		deleteParcel: id => q.deleteParcel.run(id).changes > 0,
		setNickname: (id, nickname) => q.setNickname.run(nickname, nowIso(), id),
		duePolls: (limit, at = nowIso()) => q.duePolls.all(at, limit),
		listEvents: parcelId => q.listEvents.all(parcelId),
		countEvents: parcelId => q.countEvents.get(parcelId).n,

		/** @returns {boolean} true kalau event ini baharu (bukan duplikat). */
		insertEvent(event, source = "poll") {
			const result = q.insertEvent.run(
				event.parcelId,
				event.fingerprint,
				event.status,
				event.rawStatus ?? "",
				event.description ?? "",
				event.location ?? "",
				event.happenedAt,
				nowIso(),
				source,
			)
			return result.changes > 0
		},

		updateAfterIngest(id, patch) {
			q.updateAfterIngest.run(
				patch.status,
				patch.lastDescription ?? null,
				patch.lastLocation ?? null,
				patch.lastEventAt ?? null,
				patch.eta?.start ?? null,
				patch.eta?.end ?? null,
				patch.eta?.confidence ?? null,
				patch.eta?.basis ?? null,
				patch.pollState,
				patch.nextPollAt ?? null,
				patch.pollAttempts ?? 0,
				patch.consecutiveEmpty ?? 0,
				patch.lastError ?? null,
				patch.adapter ?? null,
				nowIso(),
				id,
			)
			return q.getParcel.get(id)
		},

		recordRaw({ parcelId = null, courierSlug, adapter, httpStatus = null, ok = false, body = "" }) {
			q.insertRaw.run(
				parcelId,
				courierSlug,
				adapter,
				httpStatus,
				ok ? 1 : 0,
				typeof body === "string" ? body.slice(0, 20_000) : JSON.stringify(body).slice(0, 20_000),
				nowIso(),
			)
		},

		recordNotification({ parcelId, status, channel, title, body, deliveredAt = null, error = null }) {
			const id = randomUUID()
			q.insertNotification.run(id, parcelId, status, channel, title, body, nowIso(), deliveredAt, error)
			return id
		},

		listNotifications: (limit = 50) => q.listNotifications.all(limit),
		statsByStatus: () => q.statsByStatus.all(),
		medianTransitDays(courierSlug) {
			const row = q.medianTransit.get(courierSlug)
			return row?.avg_days ? Number(row.avg_days) : null
		},
	}
}

export function toParcelDto(row, events = []) {
	return {
		id: row.id,
		trackingNo: row.tracking_no,
		courier: { slug: row.courier_slug, name: row.courier_name },
		nickname: row.nickname,
		status: row.status,
		lastDescription: row.last_description,
		lastLocation: row.last_location,
		lastEventAt: row.last_event_at,
		eta: row.eta_start || row.eta_end
			? {
					start: row.eta_start,
					end: row.eta_end,
					confidence: row.eta_confidence,
					basis: row.eta_basis,
				}
			: null,
		pollState: row.poll_state,
		nextPollAt: row.next_poll_at,
		lastError: row.last_error,
		adapter: row.adapter,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		events: events.map(e => ({
			status: e.status,
			rawStatus: e.raw_status,
			description: e.description,
			location: e.location,
			happenedAt: e.happened_at,
			source: e.source,
		})),
	}
}
