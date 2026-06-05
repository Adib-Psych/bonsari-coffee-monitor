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
  LOGBOOK: 'Logbook',
  NOTA: 'Nota',
  NOTA_MISC: 'Nota_Misc',
  PRODUKSI: 'Produksi'  // V8.9 — Phase 2 panen 2026
};

const NOTA_HEADERS = [
  'id', 'tanggal', 'customer', 'customer_type',
  'subtotal', 'diskon', 'total', 'dp_paid', 'sisa',
  'status_payment', 'paid_date', 'metode_bayar', 'catatan',
  'item_count', 'created_at'
];

const NOTA_MISC_HEADERS = [
  'id', 'nota_id', 'tanggal', 'customer', 'customer_type',
  'label', 'qty', 'harga_per_pack', 'total_sales',
  'catatan', 'created_at'
];

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

// V8.9 — PRODUKSI Roasting tracking (Phase 2, panen 2026)
const PRODUKSI_HEADERS = [
  'id', 'tanggal_ambil', 'source_grade', 'qty_input_kg', 'target_produk',
  'expected_output_kg', 'expected_susut_pct',
  'tanggal_kembali', 'actual_output_kg', 'actual_susut_pct', 'susut_variance',
  'vendor_roastery', 'biaya_roasting_per_kg', 'biaya_roasting_total', 'biaya_packaging',
  'status', 'pengeluaran_ref_id', 'catatan', 'created_at'
];

// PROD_MAP: source GB grade → target produk, expected susut, tolerance window
// Locked per DESIGN_SPEC_Produksi_Tab_5Juni2026.md (industri benchmark Vienna roast ~20%)
const PROD_MAP = {
  'GBP': { target: 'RBP', susut_pct: 0.20, tol_low: 0.15, tol_high: 0.25 },
  'GBC': { target: 'RBC', susut_pct: 0.20, tol_low: 0.15, tol_high: 0.25 },
  'GBL': { target: 'RBL', susut_pct: 0.20, tol_low: 0.15, tol_high: 0.25 },
  'GBS': { target: 'GC',  susut_pct: 0.28, tol_low: 0.23, tol_high: 0.33 }, // combined roast+grind
  'SIG': { target: 'RBSig', susut_pct: 0.20, tol_low: 0.15, tol_high: 0.25 } // GB Signature dari kebun wakaf
};

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
    // V8 bootstrap: ensure Nota sheet exists
    if (!ss.getSheetByName(SHEETS.NOTA)) {
      ensureSheet_(ss, SHEETS.NOTA, NOTA_HEADERS);
    }
    // Nota single fetch — for print viewer
    if (e && e.parameter && e.parameter.nota) {
      return ContentService
        .createTextOutput(JSON.stringify(getNotaDetail_(ss, e.parameter.nota)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // V7.3: DO NOT auto-migrate in doGet. Historical sortasi batches are already
    // reflected in baseline 5 Mei opname (313.97 KG); re-migrating would double-count.
    // Migration only for NEW batches submitted post-baseline via doPost handlers.
    // Manual reset hook: hit /exec?reset=1 to clear non-baseline movements
    if (e && e.parameter && e.parameter.reset === '1') {
      resetMovementsKeepBaseline();
    }
    // Cleanup orphan movements: hit /exec?cleanup_orphans=1 to delete movements
    // where ref_id doesn't exist in Sortasi sheet (e.g., batch was deleted manually)
    if (e && e.parameter && e.parameter.cleanup_orphans === '1') {
      cleanupOrphanMovements();
    }
    // Audit & auto-fix: hit /exec?audit_fix=1 to recalc all kembali batches'
    // yield_pct (decimal), ongkos (auto-calc if missing), susut (qty-setor)
    if (e && e.parameter && e.parameter.audit_fix === '1') {
      auditFixBatchData();
    }
    const data = {
      gb_movements: readSheet_(ss, SHEETS.GB_MOVEMENT),
      sortasi:      readSheet_(ss, SHEETS.SORTASI),
      pengeluaran:  readSheet_(ss, SHEETS.PENGELUARAN),
      sales_gb:     readSheet_(ss, SHEETS.SALES_GB),
      sales_rb:     readSheet_(ss, SHEETS.SALES_RB),
      logbook:      readSheet_(ss, SHEETS.LOGBOOK),
      nota:         readSheet_(ss, SHEETS.NOTA),
      produksi:     readSheet_(ss, SHEETS.PRODUKSI)  // V8.9 Phase 2
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
      case 'update_sales_row':
        result = handleUpdateSalesRow_(ss, body);
        break;
      case 'submit_nota':
        result = handleSubmitNota_(ss, body);
        break;
      case 'update_nota_status':
        result = handleUpdateNotaStatus_(ss, body);
        break;
      case 'edit_nota_header':
        result = handleEditNotaHeader_(ss, body);
        break;
      case 'edit_nota_full':
        result = handleEditNotaFull_(ss, body);
        break;
      case 'delete_nota':
        result = handleDeleteNota_(ss, body);
        break;
      // V8.9 — Produksi Roasting (Phase 2 panen 2026)
      case 'submit_produksi_ambil':
      case 'produksi_ambil':
        result = handleSubmitProduksiAmbil_(ss, body);
        break;
      case 'submit_produksi_selesai':
      case 'produksi_selesai':
        result = handleSubmitProduksiSelesai_(ss, body);
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
  // V7.9: store yield_pct as DECIMAL (e.g., 1.035 = 103.5%) — consistent with historical convention.
  // Reading Dashboard renders as (yield_pct * 100).toFixed(1)+'%'
  const yieldPct = qtyInput > 0 ? (totalSetor / qtyInput) : 0;
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

/**
 * Update one sales row (Sales_GB or Sales_RB) by id with arbitrary field updates.
 * Body: { sheet: 'Sales_GB' | 'Sales_RB', row_id, updates: {pack, packs, harga_per_pack, total_sales, ...} }
 */
function handleUpdateSalesRow_(ss, body) {
  const sheetName = body.sheet || SHEETS.SALES_RB;
  const rowId = body.row_id || body.id;
  const updates = body.updates || {};
  if (!rowId) return { ok:false, error:'row_id wajib' };
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { ok:false, error: sheetName + ' not found' };
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const idCol = headers.indexOf('id');
  if (idCol < 0) return { ok:false, error: 'id column not found in ' + sheetName };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok:false, error: 'sheet empty' };
  const ids = sheet.getRange(2, idCol+1, lastRow-1, 1).getValues().map(r => r[0]);
  const idx = ids.indexOf(rowId);
  if (idx < 0) return { ok:false, error: 'row_id ' + rowId + ' not found' };
  const sheetRow = idx + 2;
  let updatedFields = 0;
  Object.keys(updates).forEach(field => {
    const c = headers.indexOf(field);
    if (c >= 0) {
      sheet.getRange(sheetRow, c+1).setValue(updates[field]);
      updatedFields++;
    }
  });
  return { ok:true, sheet: sheetName, row_id: rowId, updated_fields: updatedFields };
}

// ============================================================================
// NOTA / INVOICE — V8 (10 Mei 2026)
// ============================================================================

/**
 * Generate Nota ID format BC-YYYY-NNNN (4-digit sequential per year).
 * Scan existing Nota sheet for max NNN this year, increment.
 */
function generateNotaId_(ss) {
  const year = new Date().getFullYear();
  const prefix = 'BC-' + year + '-';
  const sheet = ensureSheet_(ss, SHEETS.NOTA, NOTA_HEADERS);
  const lastRow = sheet.getLastRow();
  let maxN = 0;
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    ids.forEach(r => {
      const id = (r[0] || '').toString();
      if (id.startsWith(prefix)) {
        const n = parseInt(id.substring(prefix.length), 10);
        if (!isNaN(n) && n > maxN) maxN = n;
      }
    });
  }
  const next = (maxN + 1).toString().padStart(4, '0');
  return prefix + next;
}

/**
 * Submit Nota with multiple items.
 * Body: {
 *   tanggal, customer, customer_type, items: [{type:'gb'|'rb', produk, pack, packs, qty_kg, harga_per_pack, ...}],
 *   diskon?, dp_paid?, status_payment, metode_bayar?, catatan?
 * }
 */
function handleSubmitNota_(ss, body) {
  const items = body.items || [];
  if (!items.length) return { ok: false, error: 'items wajib min 1' };
  const customer = body.customer || '';
  const customerType = body.customer_type || 'Retail';
  const tanggal = (body.tanggal || new Date().toISOString().slice(0, 10));
  const diskon = parseFloat(body.diskon || 0);
  const dpPaid = parseFloat(body.dp_paid || 0);
  const metodeBayar = body.metode_bayar || '';
  const catatan = body.catatan || '';
  const statusPayment = (body.status_payment || 'UNPAID').toUpperCase();

  const notaId = generateNotaId_(ss);
  let subtotal = 0;
  const insertedIds = [];

  // Insert each item to Sales_GB / Sales_RB / Nota_Misc with nota_id
  items.forEach((it, idx) => {
    const type = (it.type || '').toLowerCase();
    const itemId = it.id || ('NTI_' + Date.now() + '_' + idx);
    const lineSales = parseFloat(it.total_sales || 0) || (parseFloat(it.harga_per_pack || it.harga_per_kg || 0) * parseFloat(it.packs || it.qty || 1));
    subtotal += lineSales;
    if (type === 'sales-misc' || type === 'misc' || type === 'custom') {
      // Custom / Misc items (ongkir, merchandise, sample, etc) → Nota_Misc sheet
      const sheet = ensureSheet_(ss, SHEETS.NOTA_MISC, NOTA_MISC_HEADERS);
      const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
      const row = headers.map(h => {
        if (h === 'id') return itemId;
        if (h === 'nota_id') return notaId;
        if (h === 'tanggal') return tanggal;
        if (h === 'customer') return customer;
        if (h === 'customer_type') return customerType;
        if (h === 'label') return it.label || it.custom_label || it.produk || 'Misc';
        if (h === 'qty') return parseFloat(it.qty || it.packs || 1);
        if (h === 'harga_per_pack') return parseFloat(it.harga_per_pack || 0);
        if (h === 'total_sales') return lineSales;
        if (h === 'catatan') return it.catatan || '';
        if (h === 'created_at') return new Date().toISOString();
        return '';
      });
      sheet.appendRow(row);
      insertedIds.push({ sheet: 'Nota_Misc', id: itemId });
    } else if (type === 'sales-gb' || type === 'gb') {
      const sheet = ensureSheetWithColumn_(ss, SHEETS.SALES_GB, 'nota_id');
      const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
      const row = headers.map(h => {
        if (h === 'id') return itemId;
        if (h === 'nota_id') return notaId;
        if (h === 'created') return new Date().toISOString();
        if (h === 'tanggal') return tanggal;
        if (h === 'customer') return customer;
        if (h === 'customer_type') return customerType;
        if (h === 'type') return 'sales-gb';
        if (h === 'status') return 'synced';
        if (h === 'synced_at') return new Date().toISOString();
        return it[h] !== undefined ? it[h] : '';
      });
      sheet.appendRow(row);
      insertedIds.push({ sheet: 'Sales_GB', id: itemId });
    } else {
      const sheet = ensureSheetWithColumn_(ss, SHEETS.SALES_RB, 'nota_id');
      const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
      const row = headers.map(h => {
        if (h === 'id') return itemId;
        if (h === 'nota_id') return notaId;
        if (h === 'created') return new Date().toISOString();
        if (h === 'tanggal') return tanggal;
        if (h === 'customer') return customer;
        if (h === 'customer_type') return customerType;
        if (h === 'type') return 'sales-rb';
        if (h === 'status') return 'synced';
        if (h === 'synced_at') return new Date().toISOString();
        return it[h] !== undefined ? it[h] : '';
      });
      sheet.appendRow(row);
      insertedIds.push({ sheet: 'Sales_RB', id: itemId });
    }
  });

  const total = subtotal - diskon;
  const sisa = total - dpPaid;
  // Auto-determine status if not explicit
  let finalStatus = statusPayment;
  if (statusPayment === 'UNPAID' && dpPaid > 0 && dpPaid < total) finalStatus = 'PARTIAL';
  if (statusPayment === 'UNPAID' && dpPaid >= total) finalStatus = 'PAID';
  if (finalStatus === 'PAID') {
    // ensure dp_paid = total
    body.dp_paid = total;
  }
  const paidDate = finalStatus === 'PAID' ? tanggal : (body.paid_date || '');

  // Insert Nota header row
  const notaSheet = ensureSheet_(ss, SHEETS.NOTA, NOTA_HEADERS);
  const notaRow = NOTA_HEADERS.map(h => {
    if (h === 'id') return notaId;
    if (h === 'tanggal') return tanggal;
    if (h === 'customer') return customer;
    if (h === 'customer_type') return customerType;
    if (h === 'subtotal') return subtotal;
    if (h === 'diskon') return diskon;
    if (h === 'total') return total;
    if (h === 'dp_paid') return finalStatus === 'PAID' ? total : dpPaid;
    if (h === 'sisa') return finalStatus === 'PAID' ? 0 : sisa;
    if (h === 'status_payment') return finalStatus;
    if (h === 'paid_date') return paidDate;
    if (h === 'metode_bayar') return metodeBayar;
    if (h === 'catatan') return catatan;
    if (h === 'item_count') return items.length;
    if (h === 'created_at') return new Date().toISOString();
    return '';
  });
  notaSheet.appendRow(notaRow);

  return {
    ok: true,
    nota_id: notaId,
    total: total,
    subtotal: subtotal,
    diskon: diskon,
    dp_paid: finalStatus === 'PAID' ? total : dpPaid,
    sisa: finalStatus === 'PAID' ? 0 : sisa,
    status: finalStatus,
    items_count: items.length,
    items_inserted: insertedIds
  };
}

/**
 * Update Nota status (PAID/PARTIAL/UNPAID) + optionally add DP payment.
 * Body: { nota_id, status_payment?, dp_paid?, paid_date?, metode_bayar?, catatan? }
 */
function handleUpdateNotaStatus_(ss, body) {
  const notaId = body.nota_id;
  if (!notaId) return { ok: false, error: 'nota_id wajib' };
  const sheet = ensureSheet_(ss, SHEETS.NOTA, NOTA_HEADERS);
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'Nota sheet empty' };
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => r[0]);
  const idx = ids.indexOf(notaId);
  if (idx < 0) return { ok: false, error: 'nota_id ' + notaId + ' not found' };
  const sheetRow = idx + 2;
  const currentRow = sheet.getRange(sheetRow, 1, 1, headers.length).getValues()[0];
  const rowMap = {};
  headers.forEach((h, i) => { rowMap[h] = currentRow[i]; });
  const total = parseFloat(rowMap.total) || 0;
  let newDp = parseFloat(rowMap.dp_paid) || 0;
  if (body.dp_paid !== undefined) {
    newDp = parseFloat(body.dp_paid);
  } else if (body.add_dp !== undefined) {
    newDp += parseFloat(body.add_dp);
  }
  const sisa = Math.max(0, total - newDp);
  let newStatus = body.status_payment || rowMap.status_payment;
  if (newDp >= total - 0.01) newStatus = 'PAID';
  else if (newDp > 0) newStatus = 'PARTIAL';
  else newStatus = 'UNPAID';
  const paidDate = newStatus === 'PAID' ? (body.paid_date || new Date().toISOString().slice(0, 10)) : (rowMap.paid_date || '');
  // Write updates
  const updates = {
    dp_paid: newDp,
    sisa: sisa,
    status_payment: newStatus,
    paid_date: paidDate,
    metode_bayar: body.metode_bayar || rowMap.metode_bayar || ''
  };
  if (body.catatan !== undefined) updates.catatan = body.catatan;
  Object.keys(updates).forEach(field => {
    const c = headers.indexOf(field) + 1;
    if (c > 0) sheet.getRange(sheetRow, c).setValue(updates[field]);
  });
  return { ok: true, nota_id: notaId, status: newStatus, dp_paid: newDp, sisa: sisa, total: total };
}

/**
 * Get full Nota detail (header + line items) for print preview.
 */
function getNotaDetail_(ss, notaId) {
  const notaSheet = ensureSheet_(ss, SHEETS.NOTA, NOTA_HEADERS);
  const nHeaders = notaSheet.getRange(1,1,1,notaSheet.getLastColumn()).getValues()[0];
  const lastRow = notaSheet.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'Nota empty' };
  const ids = notaSheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => r[0]);
  const idx = ids.indexOf(notaId);
  if (idx < 0) return { ok: false, error: 'nota_id not found' };
  const row = notaSheet.getRange(idx + 2, 1, 1, nHeaders.length).getValues()[0];
  const header = {};
  nHeaders.forEach((h, i) => {
    let v = row[i];
    if (v instanceof Date) v = Utilities.formatDate(v, 'GMT+7', 'yyyy-MM-dd');
    header[h] = v;
  });
  // Fetch line items from Sales_GB + Sales_RB + Nota_Misc where nota_id matches
  const items = [];
  ['SALES_GB','SALES_RB','NOTA_MISC'].forEach(sn => {
    const sheet = ss.getSheetByName(SHEETS[sn]);
    if (!sheet) return;
    const sHeaders = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
    const notaCol = sHeaders.indexOf('nota_id');
    if (notaCol < 0) return;
    const lr = sheet.getLastRow();
    if (lr < 2) return;
    const data = sheet.getRange(2,1,lr-1,sHeaders.length).getValues();
    data.forEach(r => {
      if (r[notaCol] === notaId) {
        const obj = {};
        sHeaders.forEach((h, i) => {
          let v = r[i];
          if (v instanceof Date) v = Utilities.formatDate(v, 'GMT+7', 'yyyy-MM-dd');
          obj[h] = v;
        });
        obj._sheet = sn;
        items.push(obj);
      }
    });
  });
  return { ok: true, header: header, items: items };
}

/**
 * Helper: ensure a column exists in a sheet (append column if missing).
 */
function ensureSheetWithColumn_(ss, sheetName, colName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return null;
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf(colName) < 0) {
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue(colName).setFontWeight('bold').setBackground('#1B2A41').setFontColor('#fff');
  }
  return sheet;
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
 * AUDIT & AUTO-FIX: Walk Sortasi sheet, recompute yield_pct (DECIMAL), ongkos, susut
 * for all kembali batches. Normalize inconsistent data.
 */
function auditFixBatchData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.SORTASI);
  if (!sheet) return { ok:false };
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok:true, fixed:0 };
  const data = sheet.getRange(2,1,lastRow-1,headers.length).getValues();
  const col = (name) => headers.indexOf(name);
  const cQty = col('qty_input'), cSetor = col('total_setor'), cYield = col('yield_pct');
  const cOngkos = col('ongkos'), cSusut = col('susut'), cGbs = col('gbs'), cStatus = col('batch_status');
  let fixed = 0;
  data.forEach((row, idx) => {
    const sheetRow = idx + 2;
    const qty = parseFloat(row[cQty]) || 0;
    const setor = parseFloat(row[cSetor]) || 0;
    if (qty <= 0 || setor <= 0) return; // not a kembali with data
    const gbs = parseFloat(row[cGbs]) || 0;
    // Normalize yield_pct to DECIMAL form
    const correctYield = setor / qty;
    const currentYield = parseFloat(row[cYield]) || 0;
    if (Math.abs(currentYield - correctYield) > 0.001) {
      sheet.getRange(sheetRow, cYield+1).setValue(correctYield);
      fixed++;
    }
    // Recompute ongkos if missing
    const correctOngkos = (setor - gbs) * ONGKOS_RATE_PER_KG;
    const currentOngkos = parseFloat(row[cOngkos]) || 0;
    if (currentOngkos === 0 && correctOngkos > 0) {
      sheet.getRange(sheetRow, cOngkos+1).setValue(correctOngkos);
      fixed++;
    }
    // Recompute susut if empty
    const correctSusut = qty - setor;
    const currentSusutRaw = row[cSusut];
    if (currentSusutRaw === '' || currentSusutRaw === null || currentSusutRaw === undefined) {
      sheet.getRange(sheetRow, cSusut+1).setValue(correctSusut);
      fixed++;
    }
  });
  Logger.log('Audit & fix complete: ' + fixed + ' field(s) updated');
  return { ok:true, fixed: fixed };
}

/**
 * CLEANUP: Delete movements where ref_id is set but doesn't exist in Sortasi sheet.
 * Useful when batches are manually deleted from Sortasi but movements remain orphan.
 */
function cleanupOrphanMovements() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const movSheet = ss.getSheetByName(SHEETS.GB_MOVEMENT);
  const sortasiSheet = ss.getSheetByName(SHEETS.SORTASI);
  if (!movSheet || !sortasiSheet) return { ok:false, err:'sheets missing' };
  // Get all valid batch IDs from Sortasi
  const sortHeaders = sortasiSheet.getRange(1,1,1,sortasiSheet.getLastColumn()).getValues()[0];
  const sortIdCol = sortHeaders.indexOf('id');
  const validIds = new Set();
  if (sortasiSheet.getLastRow() > 1) {
    const sortIds = sortasiSheet.getRange(2, sortIdCol+1, sortasiSheet.getLastRow()-1, 1).getValues();
    sortIds.forEach(r => { if (r[0]) validIds.add(r[0]); });
  }
  // Walk movements, find orphans (ref_id set but not in validIds, AND source is sortasi-related)
  const movHeaders = movSheet.getRange(1,1,1,movSheet.getLastColumn()).getValues()[0];
  const refCol = movHeaders.indexOf('ref_id');
  const sourceCol = movHeaders.indexOf('source');
  const lastRow = movSheet.getLastRow();
  if (lastRow < 2) return { ok:true, deleted:0 };
  const data = movSheet.getRange(2, 1, lastRow-1, movHeaders.length).getValues();
  const orphanRows = [];
  for (let i = data.length - 1; i >= 0; i--) {
    const refId = data[i][refCol];
    const source = (data[i][sourceCol] || '').toString();
    // Only check sortasi_keluar / sortasi_kembali movements (have ref_id pointing to Sortasi batches)
    if (refId && /^sortasi_/.test(source) && !validIds.has(refId)) {
      orphanRows.push(i + 2);
    }
  }
  // Delete in bottom-up order
  orphanRows.sort((a,b) => b - a).forEach(rowIdx => movSheet.deleteRow(rowIdx));
  Logger.log('Cleanup orphan movements: ' + orphanRows.length + ' rows deleted');
  return { ok:true, deleted: orphanRows.length };
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

/**
 * V8.4 — Edit nota header (customer, tanggal, catatan).
 * Body: { nota_id, customer?, tanggal?, catatan?, customer_type? }
 * Does NOT touch items or totals. For full edit, use delete + re-submit.
 */
function handleEditNotaHeader_(ss, body) {
  const notaId = body.nota_id;
  if (!notaId) return { ok: false, error: 'nota_id wajib' };
  const sheet = ss.getSheetByName(SHEETS.NOTA);
  if (!sheet) return { ok: false, error: 'Nota sheet not found' };
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const lr = sheet.getLastRow();
  if (lr < 2) return { ok: false, error: 'Nota sheet empty' };
  const ids = sheet.getRange(2, 1, lr-1, 1).getValues().map(r => r[0]);
  const idx = ids.indexOf(notaId);
  if (idx < 0) return { ok: false, error: 'nota_id ' + notaId + ' not found' };
  const sheetRow = idx + 2;
  const updates = [];
  const fields = ['customer', 'customer_type', 'tanggal', 'catatan'];
  fields.forEach(field => {
    if (body[field] !== undefined && body[field] !== null) {
      const colIdx = headers.indexOf(field);
      if (colIdx >= 0) {
        sheet.getRange(sheetRow, colIdx + 1).setValue(body[field]);
        updates.push(field + '=' + body[field]);
      }
    }
  });
  return { ok: true, nota_id: notaId, updated: updates };
}

/**
 * V8.4 — Delete nota + all linked rows (Sales_GB, Sales_RB, Nota_Misc).
 * Body: { nota_id, confirm: 'YES_DELETE_' + nota_id }
 * Safety: requires confirm token to prevent accidental delete.
 */
function handleDeleteNota_(ss, body) {
  const notaId = body.nota_id;
  if (!notaId) return { ok: false, error: 'nota_id wajib' };
  const expectedConfirm = 'YES_DELETE_' + notaId;
  if (body.confirm !== expectedConfirm) {
    return { ok: false, error: 'confirm token salah. Expected: ' + expectedConfirm };
  }
  const report = [];
  // 1. Delete Nota header row
  const notaSheet = ss.getSheetByName(SHEETS.NOTA);
  if (notaSheet) {
    const lr = notaSheet.getLastRow();
    if (lr >= 2) {
      const ids = notaSheet.getRange(2, 1, lr-1, 1).getValues().map(r => r[0]);
      const idx = ids.indexOf(notaId);
      if (idx >= 0) {
        notaSheet.deleteRow(idx + 2);
        report.push('Nota header deleted');
      } else {
        report.push('Nota header not found');
      }
    }
  }
  // 2. Delete linked rows in Sales_GB, Sales_RB, Nota_Misc
  ['SALES_GB', 'SALES_RB', 'NOTA_MISC'].forEach(sn => {
    const sh = ss.getSheetByName(SHEETS[sn]);
    if (!sh) return;
    const sHeaders = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    const notaCol = sHeaders.indexOf('nota_id');
    if (notaCol < 0) return;
    const lr = sh.getLastRow();
    if (lr < 2) return;
    const data = sh.getRange(2, notaCol+1, lr-1, 1).getValues();
    const rowsToDelete = [];
    data.forEach((row, i) => { if (row[0] === notaId) rowsToDelete.push(i + 2); });
    rowsToDelete.reverse().forEach(r => sh.deleteRow(r));
    if (rowsToDelete.length > 0) report.push(sn + ': deleted ' + rowsToDelete.length);
  });
  return { ok: true, nota_id: notaId, result: report.join(' | ') };
}

/**
 * V8.5 — FULL edit nota: header + items (replace) + payment, atomic.
 * Body: {
 *   nota_id,
 *   confirm: 'YES_EDIT_' + nota_id,            // safety token
 *   header: { customer?, customer_type?, tanggal?, catatan? },
 *   items:  [ { type:'sales-gb'|'sales-rb'|'sales-misc', produk/label, qty/packs, harga_per_kg/harga_per_pack, total_sales?, catatan? }, ... ],
 *   payment:{ status_payment?, dp_paid?, metode_bayar?, paid_date?, diskon? }
 * }
 * Strategy: delete all linked rows in Sales_GB/Sales_RB/Nota_Misc, re-insert from items array,
 *           recompute subtotal/total/sisa, update Nota header fields atomically.
 */
function handleEditNotaFull_(ss, body) {
  const notaId = body.nota_id;
  if (!notaId) return { ok: false, error: 'nota_id wajib' };
  const expectedConfirm = 'YES_EDIT_' + notaId;
  if (body.confirm !== expectedConfirm) {
    return { ok: false, error: 'confirm token salah. Expected: ' + expectedConfirm };
  }
  const items = body.items || [];
  if (!items.length) return { ok: false, error: 'items wajib min 1 (untuk hapus pakai delete_nota)' };

  const notaSheet = ss.getSheetByName(SHEETS.NOTA);
  if (!notaSheet) return { ok: false, error: 'Nota sheet not found' };
  const nHeaders = notaSheet.getRange(1,1,1,notaSheet.getLastColumn()).getValues()[0];
  const lr = notaSheet.getLastRow();
  if (lr < 2) return { ok: false, error: 'Nota sheet empty' };
  const ids = notaSheet.getRange(2, 1, lr-1, 1).getValues().map(r => r[0]);
  const idx = ids.indexOf(notaId);
  if (idx < 0) return { ok: false, error: 'nota_id ' + notaId + ' not found' };
  const sheetRow = idx + 2;
  const currentRow = notaSheet.getRange(sheetRow, 1, 1, nHeaders.length).getValues()[0];
  const currentMap = {};
  nHeaders.forEach((h, i) => { currentMap[h] = currentRow[i]; });

  const header = body.header || {};
  const payment = body.payment || {};
  const customer = header.customer !== undefined ? header.customer : currentMap.customer;
  const customerType = header.customer_type !== undefined ? header.customer_type : currentMap.customer_type;
  const tanggal = header.tanggal !== undefined ? header.tanggal : (currentMap.tanggal instanceof Date ? Utilities.formatDate(currentMap.tanggal,'GMT+7','yyyy-MM-dd') : currentMap.tanggal);
  const catatan = header.catatan !== undefined ? header.catatan : (currentMap.catatan || '');

  const report = [];

  // 1. DELETE all existing linked items
  ['SALES_GB', 'SALES_RB', 'NOTA_MISC'].forEach(sn => {
    const sh = ss.getSheetByName(SHEETS[sn]);
    if (!sh) return;
    const sHeaders = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    const notaCol = sHeaders.indexOf('nota_id');
    if (notaCol < 0) return;
    const slr = sh.getLastRow();
    if (slr < 2) return;
    const data = sh.getRange(2, notaCol+1, slr-1, 1).getValues();
    const rowsToDelete = [];
    data.forEach((row, i) => { if (row[0] === notaId) rowsToDelete.push(i + 2); });
    rowsToDelete.reverse().forEach(r => sh.deleteRow(r));
    if (rowsToDelete.length > 0) report.push(sn + ' deleted ' + rowsToDelete.length);
  });

  // 2. RE-INSERT items, compute subtotal
  let subtotal = 0;
  const insertedIds = [];
  items.forEach((it, i) => {
    const type = (it.type || '').toLowerCase();
    const itemId = it.id || ('NTI_' + Date.now() + '_' + i);
    const qty = parseFloat(it.qty || it.packs || 1) || 1;
    const harga = parseFloat(it.harga_per_pack || it.harga_per_kg || 0) || 0;
    const lineSales = parseFloat(it.total_sales) || (harga * qty);
    subtotal += lineSales;

    if (type === 'sales-misc' || type === 'misc' || type === 'custom') {
      const sheet = ensureSheet_(ss, SHEETS.NOTA_MISC, NOTA_MISC_HEADERS);
      const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
      const row = headers.map(h => {
        if (h === 'id') return itemId;
        if (h === 'nota_id') return notaId;
        if (h === 'tanggal') return tanggal;
        if (h === 'customer') return customer;
        if (h === 'customer_type') return customerType;
        if (h === 'label') return it.label || it.produk || 'Misc';
        if (h === 'qty') return qty;
        if (h === 'harga_per_pack') return harga;
        if (h === 'total_sales') return lineSales;
        if (h === 'catatan') return it.catatan || '';
        if (h === 'created_at') return new Date().toISOString();
        return '';
      });
      sheet.appendRow(row);
      insertedIds.push({ sheet: 'Nota_Misc', id: itemId });
    } else if (type === 'sales-gb' || type === 'gb') {
      const sheet = ensureSheetWithColumn_(ss, SHEETS.SALES_GB, 'nota_id');
      const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
      const row = headers.map(h => {
        if (h === 'id') return itemId;
        if (h === 'nota_id') return notaId;
        if (h === 'created') return new Date().toISOString();
        if (h === 'tanggal') return tanggal;
        if (h === 'customer') return customer;
        if (h === 'customer_type') return customerType;
        if (h === 'type') return 'sales-gb';
        if (h === 'status') return 'synced';
        if (h === 'synced_at') return new Date().toISOString();
        if (h === 'qty') return qty;
        if (h === 'harga_per_kg') return harga;
        if (h === 'total_sales') return lineSales;
        return it[h] !== undefined ? it[h] : '';
      });
      sheet.appendRow(row);
      insertedIds.push({ sheet: 'Sales_GB', id: itemId });
    } else {
      const sheet = ensureSheetWithColumn_(ss, SHEETS.SALES_RB, 'nota_id');
      const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
      const row = headers.map(h => {
        if (h === 'id') return itemId;
        if (h === 'nota_id') return notaId;
        if (h === 'created') return new Date().toISOString();
        if (h === 'tanggal') return tanggal;
        if (h === 'customer') return customer;
        if (h === 'customer_type') return customerType;
        if (h === 'type') return 'sales-rb';
        if (h === 'status') return 'synced';
        if (h === 'synced_at') return new Date().toISOString();
        if (h === 'packs') return qty;
        if (h === 'harga_per_pack') return harga;
        if (h === 'total_sales') return lineSales;
        return it[h] !== undefined ? it[h] : '';
      });
      sheet.appendRow(row);
      insertedIds.push({ sheet: 'Sales_RB', id: itemId });
    }
  });

  // 3. Recompute totals
  const diskon = payment.diskon !== undefined ? parseFloat(payment.diskon) || 0 : (parseFloat(currentMap.diskon) || 0);
  const total = subtotal - diskon;
  let dpPaid = payment.dp_paid !== undefined ? parseFloat(payment.dp_paid) || 0 : (parseFloat(currentMap.dp_paid) || 0);
  if (dpPaid > total) dpPaid = total;
  const sisa = Math.max(0, total - dpPaid);

  // 4. Determine status — explicit if provided, else auto-derive
  let status = (payment.status_payment || '').toUpperCase();
  if (!status) {
    if (dpPaid >= total - 0.01) status = 'PAID';
    else if (dpPaid > 0) status = 'PARTIAL';
    else status = 'UNPAID';
  }
  if (status === 'PAID') dpPaid = total;

  const paidDate = status === 'PAID'
    ? (payment.paid_date || (currentMap.paid_date instanceof Date ? Utilities.formatDate(currentMap.paid_date,'GMT+7','yyyy-MM-dd') : currentMap.paid_date) || tanggal)
    : (payment.paid_date !== undefined ? payment.paid_date : '');
  const metodeBayar = payment.metode_bayar !== undefined ? payment.metode_bayar : (currentMap.metode_bayar || '');

  // 5. Update Nota header row atomically
  const updates = {
    customer: customer,
    customer_type: customerType,
    tanggal: tanggal,
    catatan: catatan,
    subtotal: subtotal,
    diskon: diskon,
    total: total,
    dp_paid: dpPaid,
    sisa: status === 'PAID' ? 0 : sisa,
    status_payment: status,
    paid_date: paidDate,
    metode_bayar: metodeBayar,
    item_count: items.length
  };
  Object.keys(updates).forEach(field => {
    const c = nHeaders.indexOf(field) + 1;
    if (c > 0) notaSheet.getRange(sheetRow, c).setValue(updates[field]);
  });

  return {
    ok: true,
    nota_id: notaId,
    subtotal: subtotal,
    diskon: diskon,
    total: total,
    dp_paid: dpPaid,
    sisa: status === 'PAID' ? 0 : sisa,
    status: status,
    items_count: items.length,
    items_inserted: insertedIds,
    cleanup: report.join(' | ')
  };
}

// ============================================================================
// V8.9 — PRODUKSI ROASTING HANDLERS (Phase 2, panen 2026)
// ============================================================================

/**
 * Generate sequential Produksi ID: PRD-YYYY-NNNN
 * Reads existing PRODUKSI sheet, picks max NNNN+1 for current year.
 */
function generateProduksiId_(ss) {
  const sheet = ensureSheet_(ss, SHEETS.PRODUKSI, PRODUKSI_HEADERS);
  const year = new Date().getFullYear();
  const prefix = 'PRD-' + year + '-';
  const lr = sheet.getLastRow();
  let max = 0;
  if (lr > 1) {
    const ids = sheet.getRange(2, 1, lr - 1, 1).getValues();
    ids.forEach(r => {
      const id = String(r[0] || '');
      if (id.indexOf(prefix) === 0) {
        const n = parseInt(id.substring(prefix.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    });
  }
  return prefix + String(max + 1).padStart(4, '0');
}

/**
 * V8.9 — Stage A: GB ambil ke roastery (status='in_progress').
 * Body: {
 *   tanggal_ambil:  'YYYY-MM-DD',
 *   source_grade:   'GBP'|'GBC'|'GBL'|'GBS'|'SIG',
 *   qty_input_kg:   number,
 *   target_produk:  optional override (default from PROD_MAP),
 *   vendor_roastery:'Equal Roastery' | custom,
 *   catatan:        optional
 * }
 * Atomic: append Produksi row + GB_Movement (-source_grade dari di_tempat).
 */
function handleSubmitProduksiAmbil_(ss, body) {
  // Validate
  const sourceGrade = String(body.source_grade || '').toUpperCase();
  const qtyInput = parseFloat(body.qty_input_kg || 0);
  const vendor = String(body.vendor_roastery || '').trim();
  if (!PROD_MAP[sourceGrade]) {
    return { ok: false, error: 'Invalid source_grade: ' + sourceGrade + ' (must be GBP/GBC/GBL/GBS/SIG)' };
  }
  if (!(qtyInput > 0)) {
    return { ok: false, error: 'qty_input_kg must be > 0, got: ' + body.qty_input_kg };
  }
  if (!vendor) {
    return { ok: false, error: 'vendor_roastery required' };
  }
  const mapping = PROD_MAP[sourceGrade];
  const targetProduk = String(body.target_produk || mapping.target).toUpperCase();
  const expectedOutput = +(qtyInput * (1 - mapping.susut_pct)).toFixed(3);
  const expectedSusutPct = mapping.susut_pct;
  const tglAmbil = String(body.tanggal_ambil || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const catatan = String(body.catatan || '');
  // Generate id + sheet ensure
  const produksiId = generateProduksiId_(ss);
  const sheet = ensureSheet_(ss, SHEETS.PRODUKSI, PRODUKSI_HEADERS);
  // Build row
  const row = PRODUKSI_HEADERS.map(h => {
    switch (h) {
      case 'id': return produksiId;
      case 'tanggal_ambil': return tglAmbil;
      case 'source_grade': return sourceGrade;
      case 'qty_input_kg': return qtyInput;
      case 'target_produk': return targetProduk;
      case 'expected_output_kg': return expectedOutput;
      case 'expected_susut_pct': return expectedSusutPct;
      case 'vendor_roastery': return vendor;
      case 'status': return 'in_progress';
      case 'catatan': return catatan;
      case 'created_at': return new Date().toISOString();
      default: return '';
    }
  });
  sheet.appendRow(row);
  // Atomic: GB_Movement negative dari di_tempat → di_roastery:{vendor}
  appendMovement_(ss, {
    tanggal_iso: tglAmbil,
    source: 'produksi_ambil',
    grade: sourceGrade,
    qty_signed: -qtyInput,
    lokasi: 'di_roastery:' + vendor,
    pekerja: '',
    ref_id: produksiId,
    catatan: 'Ambil ' + qtyInput + ' KG ' + sourceGrade + ' → ' + targetProduk + ' @ ' + vendor
  });
  formatAndSortAll_(ss);
  return {
    ok: true,
    produksi_id: produksiId,
    expected_output_kg: expectedOutput,
    expected_susut_pct: expectedSusutPct,
    target_produk: targetProduk,
    status: 'in_progress'
  };
}

/**
 * V8.9 — Stage B: Kembali dari roastery (status='in_progress' → 'selesai').
 * Body: {
 *   id:                'PRD-YYYY-NNNN',
 *   tanggal_kembali:   'YYYY-MM-DD',
 *   actual_output_kg:  number,
 *   biaya_roasting_per_kg: number,
 *   biaya_roasting_total:  number (optional, auto: per_kg × qty_input),
 *   biaya_packaging:   number (optional, default 0),
 *   catatan:           string (WAJIB kalau susut variance outside tolerance)
 * }
 * Atomic: update Produksi row + GB_Movement (+target_produk) + Pengeluaran row.
 */
function handleSubmitProduksiSelesai_(ss, body) {
  // Prefer body.produksi_id (entry has its own uid in body.id). Fallback to body.id for direct API calls.
  const produksiId = String(body.produksi_id || body.id || '').trim();
  if (!produksiId) return { ok: false, error: 'produksi_id required' };
  const actualOutput = parseFloat(body.actual_output_kg || 0);
  if (!(actualOutput > 0)) {
    return { ok: false, error: 'actual_output_kg must be > 0' };
  }
  // Find Produksi row
  const sheet = ensureSheet_(ss, SHEETS.PRODUKSI, PRODUKSI_HEADERS);
  const lr = sheet.getLastRow();
  if (lr < 2) return { ok: false, error: 'No Produksi rows yet' };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idCol = headers.indexOf('id');
  const ids = sheet.getRange(2, idCol + 1, lr - 1, 1).getValues().map(r => String(r[0] || ''));
  const idx = ids.indexOf(produksiId);
  if (idx < 0) return { ok: false, error: 'Produksi id not found: ' + produksiId };
  const rowNum = idx + 2;
  // Read row to get source_grade, qty_input, target_produk, vendor, status
  const rowData = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  const obj = {};
  headers.forEach((h, i) => { obj[h] = rowData[i]; });
  if (String(obj.status) !== 'in_progress') {
    return { ok: false, error: 'Produksi ' + produksiId + ' status=' + obj.status + ' (must be in_progress)' };
  }
  const qtyInput = parseFloat(obj.qty_input_kg) || 0;
  const sourceGrade = String(obj.source_grade || '').toUpperCase();
  const targetProduk = String(obj.target_produk || '').toUpperCase();
  const vendor = String(obj.vendor_roastery || '');
  // Compute susut
  const actualSusutPct = qtyInput > 0 ? +((qtyInput - actualOutput) / qtyInput).toFixed(4) : 0;
  const mapping = PROD_MAP[sourceGrade] || { tol_low: 0.15, tol_high: 0.25 };
  let susutVariance = 'normal';
  if (actualSusutPct < mapping.tol_low) susutVariance = 'low_warning';
  else if (actualSusutPct > mapping.tol_high) susutVariance = 'high_warning';
  const catatan = String(body.catatan || '').trim();
  if (susutVariance !== 'normal' && !catatan) {
    return {
      ok: false,
      error: 'Catatan WAJIB karena susut ' + (actualSusutPct * 100).toFixed(1) + '% di luar tolerance ' +
             (mapping.tol_low * 100).toFixed(0) + '-' + (mapping.tol_high * 100).toFixed(0) + '%. ' +
             'Variance: ' + susutVariance,
      susut_variance: susutVariance,
      actual_susut_pct: actualSusutPct
    };
  }
  // Biaya
  const biayaPerKg = parseFloat(body.biaya_roasting_per_kg || 0);
  const biayaTotal = parseFloat(body.biaya_roasting_total || (biayaPerKg * qtyInput));
  const biayaPackaging = parseFloat(body.biaya_packaging || 0);
  if (!(biayaTotal >= 0)) return { ok: false, error: 'biaya_roasting_total must be >= 0' };
  const tglKembali = String(body.tanggal_kembali || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  // Atomic: Append Pengeluaran first (to get ref_id for cross-link)
  const pengSheet = ensureSheet_(ss, SHEETS.PENGELUARAN, []);
  const pengHeaders = pengSheet.getRange(1, 1, 1, pengSheet.getLastColumn()).getValues()[0];
  const pengId = 'PEN_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  const pengTotal = biayaTotal + biayaPackaging;
  const pengDeskripsi = 'Roasting ' + qtyInput + ' KG ' + sourceGrade + ' → ' + targetProduk +
                         ' @ ' + vendor + ' (' + produksiId + ')';
  const pengRow = pengHeaders.map(h => {
    if (h === 'id') return pengId;
    if (h === 'tanggal') return tglKembali;
    if (h === 'kategori') return 'Roasting';
    if (h === 'deskripsi') return pengDeskripsi;
    if (h === 'total') return pengTotal;
    if (h === 'supplier') return vendor;
    if (h === 'qty') return qtyInput;  // qty GB input untuk audit trail
    if (h === 'harga_per_kg') return biayaPerKg;
    if (h === 'ref_id') return produksiId;
    if (h === 'catatan') return catatan || ('Biaya roasting Rp ' + biayaPerKg + '/KG' +
                            (biayaPackaging > 0 ? ' + packaging Rp ' + biayaPackaging : ''));
    if (h === 'created_at') return new Date().toISOString();
    return '';
  });
  pengSheet.appendRow(pengRow);
  // Atomic: GB_Movement positive (+target_produk di_tempat)
  appendMovement_(ss, {
    tanggal_iso: tglKembali,
    source: 'produksi_selesai',
    grade: targetProduk,
    qty_signed: +actualOutput,
    lokasi: 'di_tempat',
    pekerja: '',
    ref_id: produksiId,
    catatan: 'Kembali dari ' + vendor + ': ' + actualOutput + ' KG ' + targetProduk +
              ' (susut ' + (actualSusutPct * 100).toFixed(1) + '%, ' + susutVariance + ')'
  });
  // Update Produksi row with all selesai fields
  const updates = {
    tanggal_kembali: tglKembali,
    actual_output_kg: actualOutput,
    actual_susut_pct: actualSusutPct,
    susut_variance: susutVariance,
    biaya_roasting_per_kg: biayaPerKg,
    biaya_roasting_total: biayaTotal,
    biaya_packaging: biayaPackaging,
    status: 'selesai',
    pengeluaran_ref_id: pengId,
    catatan: catatan || obj.catatan
  };
  Object.keys(updates).forEach(field => {
    const col = headers.indexOf(field);
    if (col >= 0) sheet.getRange(rowNum, col + 1).setValue(updates[field]);
  });
  formatAndSortAll_(ss);
  return {
    ok: true,
    produksi_id: produksiId,
    actual_output_kg: actualOutput,
    actual_susut_pct: actualSusutPct,
    susut_variance: susutVariance,
    biaya_total: pengTotal,
    pengeluaran_ref_id: pengId,
    status: 'selesai'
  };
}
