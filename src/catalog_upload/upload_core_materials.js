#!/usr/bin/env node
/**
 * Core Materials Catalog Uploader
 * Requirements:
 * - Create category (Hinshitsu Core Materials) and dynamic subcategories from CSV Subcategory column.
 * - Create groups lazily from `Group Name`.
 * - Canonicalize pricing like finishes: store price in per sq mm baseline while retaining display_unit from original (sq_foot / sq_meter / sq_mm).
 * - Additional properties: only lamination_type with values: 'prelam_both' when Lamination == 'Prelam' else 'postlam'.
 * - Link two finish SKUs (internal_finish & external_finish) using columns `Prelam Internal`, `PreLam External` (only when Lamination == 'Prelam').
 *   HARD FAIL if one or both tokens provided but cannot be resolved to existing finish SKUs.
 * - Ignore any edge band mapping columns entirely.
 * - Resume capability (progress file) and batching.
 * - No material/texture/image uploads.
 */

const path = require('path');
const fs = require('fs');
const {
  read_catalog_csv,
} = require('./common');
const {
  create_sku_category,
  create_sku_sub_category,
  create_sku_group,
  bulk_create_skus,
  fetch_sales_channels,
  BUSINESS_UNIT_ID,
  sleep,
  get_brands,
  add_brand,
  generate_id,
  get_all_sub_categories,
  get_groups
} = require('../../utils');

// ---------------- Config ----------------
const CSV_PATH = path.join(__dirname, '../../hinshitsu_catalog/hinshitsu_core_materials.csv');
const PROGRESS_PATH = path.join(__dirname, '../../core_materials_progress.json');
const CATEGORY_NAME = process.env.CORE_CATEGORY_NAME || 'Hinshitsu Core Materials';
const SKU_CATEGORY_TYPE_ID = process.env.CORE_CATEGORY_TYPE_ID || 'core_material_core'; // Expect override via env if incorrect
const SKU_DIVISION_ID = process.env.CORE_DIVISION_ID || 'core_material';
const BATCH_SIZE = parseInt(process.env.CORE_BATCH_SIZE || '40', 10);
const FORCE_RESTART = /^true$/i.test(process.env.FORCE_RESTART || 'false');
const FINISHES_CATEGORY_ID_ENV = process.env.FINISHES_CATEGORY_ID || null; // optional override
const FINISHES_PROGRESS_PATH = path.join(__dirname, '../../finishes_progress.json');
const FINISH_INDEX_DEBUG = process.env.CORE_FINISH_INDEX_DEBUG === 'true';

// ---------------- Helpers ----------------
async function load_progress(){
  if(!fs.existsSync(PROGRESS_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(PROGRESS_PATH,'utf8')); } catch { return null; }
}
function save_progress(obj){
  fs.writeFileSync(PROGRESS_PATH + '.tmp', JSON.stringify(obj,null,2));
  fs.renameSync(PROGRESS_PATH + '.tmp', PROGRESS_PATH);
}

async function ensure_brand_map(){
  const apiBrands = await get_brands();
  const existing = new Map();
  if (Array.isArray(apiBrands?.brands)) apiBrands.brands.forEach(b => existing.set(b.name.toLowerCase(), b));
  else if (Array.isArray(apiBrands)) apiBrands.forEach(b => existing.set(b.name.toLowerCase(), b));
  return {
    getOrCreate: async (name) => {
      if(!name) return null;
      const key = name.trim().toLowerCase();
      if(existing.has(key)) return existing.get(key).id;
      try {
        const created = await add_brand(name.trim());
        const brandObj = created?.brand || created;
        if(brandObj?.name) existing.set(brandObj.name.toLowerCase(), brandObj);
        return brandObj?.id || null;
      } catch(e){
        console.warn('[core] brand create failed', name, e.message);
        return null;
      }
    }
  };
}

// Pricing canonicalization (per sq mm baseline)
function canonicalizePrice(row){
  const raw = row['PURCHASE Price'] ?? row['Purchase Price'];
  if(raw == null || raw === '') return null;
  const val = parseFloat(raw);
  if(!Number.isFinite(val)) return null;
  const unitRaw = (row['Pricing Unit'] || '').toString().trim().toLowerCase();
  const SQFT_TO_SQMM = 304.8 * 304.8; // 92903.04
  let canonicalPerSqMm = val; // assume already per sq mm
  let display_unit = 'sq_foot';
  if(/sq.?ft|sqft|ft2|foot/.test(unitRaw)){
    canonicalPerSqMm = val / SQFT_TO_SQMM;
    display_unit = 'sq_foot';
  } else if(/sq.?mm|mm2|sqmm/.test(unitRaw) || unitRaw === 'sq_mm'){
    canonicalPerSqMm = val;
    display_unit = 'sq_mm';
  } else if(/sq.?m|sqm|m2/.test(unitRaw)){
    canonicalPerSqMm = val / 1_000_000;
    display_unit = 'sq_meter';
  } else if(!unitRaw){
    canonicalPerSqMm = val / SQFT_TO_SQMM; // assume sq ft
    display_unit = 'sq_foot';
  } else {
    console.warn('[core] Unknown pricing unit ->', unitRaw, 'treating as sq.ft');
    canonicalPerSqMm = val / SQFT_TO_SQMM;
    display_unit = 'sq_foot';
  }
  return { price_per_sq_mm: canonicalPerSqMm, display_unit };
}

// Finish index builder to resolve internal/external finish references.
async function buildFinishIndex(){
  console.log('[core][finish-index] building finishes index');
  const index = { byName: new Map(), all: [] };
  let finishesCategoryId = FINISHES_CATEGORY_ID_ENV;
  if(!finishesCategoryId && fs.existsSync(FINISHES_PROGRESS_PATH)){
    try {
      const prog = JSON.parse(fs.readFileSync(FINISHES_PROGRESS_PATH,'utf8'));
      finishesCategoryId = prog.category_id || null;
      if(FINISH_INDEX_DEBUG) console.log('[core][finish-index] derived finishes category from progress file ->', finishesCategoryId);
    } catch(e){ console.warn('[core][finish-index] cannot parse finishes progress', e.message); }
  }
  // Fallback: discover by scanning sub categories for name pattern of known finishes groups if needed (skip for now)
  const subTree = await get_all_sub_categories(BUSINESS_UNIT_ID);
  const flat = [];
  const collect = (arr) => { if(Array.isArray(arr)) arr.forEach(o => { flat.push(o); if(o.children) collect(o.children); }); };
  collect(subTree?.owned); collect(subTree?.subscribed); collect(subTree?.others);
  // If finishesCategoryId known, restrict subcats to those with that parent id.
  const targetSubCats = finishesCategoryId ? flat.filter(sc => sc.sku_category_id === finishesCategoryId) : flat.filter(sc => /laminate|finish/i.test(sc.name));
  if(FINISH_INDEX_DEBUG) console.log('[core][finish-index] candidate finish subcats:', targetSubCats.length);
  for(const sc of targetSubCats){
    let groups;
    try { groups = await get_groups(sc.id, BUSINESS_UNIT_ID); } catch(e){ console.warn('[core][finish-index] get_groups failed for', sc.id, e.message); continue; }
    if(!Array.isArray(groups)) continue;
    for(const g of groups){
      const skuList = g.skus || g.sku || [];
      skuList.forEach(s => {
        const nameKey = (s.name||'').toLowerCase().trim();
        if(nameKey && !index.byName.has(nameKey)) index.byName.set(nameKey, s);
        if(s.model_no){
          const mk = s.model_no.toString().trim().toLowerCase();
          if(mk && !index.byName.has(mk)) index.byName.set(mk, s);
        }
        index.all.push(s);
      });
    }
  }
  console.log('[core][finish-index] total finish SKUs indexed:', index.all.length, 'unique keys:', index.byName.size);
  if(index.all.length === 0) throw new Error('Finish index empty; cannot link internal/external finishes.');
  return index;
}

function resolveFinishToken(index, raw){
  if(!raw) return null;
  let token = raw.toString().trim().toLowerCase();
  if(!token) return null;
  // Remove dimension suffix patterns and mm/ft segments
  token = token.replace(/\b\d+mm\b/gi,'').replace(/\b\d+ft\b/gi,'').replace(/1mm x 8ft x 4ft/gi,'').replace(/-/g,' ').replace(/\s{2,}/g,' ').trim();
  if(index.byName.has(token)) return index.byName.get(token);
  // Contains match
  let c = index.all.find(s => (s.name||'').toLowerCase() === token);
  if(c) return c;
  c = index.all.find(s => (s.name||'').toLowerCase().includes(token));
  if(c) return c;
  c = index.all.find(s => (s.model_no||'').toString().toLowerCase() === token);
  if(c) return c;
  c = index.all.find(s => (s.model_no||'').toString().toLowerCase().includes(token));
  return c || null;
}

function build_group_key(row){
  return `${row.Subcategory}||${row['Group Name']}`.trim();
}

async function main(){
  if(FORCE_RESTART && fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
  let progress = await load_progress();
  let rows;
  let category_id, sub_categories = {}, groups = {}, row_index = 0, pricingCtx = null, brandMap, rowsSerialized;
  let expected_groups_count, expected_subcategories_count, next_group_order = 1, next_sub_category_order = 1;
  let finishIndex;

  if(progress){
    try {
      ({ rowsSerialized, category_id, sub_categories = {}, groups, row_index, pricingCtx, expected_groups_count, expected_subcategories_count, next_group_order, next_sub_category_order } = progress);
      rows = JSON.parse(rowsSerialized);
      console.log('[core] Resuming from row', row_index, 'of', rows.length);
    } catch(e){
      console.warn('[core] Failed parsing progress, starting fresh:', e.message);
      progress = null;
    }
  }

  if(!progress){
    console.log('[core] Fresh run reading CSV');
    rows = read_catalog_csv(CSV_PATH).filter(r => r['Group Name'] && (r['SKU Name'] || r['SKU Code']));
    const cat = await create_sku_category({ name: CATEGORY_NAME, sku_category_type_id: SKU_CATEGORY_TYPE_ID, sku_division_id: SKU_DIVISION_ID, business_unit_id: BUSINESS_UNIT_ID });
    category_id = cat.id;
    const distinctGroups = [...new Set(rows.map(r => build_group_key(r)))];
    const distinctSubcats = [...new Set(rows.map(r => (r.Subcategory||'').trim()).filter(Boolean))];
    expected_groups_count = distinctGroups.length;
    expected_subcategories_count = distinctSubcats.length;
    const scResp = await fetch_sales_channels();
    const owned = scResp.sales_channels?.owned || [];
    const sc = owned.find(o => o.price_type_ids && o.price_type_ids.length > 0);
    if(!sc) throw new Error('No sales channel with price_type_ids found');
    pricingCtx = { sales_channel_id: sc.id, price_type_id: sc.price_type_ids[0], default_margin: 0 };
    brandMap = await ensure_brand_map();
    progress = { rowsSerialized: JSON.stringify(rows), category_id, sub_categories, groups, row_index: 0, pricingCtx, expected_groups_count, expected_subcategories_count, next_group_order, next_sub_category_order };
    save_progress(progress);
  }
  if(!brandMap) brandMap = await ensure_brand_map();

  // Build finish index once (needed for prelam rows)
  finishIndex = await buildFinishIndex();

  async function ensureSubCategory(name){
    const key = (name||'').trim();
    if(!key) return null;
    if(sub_categories[key]) return sub_categories[key].id;
    const scObj = await create_sku_sub_category({ name: key, sku_category_id: category_id, order: next_sub_category_order, business_unit_id: BUSINESS_UNIT_ID });
    sub_categories[key] = { id: scObj.id, order: next_sub_category_order };
    next_sub_category_order += 1;
    const createdCount = Object.keys(sub_categories).length;
    console.log(`[core] subcategory ${createdCount}/${expected_subcategories_count} created -> ${key} (${scObj.id})`);
    progress.sub_categories = sub_categories;
    progress.next_sub_category_order = next_sub_category_order;
    save_progress(progress);
    await sleep(50);
    return scObj.id;
  }

  const total = rows.length;
  while(row_index < total){
    const slice = rows.slice(row_index, row_index + BATCH_SIZE);
    const batchStart = row_index;
    console.log(`[core] Preparing batch starting at row_index ${batchStart}`);
    const sku_data = [];
    for(const r of slice){
      const subName = (r.Subcategory||'').trim();
      const subCatId = await ensureSubCategory(subName);
      const gKey = build_group_key(r);
      if(!groups[gKey]){
        const grp = await create_sku_group({ name: r['Group Name'].trim(), sku_sub_category_id: subCatId, order: next_group_order, business_unit_id: BUSINESS_UNIT_ID });
        groups[gKey] = grp.id;
        next_group_order += 1;
        const createdCount = Object.keys(groups).length;
        console.log(`[core] group ${createdCount}/${expected_groups_count} created -> ${r['Group Name']} (${grp.id})`);
        progress.groups = groups;
        progress.next_group_order = next_group_order;
        save_progress(progress);
        await sleep(40);
      }
      const group_id = groups[gKey];
      const brandName = (r['Brand'] || '').trim();
      const brand_id = brandName ? await brandMap.getOrCreate(brandName) : null;
      const priceInfo = canonicalizePrice(r);
      let sales_channels = [];
      if(priceInfo){
        sales_channels = [{
          id: pricingCtx.sales_channel_id,
            price_types: [{
            id: pricingCtx.price_type_id,
            price: priceInfo.price_per_sq_mm,
            margin: 0,
            tax: 0,
            display_unit: priceInfo.display_unit
          }]
        }];
      }
      const laminationRaw = (r['Lamination'] || '').toString().trim().toLowerCase();
      const isPrelam = laminationRaw === 'prelam';
      const lamination_type = isPrelam ? 'prelam_both' : 'postlam';
      const internalToken = isPrelam ? (r['Prelam Internal'] || '').trim() : '';
      const externalToken = isPrelam ? (r['PreLam External'] || '').trim() : '';
      const linked_skus = [];
      if(isPrelam){
        if(internalToken){
          const resolved = resolveFinishToken(finishIndex, internalToken);
          if(!resolved) throw new Error(`[core] HARD FAIL: Cannot resolve Prelam Internal finish token "${internalToken}" for SKU "${r['SKU Name']||r['SKU Code']}"`);
          linked_skus.push({ id: resolved.id, quantity: 0, type: 'internal_finish' });
        }
        if(externalToken){
          const resolved = resolveFinishToken(finishIndex, externalToken);
          if(!resolved) throw new Error(`[core] HARD FAIL: Cannot resolve PreLam External finish token "${externalToken}" for SKU "${r['SKU Name']||r['SKU Code']}"`);
          linked_skus.push({ id: resolved.id, quantity: 0, type: 'external_finish' });
        }
        if((internalToken && !linked_skus.find(l => l.type === 'internal_finish')) || (externalToken && !linked_skus.find(l => l.type === 'external_finish'))){
          throw new Error(`[core] HARD FAIL: Incomplete finish linking for SKU "${r['SKU Name']||r['SKU Code']}"`);
        }
      }
  // Dimension handling: Only the FIRST dimension (A in AxBxC) is considered -> height (in mm).
  // Width and depth components are intentionally ignored per requirement.
  let height = null;
  const size = (r['SIZE'] || '').toUpperCase();
  const m = size.match(/^(\d+(?:\.\d+)?)MM/);
  if(m){ const v = parseFloat(m[1]); if(Number.isFinite(v)) height = v; }
      const skuPayload = {
        id: generate_id(),
        name: (r['SKU Name'] || r['Group Name'] || r['SKU Code']).trim(),
        model_no: (r['SKU Code'] || '').toString().trim() || null,
        sku_group_id: group_id,
        sub_category: subCatId,
        linked_skus,
        additional_properties: [{ key: 'lamination_type', value: lamination_type }],
        placement_id: null,
        brand_id,
        sales_channels,
  height,
        business_unit_id: BUSINESS_UNIT_ID,
        sku_checked: true
      };
      console.log('[core][payload]', JSON.stringify(skuPayload));
      sku_data.push(skuPayload);
    }
    try {
      console.log(`[core] Creating ${sku_data.length} SKUs (rows ${row_index}..${row_index+sku_data.length-1})`);
      const created = await bulk_create_skus({ sku_data, sku_category_id: category_id, business_unit_id: BUSINESS_UNIT_ID });
      console.log('[core] Created', created.length, 'SKUs');
      row_index += sku_data.length;
      progress.row_index = row_index;
      progress.category_id = category_id;
      progress.sub_categories = sub_categories;
      progress.groups = groups;
      progress.next_group_order = next_group_order;
      progress.next_sub_category_order = next_sub_category_order;
      save_progress(progress);
    } catch(err){
      console.error('[core] Batch failed at starting index', batchStart, err.message);
      save_progress(progress);
      throw err;
    }
    await sleep(250);
  }
  console.log('[core] Completed all rows');
}

if(require.main === module){
  main().catch(e => { console.error('Core materials upload failed', e); process.exit(1); });
}
