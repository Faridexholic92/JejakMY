# Jejak - penjejak parcel Malaysia

Sistem penjejakan parcel yang benar-benar berjalan: server HTTP, pangkalan data
SQLite, adapter kurier, poller adaptif, webhook bertandatangan dan UI langsung.
Bukan mockup - semua yang disenaraikan di bawah boleh kau jalankan sendiri.

## Jalankan dalam 3 arahan

```bash
node tools/fake-courier.js      # terminal 1: kurier tiruan (port 4010)
node src/server.js              # terminal 2: aplikasi (port 4000)
node tools/seed.js              # terminal 3: masukkan 3 parcel contoh
```

Buka http://127.0.0.1:4000 dan parcel akan bergerak sendiri.

Tiada `npm install`. Sifar dependency: Node 22+ sahaja (`node:sqlite` terbina dalam).

```bash
node --test test/*.test.js       # 53 ujian, termasuk ujian HTTP hujung-ke-hujung
```

## Apa yang sebenarnya berfungsi

| Bahagian | Keadaan |
| --- | --- |
| Auto-detect kurier (8 corak + digit semak S10) | Berfungsi penuh, tiada rangkaian diperlukan |
| Normalisasi status 9 kod kanonik (BM + BI) | Berfungsi penuh |
| Dedup event ikut cap jari SHA-1 | Berfungsi penuh |
| Peraturan tiada-regresi status | Berfungsi penuh |
| Poller adaptif + backoff + dormant | Berfungsi penuh |
| Anggaran ETA berasaskan sejarah kurier | Berfungsi penuh |
| Webhook masuk (HMAC SHA-256) | Berfungsi penuh |
| Notifikasi (log + webhook keluar + WhatsApp) | Log berfungsi; WhatsApp perlu token sebenar |
| UI + kemas kini langsung (SSE) | Berfungsi penuh |
| Adapter kurier tiruan | Berfungsi penuh (tempatan) |
| Adapter agregator (TrackingMore/AfterShip) | Kod siap, belum diuji dengan kunci sebenar |
| Adapter Ninja Van (OAuth2) | Kod siap, endpoint belum disahkan dengan akaun sebenar |

## Endpoint

| Kaedah | Laluan | Guna |
| --- | --- | --- |
| GET | `/healthz` | Status server + statistik poller |
| GET | `/api/couriers` | Senarai kurier + kamus status |
| GET | `/api/detect?trackingNo=` | Teka kurier daripada nombor |
| GET | `/api/parcels` | Semua parcel |
| POST | `/api/parcels` | Tambah parcel `{trackingNo, courier?, nickname?}` |
| GET | `/api/parcels/:id` | Satu parcel + timeline penuh |
| POST | `/api/parcels/:id/refresh` | Paksa semak sekarang |
| PATCH | `/api/parcels/:id` | Tukar nama panggilan |
| DELETE | `/api/parcels/:id` | Padam parcel |
| GET | `/api/stats` | Kiraan ikut status |
| GET | `/api/notifications` | Sejarah notifikasi |
| POST | `/api/webhooks/:courier` | Push dari kurier (perlu tandatangan) |
| GET | `/api/stream` | SSE kemas kini langsung |

## Tukar ke produksi

Salin `.env.example` ke `.env` dan isi:

```bash
DEMO_MODE=0
AGGREGATOR_API_KEY=...            # hidupkan agregator untuk liputan semua kurier
NINJAVAN_CLIENT_ID=...            # API rasmi (lebih murah untuk volum tinggi)
NINJAVAN_CLIENT_SECRET=...
WEBHOOK_SECRET=rahsia-panjang     # tandatangan HMAC webhook masuk
DB_PATH=/var/lib/jejak/jejak.db
```

Susunan adapter: API rasmi kurier -> agregator -> demo. Enjin cuba ikut turutan
sehingga ada yang pulangkan event, jadi kau boleh pindah dari agregator ke API
rasmi satu kurier pada satu masa tanpa ubah kod lain.

## Struktur

```
src/core/       logik tulen tanpa I/O (detect, normalise, statuses, eta)
src/adapters/   sumber data kurier - tambah kurier baharu di sini sahaja
src/services/   ingest (satu-satunya penulis status), poller, webhook, notify
src/db.js       skema SQLite + store
src/server.js   HTTP + SSE + fail statik
public/         UI
tools/          kurier tiruan dan seeder
test/           53 ujian
```

Semua kod dikomen dalam Bahasa Melayu.
