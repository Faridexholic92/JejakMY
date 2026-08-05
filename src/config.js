const env = process.env

const num = (value, fallback) => {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : fallback
}
const bool = (value, fallback) =>
	value === undefined || value === "" ? fallback : /^(1|true|ya|yes|on)$/i.test(String(value))
const list = (value, fallback) =>
	value ? String(value).split(",").map(s => s.trim()).filter(Boolean) : fallback

/**
 * Satu tempat untuk semua tetapan. Semuanya boleh ditukar melalui env supaya
 * kod yang sama boleh jalan di laptop (kurier tiruan) dan di produksi
 * (agregator + API rasmi) tanpa diubah.
 */
export const config = {
	port: num(env.PORT, 4000),
	host: env.HOST ?? "127.0.0.1",
	dbPath: env.DB_PATH ?? "./data/jejak.db",

	poller: {
		enabled: bool(env.POLLER_ENABLED, true),
		tickMs: num(env.POLLER_TICK_MS, 10_000),
		batchSize: num(env.POLLER_BATCH, 20),
		maxAttempts: num(env.POLLER_MAX_ATTEMPTS, 8),
		// Had atas selang poll. Turunkan untuk demo pantas atau pelanggan SLA ketat.
		maxIntervalMinutes: num(env.POLLER_MAX_INTERVAL_MIN, 720),
	},

	// Kurier tiruan tempatan: membolehkan pembangunan penuh tanpa kunci API.
	demo: {
		enabled: bool(env.DEMO_MODE, true),
		baseUrl: env.DEMO_COURIER_URL ?? "http://127.0.0.1:4010",
		apiKey: env.DEMO_API_KEY ?? "demo",
	},

	// Agregator (TrackingMore/AfterShip/Tracking.my): hidup sebaik ada kunci.
	aggregator: {
		enabled: Boolean(env.AGGREGATOR_API_KEY),
		baseUrl: env.AGGREGATOR_BASE_URL ?? "https://api.trackingmore.com",
		apiKey: env.AGGREGATOR_API_KEY ?? "",
		apiKeyHeader: env.AGGREGATOR_KEY_HEADER ?? "Tracking-Api-Key",
	},

	// Contoh API rasmi kurier.
	ninjaVan: {
		enabled: Boolean(env.NINJAVAN_CLIENT_ID && env.NINJAVAN_CLIENT_SECRET),
		baseUrl: env.NINJAVAN_BASE_URL ?? "https://api.ninjavan.co",
		countryCode: env.NINJAVAN_COUNTRY ?? "my",
		clientId: env.NINJAVAN_CLIENT_ID ?? "",
		clientSecret: env.NINJAVAN_CLIENT_SECRET ?? "",
	},

	webhook: {
		secret: env.WEBHOOK_SECRET ?? "dev-secret-tukar-di-produksi",
		signatureHeader: env.WEBHOOK_SIGNATURE_HEADER ?? "x-jejak-signature",
		requireSignature: bool(env.WEBHOOK_REQUIRE_SIGNATURE, true),
	},

	notify: {
		statuses: list(env.NOTIFY_STATUSES, [
			"OUT_FOR_DELIVERY",
			"FAILED_ATTEMPT",
			"EXCEPTION",
			"DELIVERED",
			"RETURNED",
		]),
		webhookUrl: env.NOTIFY_WEBHOOK_URL ?? "",
		whatsapp: {
			enabled: Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID),
			token: env.WHATSAPP_TOKEN ?? "",
			phoneNumberId: env.WHATSAPP_PHONE_ID ?? "",
			apiVersion: env.WHATSAPP_API_VERSION ?? "v21.0",
		},
	},

	http: {
		timeoutMs: num(env.HTTP_TIMEOUT_MS, 12_000),
		retries: num(env.HTTP_RETRIES, 2),
		userAgent: env.HTTP_USER_AGENT ?? "JejakBot/0.1",
	},
}

export default config
