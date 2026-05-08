/**
 * BONSARI COFFEE — Apps Script v7 (CLEAN REBUILD)
 * =================================================
 * Deployed: 8 Mei 2026
 * Sheet ID: 18IuNt_x08EBgonBgXGZRz6esUnVBI14147iMvlLpgH8
 * Sheet Name: Bonsari_Coffee_Entry_Sync
 *
 * ARCHITECTURE (V1-style, single source of truth)
 * ------------------------------------------------
 * - GB_Movement sheet  = SINGLE SOURCE OF TRUTH for stock per grade per location
 * - Sortasi sheet      = Batch tracking (header info + payment status)
 * - Pengeluaran sheet  = All cash out (incl. auto-generated Sortir payments)
 * - Sales_GB / Sales_RB = Sales transactions (existing, unchanged)
 *
 * STOCK COMPUTATION
 * -----------------
 * Stock per grade per location = SUM(qty_signed) from GB_Movement
 * Total stock GB             = sum where lokasi != 'rb_form'
 * Stock di pekerja per worker = sum where lokasi LIKE 'di_pekerja:%'
 *
 * SORTASI FLOW
 * ------------
 * 1. submit_sortasi_keluar → Insert Sortasi row (status='kirim')
 *                          + 2 GB_Movement rows (di_tempat -, di_pekerja +)
 * 2. submit_sortasi_kembali → Update Sortasi row (status='kembali')
 *                          + 1 GB_Movement (-bakalan from di_pekerja)
 *                          + 4 GB_Movement (+GBP/GBC/GBL/GBS to di_tempat)
 * 3. pay_batches → Update Sortasi rows (ongkos_paid='YES', paid_date)
 *               + 1 Pengeluaran row (kategori='Sortir')
 *
 * BASELINE 5 MEI 2026
 * -------------------
 * Per opname fisik Adib: total 313.97 KG (RB Form excluded from GB stock)
 *   GBO 169.50 · GBP 37.44 · GBC 7.41 · GBL 47.69 · GBS 28.84 (di_tempat)
 *   15.00 KG di_pekerja (grade mix unknown — adjust saat real data masuk)
 *   8.09 KG RB Form (separate)
 */

// ============================================================================
// CONSTANTS
// ============================================================================
const SHEET_ID = '18IuNt_x08EBgonBgXGZRz6esUnVBI14147iMvlLpgH8';
const ONGKOS_RATE_PER_KG = 3000;
const SHEETS = {
  GB_MOVEMENT: 'GB_Movement',
  SORTASI: 'Sortasi',
  PENGELUARAN: 'Pengeluaran',
  SALES_GB: 'Sales_GB',
  SALES_RB: 'Sales_RB',
  LOGBOOK: 'Logbook'
};

const GB_MOVEMENT_HEADERS = [
  'id', 'tanggal_iso', 'source', 'grade', 'qty_signed',
  'lokasi', 'pekerja', 'ref_id', 'catatan', 'created_at'
];

const SORTASI_HEADERS_V7 = [
  'id', 'pekerja', 'batch_status', 'tgl_ambil', 'tgl_setor',
  'bakalan', 'grade_input', 'qty_input',
  'gbp', 'gbc', 'gbl', 'gbs', 'total_setor', 'susut', 'yield_pct',
  'ongkos', 'ongkos_paid', 'paid_date', 'pengeluaran_ref_id', 'created_at'
];

// Baseline 5 Mei 2026 opname
const BASELINE_5MEI = [
  { grade: 'GBO', kg: 169.50, lokasi: 'di_tempat', catatan: 'Opname 5 Mei: 161 bulk + 8.5 kantong kecil' },
  { grade: 'GBP', kg: 37.44,  lokasi: 'di_tempat', catatan: 'Opname 5 Mei: 34.14 sorted + 3.30 bakalan' },
  { grade: 'GBC', kg: 7.41,   lokasi: 'di_tempat', catatan: 'Opname 5 Mei: bakalan pre-sortir' },
  { grade: 'GBL', kg: 47.69,  lokasi: 'di_tempat', catatan: 'Opname 5 Mei: 39.03 + 8.655 (2 lokasi)' },
  { grade: 'GBS', kg: 28.84,  lokasi: 'di_tempat', catatan: 'Opname 5 Mei: 8.775 + 20.060 (2 lokasi)' },
  { grade: 'GBO', kg: 15.00,  lokasi: 'di_pekerja:Unknown', catatan: 'Opname 5 Mei: Sortir Out, grade mix belum diketahui — adjust saat real batch tracked' }
];
// RB Form 8.09 KG NOT included in GB_Movement (already roasted, separate inventory)

// ============================================================================
// MAIN ENTRY POINTS — doGet / doPost
// ============================================================================

function doGet(e) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    // V7 bootstrap: ensure GB_Movement sheet + baseline exists (idempotent)
    if (!ss.getSheetByName(SHEETS.GB_MOVEMENT)) {
      setupBaseline();
    }
    // V7.3: DO NOT auto-migrate in doGet. Historical sortasi batches are already
    // reflected in baseline 5 Mei opname (313.97 KG); re-migrating would double-count.
    // Migration only for NEW batches submitted post-baseline via doPost handlers.
    // Manual reset hook: hit /exec?reset=1 to clear non-baseline movements
    if (e && e.parameter && e.parameter.reset === '1') {
      resetMovementsKeepBaseline();
    }
    const data = {
      gb_movements: readSheet_(ss, SHEETS.GB_MOVEMENT),
      sortasi:      readSheet_(ss, SHEETS.SORTASI),
      pengeluaran:  readSheet_(ss, SHEETS.PENGELUARAN),
      sales_gb:     readSheet_(ss, SHEETS.SALES_GB),
      sales_rb:     readSheet_(ss, SHEETS.SALES_RB),
      logbook:      readSheet_(ss, SHEETS.LOGBOOK)
    };
    // Compute summary
    data.summary = computeStockSummary_(data.gb_movements);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, data: data, ts: new Date().toISOString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message, stack: err.stack }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  // Use getScriptLock (works in standalone scripts; getDocumentLock returns null)
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || body.type || ''; // backwards-compat
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let result;
    switch (action) {
      case 'submit_sortasi_keluar':
      case 'sortasi_keluar':
        result = handleSortasiKeluar_(ss, body);
        break;
      case 'submit_sortasi_kembali':
      case 'sortasi_kembali':
        result = handleSortasiKembali_(ss, body);
        break;
      case 'sortasi':
        // Backwards-compat: Entry Dashboard old format
        if (body.batch_status === 'kirim') {
          result = handleSortasiKeluar_(ss, body);
        } else if (body.batch_status === 'kembali') {
          result = handleSortasiKembaliLegacy_(ss, body);
        }
        break;
      case 'pay_batches':
      case 'update_payment':
        result = handleUpdatePayment_(ss, body);
        break;
      case 'bulk_pay_worker':
        result = handleBulkPayWorker_(ss, body);
        break;
      case 'sales-gb':
      case 'submit_sales_gb':
        result = handleAppendRow_(ss, SHEETS.SALES_GB, body);
        break;
      case 'sales-rb':
      case 'submit_sales_rb':
        result = handleAppendRow_(ss, SHEETS.SALES_RB, body);
        break;
      case 'pengeluaran':
      case 'submit_pengeluaran':
        result = handlePengeluaran_(ss, body);
        break;
      default:
        result = { ok: false, error: 'Unknown action: ' + action };
    }
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message, stack: err.stack }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// HANDLERS — SORTASI
// ============================================================================

/**
 * Mode A: GB Keluar (kirim ke pekerja)
 * Body: { pekerja, tgl_ambil, bakalan, grade_input, qty_input, batch_id? }
 */
function handleSortasiKeluar_(ss, body) {
  const batchId = body.batch_id || body.id || ('SRT_' + Date.now() + '_' + Math.floor(Math.random()*1000));
  const pekerja = body.pekerja || '';
  const tglAmbil = (body.tgl_ambil || '').slice(0,10);
  const bakalan = body.bakalan || '';
  // Determine grade_input from bakalan label
  let gradeInput = body.grade_input || '';
  if (!gradeInput) {
    const b = bakalan.toUpperCase();
    if (b.indexOf('GBP') >= 0) gradeInput = 'GBP';
    else if (b.indexOf('GBC') >= 0) gradeInput = 'GBC';
    else if (b.indexOf('GBL') >= 0 || b.indexOf('LANANG') >= 0) gradeInput = 'GBL';
    else gradeInput = 'GBO'; // default raw
  }
  const qtyInput = parseFloat(body.qty_input || 0);
  if (!pekerja || !tglAmbil || qtyInput <= 0) {
    return { ok: false, error: 'pekerja, tgl_ambil, qty_input wajib' };
  }
  // 1. Insert Sortasi row
  const sortasiSheet = ensureSheet_(ss, SHEETS.SORTASI, SORTASI_HEADERS_V7);
  const sortasiRow = SORTASI_HEADERS_V7.map(h => {
    if (h === 'id') return batchId;
    if (h === 'pekerja') return pekerja;
    if (h === 'batch_status') return 'kirim';
    if (h === 'tgl_ambil') return tglAmbil;
    if (h === 'bakalan') return bakalan;
    if (h === 'grade_input') return gradeInput;
    if (h === 'qty_input') return qtyInput;
    if (h === 'created_at') return new Date().toISOString();
    return '';
  });
  sortasiSheet.appendRow(sortasiRow);
  // 2. Insert GB_Movement: -qty di_tempat
  appendMovement_(ss, {
    tanggal_iso: tglAmbil,
    source: 'sortasi_keluar',
    grade: gradeInput,
    qty_signed: -qtyInput,
    lokasi: 'di_tempat',
    pekerja: pekerja,
    ref_id: batchId,
    catatan: 'Keluar untuk sortir → ' + pekerja
  });
  // 3. Insert GB_Movement: +qty di_pekerja:pekerja
  appendMovement_(ss, {
    tanggal_iso: tglAmbil,
    source: 'sortasi_keluar',
    grade: gradeInput,
    qty_signed: +qtyInput,
    lokasi: 'di_pekerja:' + pekerja,
    pekerja: pekerja,
    ref_id: batchId,
    catatan: 'Diterima ' + pekerja + ' (di tangan)'
  });
  formatAndSortAll_(ss);
  return { ok: true, batch_id: batchId, message: 'Sortasi keluar saved + 2 GB movements created' };
}

/**
 * Mode B: GB Kembali (terima setoran)
 * Body: { batch_id, tgl_setor, gbp, gbc, gbl, gbs, ongkos? }
 * Updates existing Sortasi row + creates 5 GB_Movement entries
 */
function handleSortasiKembali_(ss, body) {
  const batchId = body.batch_id || body.id;
  if (!batchId) return { ok: false, error: 'batch_id wajib (pilih dari list outstanding)' };
  const sortasiSheet = ensureSheet_(ss, SHEETS.SORTASI, SORTASI_HEADERS_V7);
  // Find batch row
  const headers = sortasiSheet.getRange(1,1,1,sortasiSheet.getLastColumn()).getValues()[0];
  const idCol = headers.indexOf('id') + 1;
  if (idCol === 0) return { ok: false, error: 'Sheet Sortasi missing id column' };
  const lastRow = sortasiSheet.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'Sheet Sortasi empty' };
  const ids = sortasiSheet.getRange(2, idCol, lastRow-1, 1).getValues().map(r => r[0]);
  const rowIdx = ids.indexOf(batchId);
  if (rowIdx < 0) return { ok: false, error: 'batch_id ' + batchId + ' tidak ditemukan' };
  const sheetRow = rowIdx + 2;
  // Read existing row to get pekerja & grade_input
  const existing = sortasiSheet.getRange(sheetRow, 1, 1, headers.length).getValues()[0];
  const rowMap = {};
  headers.forEach((h, i) => { rowMap[h] = existing[i]; });
  const pekerja = rowMap.pekerja || '';
  const gradeInput = rowMap.grade_input || 'GBO';
  const qtyInput = parseFloat(rowMap.qty_input) || 0;
  // Output values
  const tglSetor = (body.tgl_setor || '').slice(0,10);
  const gbp = parseFloat(body.gbp || 0);
  const gbc = parseFloat(body.gbc || 0);
  const gbl = parseFloat(body.gbl || 0);
  const gbs = parseFloat(body.gbs || 0);
  const totalSetor = gbp + gbc + gbl + gbs;
  const susut = qtyInput - totalSetor;
  const yieldPct = qtyInput > 0 ? (totalSetor / qtyInput * 100) : 0;
  const ongkos = parseFloat(body.ongkos || ((totalSetor - gbs) * ONGKOS_RATE_PER_KG));
  // Update Sortasi row
  const updates = {
    batch_status: 'kembali',
    tgl_setor: tglSetor,
    gbp: gbp, gbc: gbc, gbl: gbl, gbs: gbs,
    total_setor: totalSetor, susut: susut, yield_pct: yieldPct,
    ongkos: ongkos
  };
  Object.keys(updates).forEach(field => {
    const c = headers.indexOf(field) + 1;
    if (c > 0) sortasiSheet.getRange(sheetRow, c).setValue(updates[field]);
  });
  // GB_Movement: -qty_input from di_pekerja (worker's bakalan was consumed)
  appendMovement_(ss, {
    tanggal_iso: tglSetor,
    source: 'sortasi_kembali',
    grade: gradeInput,
    qty_signed: -qtyInput,
    lokasi: 'di_pekerja:' + pekerja,
    pekerja: pekerja,
    ref_id: batchId,
    catatan: 'Bakalan dikonsumsi (sorted into 4 grades + susut)'
  });
  // 4 GB_Movements: +output to di_tempat
  const outputs = [
    { grade: 'GBP', kg: gbp },
    { grade: 'GBC', kg: gbc },
    { grade: 'GBL', kg: gbl },
    { grade: 'GBS', kg: gbs }
  ];
  outputs.forEach(o => {
    if (o.kg > 0) {
      appendMovement_(ss, {
        tanggal_iso: tglSetor,
        source: 'sortasi_kembali',
        grade: o.grade,
        qty_signed: +o.kg,
        lokasi: 'di_tempat',
        pekerja: pekerja,
        ref_id: batchId,
        catatan: 'Output sortir ' + pekerja + ' (susut ' + susut.toFixed(2) + ' KG)'
      });
    }
  });
  formatAndSortAll_(ss);
  return {
    ok: true, batch_id: batchId,
    message: 'Sortasi kembali saved. Susut: ' + susut.toFixed(2) + ' KG, Ongkos: Rp ' + ongkos
  };
}

/**
 * Backwards-compat handler for legacy Entry Dashboard:
 * old format does NOT pass batch_id (it just submits both kirim+kembali in one go)
 */
function handleSortasiKembaliLegacy_(ss, body) {
  // Step 1: create the keluar batch first
  const keluarResult = handleSortasiKeluar_(ss, body);
  if (!keluarResult.ok) return keluarResult;
  // Step 2: immediately submit kembali for that same batch
  body.batch_id = keluarResult.batch_id;
  return handleSortasiKembali_(ss, body);
}

/**
 * Update payment status for batch(es)
 * Body: { pekerja, updates: [{batchId, paid:true, paid_date, ongkos}] }
 * Auto-creates Pengeluaran row when batch is marked paid
 */
function handleUpdatePayment_(ss, body) {
  const updates = body.updates || [];
  if (!updates.length) return { ok: false, error: 'No updates provided' };
  const pekerja = body.pekerja || '';
  const sortasiSheet = ensureSheet_(ss, SHEETS.SORTASI, SORTASI_HEADERS_V7);
  const headers = sortasiSheet.getRange(1,1,1,sortasiSheet.getLastColumn()).getValues()[0];
  const idCol = headers.indexOf('id') + 1;
  const lastRow = sortasiSheet.getLastRow();
  const ids = sortasiSheet.getRange(2, idCol, lastRow-1, 1).getValues().map(r => r[0]);
  let totalNewlyPaid = 0;
  const newlyPaidBatchIds = [];
  updates.forEach(u => {
    const idx = ids.indexOf(u.batchId);
    if (idx < 0) return;
    const row = idx + 2;
    if (u.paid !== undefined) {
      const paidCol = headers.indexOf('ongkos_paid') + 1;
      if (paidCol > 0) sortasiSheet.getRange(row, paidCol).setValue(u.paid ? 'YES' : 'NO');
      if (u.paid) {
        totalNewlyPaid += parseFloat(u.ongkos || 0);
        newlyPaidBatchIds.push(u.batchId);
      }
    }
    if (u.paid_date) {
      const c = headers.indexOf('paid_date') + 1;
      if (c > 0) sortasiSheet.getRange(row, c).setValue(u.paid_date);
    }
    if (u.ongkos !== undefined) {
      const c = headers.indexOf('ongkos') + 1;
      if (c > 0) sortasiSheet.getRange(row, c).setValue(u.ongkos);
    }
  });
  // Auto-create Pengeluaran row if any paid (skip if body.skip_pengeluaran=true for historical retroactive marking)
  let pengeluaranRefId = null;
  if (totalNewlyPaid > 0 && !body.skip_pengeluaran) {
    const paidDate = (updates.find(u => u.paid_date) || {}).paid_date || new Date().toISOString().slice(0,10);
    pengeluaranRefId = createPengeluaranSortir_(ss, {
      tanggal: paidDate,
      pekerja: pekerja,
      jumlah: totalNewlyPaid,
      batch_ids: newlyPaidBatchIds
    });
    // Link back: update sortasi rows with pengeluaran_ref_id
    const refCol = headers.indexOf('pengeluaran_ref_id') + 1;
    if (refCol > 0 && pengeluaranRefId) {
      newlyPaidBatchIds.forEach(bid => {
        const idx = ids.indexOf(bid);
        if (idx >= 0) sortasiSheet.getRange(idx+2, refCol).setValue(pengeluaranRefId);
      });
    }
  }
  formatAndSortAll_(ss);
  return {
    ok: true,
    updated: updates.length,
    newly_paid: newlyPaidBatchIds.length,
    total_paid: totalNewlyPaid,
    pengeluaran_ref_id: pengeluaranRefId
  };
}

/**
 * Bulk pay all unpaid batches for a worker
 * Body: { pekerja, paid_date? }
 */
function handleBulkPayWorker_(ss, body) {
  const pekerja = body.pekerja || '';
  if (!pekerja) return { ok: false, error: 'pekerja wajib' };
  const sortasiSheet = ensureSheet_(ss, SHEETS.SORTASI, SORTASI_HEADERS_V7);
  const headers = sortasiSheet.getRange(1,1,1,sortasiSheet.getLastColumn()).getValues()[0];
  const lastRow = sortasiSheet.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'Sortasi sheet empty' };
  const data = sortasiSheet.getRange(2, 1, lastRow-1, headers.length).getValues();
  const idCol = headers.indexOf('id');
  const pkjCol = headers.indexOf('pekerja');
  const paidCol = headers.indexOf('ongkos_paid');
  const ongkosCol = headers.indexOf('ongkos');
  const updates = [];
  data.forEach(row => {
    const w = (row[pkjCol] || '').toString().trim().replace(/\s*\([^)]*\)\s*$/, '').trim();
    const isPaid = (row[paidCol] || '').toString().toUpperCase() === 'YES';
    if (w === pekerja && !isPaid) {
      updates.push({
        batchId: row[idCol],
        paid: true,
        paid_date: body.paid_date || new Date().toISOString().slice(0,10),
        ongkos: parseFloat(row[ongkosCol]) || 0
      });
    }
  });
  if (!updates.length) return { ok: true, message: 'No unpaid batches for ' + pekerja };
  return handleUpdatePayment_(ss, { pekerja: pekerja, updates: updates });
}

// ============================================================================
// HANDLERS — PENGELUARAN, SALES (existing flow, keep working)
// ============================================================================

function handlePengeluaran_(ss, body) {
  const sheet = ss.getSheetByName(SHEETS.PENGELUARAN);
  if (!sheet) return { ok: false, error: 'Pengeluaran sheet not found' };
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const row = headers.map(h => {
    if (body[h] !== undefined) return body[h];
    if (h === 'id') return body.id || ('PEN_' + Date.now());
    if (h === 'created_at') return new Date().toISOString();
    return '';
  });
  sheet.appendRow(row);
  // If this is Pembelian Green Bean → also create GB_Movement (masuk GBO di_tempat)
  if (body.kategori && /pembelian.*green.*bean/i.test(body.kategori)) {
    const qty = parseFloat(body.qty || 0);
    if (qty > 0) {
      appendMovement_(ss, {
        tanggal_iso: (body.tanggal || '').slice(0,10),
        source: 'pembelian',
        grade: 'GBO',
        qty_signed: +qty,
        lokasi: 'di_tempat',
        pekerja: '',
        ref_id: body.id || '',
        catatan: 'Pembelian dari ' + (body.supplier || 'unknown') + ' (' + qty + ' KG)'
      });
    }
  }
  formatAndSortAll_(ss);
  return { ok: true, message: 'Pengeluaran saved' };
}

function handleAppendRow_(ss, sheetName, body) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { ok: false, error: sheetName + ' not found' };
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const row = headers.map(h => {
    if (body[h] !== undefined) return body[h];
    if (h === 'id') return body.id || ('TXN_' + Date.now());
    if (h === 'created_at') return new Date().toISOString();
    return '';
  });
  sheet.appendRow(row);
  // If Sales_GB → create GB_Movement (-qty di_tempat from product code)
  if (sheetName === SHEETS.SALES_GB) {
    const qty = parseFloat(body.qty || 0);
    const grade = (body.produk || body.kode || '').toUpperCase();
    if (qty > 0 && ['GBO','GBP','GBC','GBL','GBS'].indexOf(grade) >= 0) {
      appendMovement_(ss, {
        tanggal_iso: (body.tanggal || '').slice(0,10),
        source: 'sales_gb',
        grade: grade,
        qty_signed: -qty,
        lokasi: 'di_tempat',
        pekerja: '',
        ref_id: body.id || '',
        catatan: 'Sales GB ' + grade + ' → ' + (body.customer || '')
      });
    }
  }
  // If Sales_RB → create GB_Movement (-qty_kg × 1.25 from corresponding GB grade)
  if (sheetName === SHEETS.SALES_RB) {
    const qtyKg = parseFloat(body.qty_kg || 0);
    const consumed = qtyKg * 1.25;
    const kode = (body.produk || body.kode || '').toUpperCase();
    let gradeFrom = 'GBP'; // default RBP/RBC/RBL ← GBP
    if (kode === 'GCR') gradeFrom = 'GBS';
    else if (kode === 'GCP') gradeFrom = 'GBO';
    if (consumed > 0) {
      appendMovement_(ss, {
        tanggal_iso: (body.tanggal || '').slice(0,10),
        source: 'sales_rb_roast',
        grade: gradeFrom,
        qty_signed: -consumed,
        lokasi: 'di_tempat',
        pekerja: '',
        ref_id: body.id || '',
        catatan: 'Roasted for ' + kode + ' sales (' + qtyKg + ' KG × 1.25)'
      });
    }
  }
  formatAndSortAll_(ss);
  return { ok: true, message: sheetName + ' row added' };
}

// ============================================================================
// PENGELUARAN AUTO-CREATE for Sortir payment
// ============================================================================
function createPengeluaranSortir_(ss, opts) {
  const sheet = ensureSheet_(ss, SHEETS.PENGELUARAN, [
    'id','tanggal','kategori','deskripsi','total','supplier','qty','harga_per_kg','ref_id','catatan','created_at'
  ]);
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const id = 'PEN_SRT_' + Date.now();
  const desc = 'Bayar sortir ' + opts.pekerja + ' (' + opts.batch_ids.length + ' batch: ' + opts.batch_ids.join(',').slice(0,80) + ')';
  const row = headers.map(h => {
    if (h === 'id') return id;
    if (h === 'tanggal') return opts.tanggal;
    if (h === 'kategori') return 'Sortir';
    if (h === 'deskripsi') return desc;
    if (h === 'total') return opts.jumlah;
    if (h === 'supplier') return opts.pekerja;
    if (h === 'ref_id') return opts.batch_ids.join(',');
    if (h === 'created_at') return new Date().toISOString();
    return '';
  });
  sheet.appendRow(row);
  return id;
}

// ============================================================================
// GB_MOVEMENT helpers
// ============================================================================

function appendMovement_(ss, m) {
  const sheet = ensureSheet_(ss, SHEETS.GB_MOVEMENT, GB_MOVEMENT_HEADERS);
  const id = m.id || ('MV_' + Date.now() + '_' + Math.floor(Math.random()*1000));
  const row = GB_MOVEMENT_HEADERS.map(h => {
    if (h === 'id') return id;
    if (h === 'created_at') return new Date().toISOString();
    return m[h] !== undefined ? m[h] : '';
  });
  sheet.appendRow(row);
  return id;
}

function computeStockSummary_(movements) {
  const stockByGradeLoc = {}; // {grade: {lokasi: kg}}
  const stockByGrade = {};
  const stockByLoc = {};
  let totalGB = 0;
  movements.forEach(m => {
    const grade = (m.grade || '').toUpperCase();
    const lokasi = m.lokasi || 'unknown';
    const qty = parseFloat(m.qty_signed) || 0;
    if (!stockByGradeLoc[grade]) stockByGradeLoc[grade] = {};
    stockByGradeLoc[grade][lokasi] = (stockByGradeLoc[grade][lokasi] || 0) + qty;
    stockByGrade[grade] = (stockByGrade[grade] || 0) + qty;
    stockByLoc[lokasi] = (stockByLoc[lokasi] || 0) + qty;
    if (lokasi !== 'rb_form') totalGB += qty;
  });
  return {
    stock_by_grade: stockByGrade,
    stock_by_location: stockByLoc,
    stock_by_grade_location: stockByGradeLoc,
    total_gb_kg: totalGB
  };
}

// ============================================================================
// SETUP & MIGRATION (manual run from editor)
// ============================================================================

/**
 * Run ONCE after deploy to create GB_Movement sheet + insert baseline rows.
 * Idempotent: clears + re-inserts baseline if already exists.
 */
function setupBaseline() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEETS.GB_MOVEMENT);
  if (sheet) {
    // Clear existing baseline rows only (source='baseline')
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const data = sheet.getRange(2,1,lastRow-1,sheet.getLastColumn()).getValues();
      const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
      const sourceCol = headers.indexOf('source');
      // Delete rows where source='baseline' (iterate from bottom)
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i][sourceCol] === 'baseline') {
          sheet.deleteRow(i + 2);
        }
      }
    }
  } else {
    sheet = ss.insertSheet(SHEETS.GB_MOVEMENT);
    sheet.appendRow(GB_MOVEMENT_HEADERS);
    sheet.getRange(1,1,1,GB_MOVEMENT_HEADERS.length).setFontWeight('bold').setBackground('#1B2A41').setFontColor('#fff');
    sheet.setFrozenRows(1);
  }
  // Insert baseline rows
  const baselineDate = '2026-05-05';
  BASELINE_5MEI.forEach((b, i) => {
    appendMovement_(ss, {
      id: 'MV_BASELINE_' + (i+1).toString().padStart(3,'0'),
      tanggal_iso: baselineDate,
      source: 'baseline',
      grade: b.grade,
      qty_signed: +b.kg,
      lokasi: b.lokasi,
      pekerja: b.lokasi.startsWith('di_pekerja:') ? b.lokasi.replace('di_pekerja:','') : '',
      ref_id: '',
      catatan: b.catatan
    });
  });
  // Format
  sheet.getRange(2,GB_MOVEMENT_HEADERS.indexOf('qty_signed')+1, sheet.getLastRow()-1, 1).setNumberFormat('0.00');
  Logger.log('Baseline setup complete: ' + BASELINE_5MEI.length + ' rows inserted');
  Logger.log('Total stock GB (excluding rb_form): ' + BASELINE_5MEI.reduce((s,b) => s + b.kg, 0).toFixed(2) + ' KG');
  return { ok: true, baseline_rows: BASELINE_5MEI.length };
}

/**
 * Migration: Walk existing Sortasi rows and create matching GB_Movement entries.
 * Run AFTER setupBaseline(). Only processes rows dated >= 2026-05-06 (post-baseline).
 */
function migrateExistingSortasi() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sortasiSheet = ss.getSheetByName(SHEETS.SORTASI);
  if (!sortasiSheet) return { ok: false, error: 'Sortasi sheet not found' };
  const headers = sortasiSheet.getRange(1,1,1,sortasiSheet.getLastColumn()).getValues()[0];
  const lastRow = sortasiSheet.getLastRow();
  if (lastRow < 2) return { ok: true, message: 'Sortasi empty' };
  const data = sortasiSheet.getRange(2,1,lastRow-1,headers.length).getValues();
  const movementSheet = ensureSheet_(ss, SHEETS.GB_MOVEMENT, GB_MOVEMENT_HEADERS);
  // Read existing movements ref_ids to avoid duplicates
  const existingRefs = new Set();
  if (movementSheet.getLastRow() > 1) {
    const mvData = movementSheet.getRange(2,1,movementSheet.getLastRow()-1,GB_MOVEMENT_HEADERS.length).getValues();
    const refCol = GB_MOVEMENT_HEADERS.indexOf('ref_id');
    mvData.forEach(r => { if (r[refCol]) existingRefs.add(r[refCol]); });
  }
  let migrated = 0;
  data.forEach(row => {
    const rowMap = {};
    headers.forEach((h, i) => { rowMap[h] = row[i]; });
    const batchId = rowMap.id;
    if (!batchId || existingRefs.has(batchId)) return; // skip if no id or already migrated
    const tglAmbil = (rowMap.tgl_ambil || '').toString().slice(0,10);
    const tglSetor = (rowMap.tgl_setor || '').toString().slice(0,10);
    if (tglAmbil < '2026-05-06') return; // only post-baseline
    const pekerja = rowMap.pekerja || '';
    const qtyInput = parseFloat(rowMap.qty_input) || 0;
    const bakalan = (rowMap.bakalan || '').toString().toUpperCase();
    let gradeInput = 'GBO';
    if (bakalan.indexOf('GBP') >= 0) gradeInput = 'GBP';
    else if (bakalan.indexOf('GBC') >= 0) gradeInput = 'GBC';
    else if (bakalan.indexOf('LANANG') >= 0 || bakalan.indexOf('GBL') >= 0) gradeInput = 'GBL';
    // Insert KELUAR movements
    if (qtyInput > 0 && tglAmbil) {
      appendMovement_(ss, {
        tanggal_iso: tglAmbil, source: 'sortasi_keluar', grade: gradeInput,
        qty_signed: -qtyInput, lokasi: 'di_tempat', pekerja: pekerja,
        ref_id: batchId, catatan: 'Migration: keluar untuk ' + pekerja
      });
      appendMovement_(ss, {
        tanggal_iso: tglAmbil, source: 'sortasi_keluar', grade: gradeInput,
        qty_signed: +qtyInput, lokasi: 'di_pekerja:' + pekerja, pekerja: pekerja,
        ref_id: batchId, catatan: 'Migration: diterima ' + pekerja
      });
    }
    // If kembali, insert KEMBALI movements
    const isKembali = (rowMap.batch_status === 'kembali') ||
                     (parseFloat(rowMap.total_setor || 0) > 0);
    if (isKembali && tglSetor) {
      appendMovement_(ss, {
        tanggal_iso: tglSetor, source: 'sortasi_kembali', grade: gradeInput,
        qty_signed: -qtyInput, lokasi: 'di_pekerja:' + pekerja, pekerja: pekerja,
        ref_id: batchId, catatan: 'Migration: bakalan dikonsumsi'
      });
      ['gbp','gbc','gbl','gbs'].forEach(g => {
        const kg = parseFloat(rowMap[g]) || 0;
        if (kg > 0) {
          appendMovement_(ss, {
            tanggal_iso: tglSetor, source: 'sortasi_kembali', grade: g.toUpperCase(),
            qty_signed: +kg, lokasi: 'di_tempat', pekerja: pekerja,
            ref_id: batchId, catatan: 'Migration: output sortir'
          });
        }
      });
    }
    migrated++;
  });
  Logger.log('Migrated ' + migrated + ' Sortasi batches to GB_Movement');
  return { ok: true, migrated: migrated };
}

/**
 * RESET: Wipe all GB_Movement rows then re-insert baseline.
 * Fast: uses sheet.clearContents() + appendRow(baseline) instead of per-row delete.
 */
function resetMovementsKeepBaseline() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.GB_MOVEMENT);
  if (!sheet) return { ok:false, err:'GB_Movement not found' };
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    sheet.deleteRows(2, lastRow - 1);
  }
  // Re-insert baseline rows
  const baselineDate = '2026-05-05';
  BASELINE_5MEI.forEach((b, i) => {
    appendMovement_(ss, {
      id: 'MV_BASELINE_' + (i+1).toString().padStart(3,'0'),
      tanggal_iso: baselineDate,
      source: 'baseline',
      grade: b.grade,
      qty_signed: +b.kg,
      lokasi: b.lokasi,
      pekerja: b.lokasi.startsWith('di_pekerja:') ? b.lokasi.replace('di_pekerja:','') : '',
      ref_id: '',
      catatan: b.catatan
    });
  });
  Logger.log('Reset complete: cleared all rows + re-inserted ' + BASELINE_5MEI.length + ' baseline rows');
  return { ok:true, baseline_rows: BASELINE_5MEI.length };
}

/**
 * Backup current Apps Script source — paste output to a safe location.
 * Just logs current Sheet structure for reference.
 */
function backupCurrentState() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheets = ss.getSheets().map(s => ({
    name: s.getName(),
    rows: s.getLastRow(),
    cols: s.getLastColumn(),
    headers: s.getLastRow() > 0 ? s.getRange(1,1,1,s.getLastColumn()).getValues()[0] : []
  }));
  Logger.log(JSON.stringify(sheets, null, 2));
  return sheets;
}

// ============================================================================
// HELPERS
// ============================================================================

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#1B2A41').setFontColor('#fff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const data = sheet.getRange(2,1,lastRow-1,headers.length).getValues();
  return data.map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      let v = row[i];
      // ISO date strings handling
      if (v instanceof Date) v = Utilities.formatDate(v, 'GMT+7', 'yyyy-MM-dd');
      obj[h] = v;
    });
    return obj;
  });
}

function formatAndSortAll_(ss) {
  // Sort newest-first per sheet
  [SHEETS.GB_MOVEMENT, SHEETS.SORTASI, SHEETS.PENGELUARAN, SHEETS.SALES_GB, SHEETS.SALES_RB].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) return;
    const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
    let dateCol = headers.indexOf('tanggal_iso');
    if (dateCol < 0) dateCol = headers.indexOf('tanggal');
    if (dateCol < 0) dateCol = headers.indexOf('tgl_ambil');
    if (dateCol < 0) dateCol = headers.indexOf('created_at');
    if (dateCol >= 0) {
      sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn())
           .sort({column: dateCol+1, ascending: false});
    }
  });
}
