# Bonsari Coffee Monitor

Dashboard sistem monitoring untuk Bonsari Coffee — penjualan, HPP, sortasi, stock, akuntansi.

## 🌐 Live URLs

| Dashboard | URL | Purpose |
|---|---|---|
| **Reading Dashboard** | https://adib-psych.github.io/bonsari-coffee-monitor/ | Laporan + analytics |
| **Entry Dashboard** | https://adib-psych.github.io/bonsari-coffee-monitor/entry.html | Input transaksi harian |
| **Setup Wizard** | https://adib-psych.github.io/bonsari-coffee-monitor/setup.html | One-time setup guide |

## 🏗️ Arsitektur

- **Frontend**: Static HTML hosted di GitHub Pages
- **Backend**: Google Sheets + Apps Script Web App
- **Storage**: Google Sheets (bonsaricoffee@gmail.com)
- **Offline**: localStorage cache fallback

## 🎨 Design

- **Color Palette**: Plum & Latte (deep plum + caramel accent)
- **Layout**: Sidebar navigation
- **Logo**: Bonsari Coffee Robusta

## 📋 Features

### Reading Dashboard
- KPI overview (Sales, Profit, Stock, BEP, Pengeluaran)
- Penjualan GB & RB/GC tables
- HPP Reference (locked v2.1, 5 Mei 2026)
- Pengeluaran tracking by kategori
- LogBook GB dengan HERO Stock per Grade
- Sortasi summary (66 batch reconciled)
- Akuntansi (Neraca + P&L + Cash Position)
- Auto-refresh from Google Sheets

### Entry Dashboard
- 5 entry types: Sales GB, Sales RB & GC, Pengeluaran, Sortasi, Adjustment
- Auto-fill harga based on customer type (Retail/Reseller)
- Live stock validation
- Quick-pick price chips
- Auto-sync ke Google Sheets per submit
- Customer database management
- Worker tracking untuk Sortasi (Mba Etsa/Pipit + paid/unpaid status)
- Auto-sync Sortasi → LogBook GB stock movements

## 🔧 Setup

Lihat [Setup Wizard](setup.html) untuk panduan step-by-step (~15 menit).

## 📊 Data Coverage

- Period: Oktober 2025 – April 2026
- Total Stock Ownership: 313.97 KG (verified opname)
- HPP: Locked v2.1 (5 Mei 2026)
- Pricelist: Maret 2026 (retail + reseller)
- Modal Awal: Rp 77.750.000

## 📝 Version History

- **v2.0** (7 Mei 2026): Full rebuild — Plum palette, sidebar, Google Sheets sync
- **v1.x** (Apr 2026): Firebase-based dashboard (deprecated, archived)

## 🤝 Maintainer

Adib Asrori · asroriadib@gmail.com · bonsaricoffee@gmail.com (Google Sheets owner)

Last update: 7 Mei 2026
