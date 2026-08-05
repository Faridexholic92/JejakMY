import { config } from "../config.js"
import { LABEL_MS } from "../core/statuses.js"

/**
 * Notifikasi. Peraturan produk: hanya ganggu pengguna untuk perkara yang
 * mereka boleh buat sesuatu. Setiap penghantaran direkod dalam pangkalan data
 * supaya boleh diaudit dan dicuba semula.
 */

export function buildMessage(parcel, status) {
	const label = LABEL_MS[status] ?? status
	const name = parcel.nickname || parcel.tracking_no
	const courier = parcel.courier_name

	const bodies = {
		OUT_FOR_DELIVERY: `${name} sedang bersama rider ${courier} hari ini. Pastikan ada orang di alamat.`,
		FAILED_ATTEMPT: `Cubaan hantar ${name} gagal. ${courier} lazimnya cuba semula dalam 1-2 hari bekerja - atau atur ambil sendiri.`,
		EXCEPTION: `Ada masalah dengan ${name} di ${courier}. Semak butiran dan hubungi kurier kalau tiada gerakan dalam 24 jam.`,
		DELIVERED: `${name} sudah sampai. Semak barang sebelum sahkan terima.`,
		RETURNED: `${name} sedang dipulangkan kepada penghantar.`,
	}

	return {
		title: `${label}: ${name}`,
		body: bodies[status] ?? `${name} kini berstatus ${label.toLowerCase()}.`,
	}
}

async function sendWebhook(url, payload) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	})
	if (!response.ok) throw new Error(`webhook notifikasi balas ${response.status}`)
}

async function sendWhatsApp(parcel, message) {
	const { token, phoneNumberId, apiVersion } = config.notify.whatsapp
	const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`
	const response = await fetch(url, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			messaging_product: "whatsapp",
			to: parcel.notify_phone,
			type: "text",
			text: { body: `${message.title}\n\n${message.body}` },
		}),
	})
	if (!response.ok) throw new Error(`WhatsApp API balas ${response.status}`)
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {(line: string) => void} [deps.log]
 */
export function createNotifier({ store, log = () => {} }) {
	return {
		/** Hantar notifikasi untuk satu perubahan status. */
		async dispatch({ parcel, status }) {
			if (!config.notify.statuses.includes(status)) return []
			const message = buildMessage(parcel, status)
			const sent = []

			// Saluran 1: log (sentiasa hidup, berguna untuk pembangunan dan audit)
			log(`[notify] ${message.title} - ${message.body}`)
			sent.push({
				channel: "log",
				id: store.recordNotification({
					parcelId: parcel.id,
					status,
					channel: "log",
					title: message.title,
					body: message.body,
					deliveredAt: new Date().toISOString(),
				}),
			})

			// Saluran 2: webhook keluar (untuk seller sambung ke sistem sendiri)
			if (config.notify.webhookUrl) {
				let error = null
				try {
					await sendWebhook(config.notify.webhookUrl, {
						event: "parcel.status_changed",
						parcelId: parcel.id,
						trackingNo: parcel.tracking_no,
						courier: parcel.courier_slug,
						status,
						message,
					})
				} catch (err) {
					error = err instanceof Error ? err.message : String(err)
				}
				sent.push({
					channel: "webhook",
					error,
					id: store.recordNotification({
						parcelId: parcel.id,
						status,
						channel: "webhook",
						title: message.title,
						body: message.body,
						deliveredAt: error ? null : new Date().toISOString(),
						error,
					}),
				})
			}

			// Saluran 3: WhatsApp (perlu nombor pengguna + akaun WhatsApp Business)
			if (config.notify.whatsapp.enabled && parcel.notify_phone) {
				let error = null
				try {
					await sendWhatsApp(parcel, message)
				} catch (err) {
					error = err instanceof Error ? err.message : String(err)
				}
				sent.push({
					channel: "whatsapp",
					error,
					id: store.recordNotification({
						parcelId: parcel.id,
						status,
						channel: "whatsapp",
						title: message.title,
						body: message.body,
						deliveredAt: error ? null : new Date().toISOString(),
						error,
					}),
				})
			}

			return sent
		},
	}
}
