import { config } from "../config.js"

/**
 * Poller: satu tick, ambil parcel yang sampai masa, refresh satu per satu.
 *
 * Sengaja bersiri (bukan serentak) supaya kita tidak membanjiri API kurier.
 * Untuk skala lebih besar, tukar loop ini kepada baris gilir (BullMQ/SQS)
 * dengan had kadar setiap kurier - antara muka `tick()` kekal sama.
 */
export function createPoller({ store, engine, log = () => {} }) {
	let timer = null
	let running = false
	const stats = { ticks: 0, polled: 0, errors: 0, lastTickAt: null }

	async function tick() {
		if (running) return { skipped: true }
		running = true
		const due = store.duePolls(config.poller.batchSize)
		let polled = 0
		let errors = 0

		for (const parcel of due) {
			try {
				const result = await engine.refresh(parcel.id, { source: "poll" })
				polled += 1
				if (result.inserted > 0) {
					log(
						`[poll] ${parcel.tracking_no} +${result.inserted} event -> ${result.status}`,
					)
				}
			} catch (error) {
				errors += 1
				log(`[poll] ${parcel.tracking_no} gagal: ${error.message}`)
			}
		}

		stats.ticks += 1
		stats.polled += polled
		stats.errors += errors
		stats.lastTickAt = new Date().toISOString()
		running = false
		return { due: due.length, polled, errors }
	}

	return {
		tick,
		stats: () => ({ ...stats, enabled: timer !== null }),
		start() {
			if (timer) return
			timer = setInterval(() => {
				tick().catch(error => log(`[poll] tick gagal: ${error.message}`))
			}, config.poller.tickMs)
			timer.unref?.()
			log(`[poll] poller hidup, tick setiap ${config.poller.tickMs / 1000}s`)
		},
		stop() {
			if (timer) clearInterval(timer)
			timer = null
		},
	}
}
