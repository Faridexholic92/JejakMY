import { config } from "../config.js"

export class HttpError extends Error {
	constructor(message, { status = 0, body = "" } = {}) {
		super(message)
		this.name = "HttpError"
		this.status = status
		this.body = body
	}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * fetch dengan timeout, cuba semula dan backoff.
 * Cuba semula hanya untuk ralat rangkaian, 429 dan 5xx - bukan 4xx lain,
 * kerana mengulang permintaan yang salah cuma membakar kuota API.
 */
export async function fetchWithRetry(url, options = {}) {
	const {
		timeoutMs = config.http.timeoutMs,
		retries = config.http.retries,
		...init
	} = options

	let lastError
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response = await fetch(url, {
				...init,
				signal: controller.signal,
				headers: {
					"user-agent": config.http.userAgent,
					accept: "application/json",
					...(init.headers ?? {}),
				},
			})
			const text = await response.text()
			if (response.status === 429 || response.status >= 500) {
				throw new HttpError(`HTTP ${response.status}`, {
					status: response.status,
					body: text,
				})
			}
			return { status: response.status, ok: response.ok, text }
		} catch (error) {
			lastError = error
			if (attempt === retries) break
			await sleep(250 * 2 ** attempt)
		} finally {
			clearTimeout(timer)
		}
	}
	throw lastError instanceof Error ? lastError : new HttpError(String(lastError))
}

export async function fetchJson(url, options = {}) {
	const { status, ok, text } = await fetchWithRetry(url, options)
	let json = null
	try {
		json = text ? JSON.parse(text) : null
	} catch {
		throw new HttpError("Respons bukan JSON sah", { status, body: text.slice(0, 500) })
	}
	return { status, ok, json, text }
}
