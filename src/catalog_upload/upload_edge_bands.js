#!/usr/bin/env node
/**
 * Edge Bands Catalog Uploader
 * Requirements:
 * - thickness -> depth (numeric mm)
 * - tape width -> height (numeric mm)
 * - Single default sales channel pricing (like other scripts)
 * - Ignore GST for pricing (set tax=0)
 * - Handle brands: fetch all, create missing, attach brand_id to each SKU
 * - Use laminate material template
 * - Resume capability via progress JSON (edge_bands_progress.json)
 */

const path = require('path');
const fs = require('fs');
const {
  read_catalog_csv,
  get_laminate_template,
  enrich_skus_with_assets
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
  generate_id
} = require('../../utils');

const CSV_PATH = path.join(__dirname, '../../hinshitsu_catalog/hinshitsu_edgeband.csv');
const IMAGES_DIR = path.join(__dirname, '../../hinshitsu_catalog/hinshitsu_images/Edge-Bands'); // adjust if folder exists
const PROGRESS_PATH = path.join(__dirname, '../../edge_bands_progress.json');

// Configurable via env if needed (must be numeric IDs expected by backend)
const SKU_CATEGORY_TYPE_ID = "edge_band_hardware";
const SKU_DIVISION_ID = "hardware";
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '40');
const FORCE_RESTART = /^true$/i.test(process.env.FORCE_RESTART || 'false');

async function load_progress(){
  if (!fs.existsSync(PROGRESS_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(PROGRESS_PATH,'utf8')); } catch { return null; }
}
function save_progress(obj){
  fs.writeFileSync(PROGRESS_PATH + '.tmp', JSON.stringify(obj,null,2));
  fs.renameSync(PROGRESS_PATH + '.tmp', PROGRESS_PATH);
}

function normalize_mm(v){
  if(!v) return null;
  const m = v.toString().trim().toLowerCase().replace(/mm/g,'').replace(/[^0-9.]/g,'');
  const num = parseFloat(m);
  return Number.isFinite(num) ? num : null;
}

async function ensure_brand_map(){
  const apiBrands = await get_brands();
  const existing = new Map();
  if (Array.isArray(apiBrands?.brands)) {
    apiBrands.brands.forEach(b => existing.set(b.name.toLowerCase(), b));
  } else if (Array.isArray(apiBrands)) { // fallback shape
    apiBrands.forEach(b => existing.set(b.name.toLowerCase(), b));
  }
  return {
    getOrCreate: async (name) => {
      if(!name) return null;
      const key = name.trim().toLowerCase();
      if (existing.has(key)) return existing.get(key).id;
      try {
        const created = await add_brand(name.trim());
        const brandObj = created?.brand || created; // adapt to response
        if (brandObj && brandObj.name) existing.set(brandObj.name.toLowerCase(), brandObj);
        return brandObj?.id || null;
      } catch(e){
        console.warn('Failed to create brand', name, e.message);
        return null;
      }
    }
  };
}

function build_group_key(row){
  // Use Subcategory + Group Name to cluster variants
  return `${row.Subcategory}||${row['Group Name']}`.trim();
}

function build_variant_label(thickness_mm, width_mm){
  if(thickness_mm && width_mm) return `${thickness_mm}mm x ${width_mm}mm`;
  return thickness_mm ? `${thickness_mm}mm` : (width_mm ? `${width_mm}mm` : 'Variant');
}

async function main(){
  if (FORCE_RESTART && fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
  let progress = await load_progress();
  let rows;
  let category_id, sub_category_id, groups = {}, row_index = 0, pricingCtx = null, laminateTemplate, brandMap, rowsSerialized;

  if(progress){
    try {
      ({ rowsSerialized, category_id, sub_category_id, groups, row_index, pricingCtx } = progress);
      rows = JSON.parse(rowsSerialized);
      console.log('[edge_bands] Resuming from row', row_index, 'of', rows.length);
      if(!category_id || !sub_category_id) {
        throw new Error('Progress file missing category or sub category id (restart with FORCE_RESTART=true for new plan)');
      }
    } catch(e){
      console.warn('[edge_bands] Failed parsing progress file, starting fresh. Error:', e.message);
      progress = null;
    }
  } else {
    console.log('[edge_bands] Fresh run, reading CSV');
    rows = read_catalog_csv(CSV_PATH);
    // Filter out any obviously empty rows
    rows = rows.filter(r => r['Group Name'] && r['SKU Name']);

  // Category + Single Subcategory
  const cat = await create_sku_category({ name: 'Hinshitsu Edgeband', sku_category_type_id: SKU_CATEGORY_TYPE_ID, sku_division_id: SKU_DIVISION_ID, business_unit_id: BUSINESS_UNIT_ID });
  if(!cat?.id) throw new Error('Failed to create category (no id)');
  category_id = cat.id;
  const sub = await create_sku_sub_category({ name: 'All Edge Bands', sku_category_id: category_id, order: 1, business_unit_id: BUSINESS_UNIT_ID });
  if(!sub?.id) throw new Error('Failed to create sub category (no id)');
  sub_category_id = sub.id;

  // Pre-compute distinct group keys (Subcategory values) for progress estimation
  const distinctGroups = [...new Set(rows.map(r => (r.Subcategory||'').trim()).filter(Boolean))];
  const expected_groups_count = distinctGroups.length;
  let next_group_order = 1;

    // Sales channel selection (single default like others)
    const scResp = await fetch_sales_channels();
    const owned = scResp.sales_channels?.owned || [];
    const sc = owned.find(o => o.price_type_ids && o.price_type_ids.length > 0);
    if(!sc) throw new Error('No sales channel with price_type_ids found');
    pricingCtx = { sales_channel_id: sc.id, price_type_id: sc.price_type_ids[0], default_margin: 0, default_tax: 0 };

    laminateTemplate = await get_laminate_template();
    brandMap = await ensure_brand_map();

  progress = { rowsSerialized: JSON.stringify(rows), category_id, sub_category_id, groups, row_index: 0, pricingCtx, expected_groups_count, next_group_order: 1 };
    save_progress(progress);
  }

  if(!laminateTemplate) laminateTemplate = await get_laminate_template();
  if(!brandMap) brandMap = await ensure_brand_map();
  if(progress && progress.expected_groups_count == null){
    // Backward compatibility: compute expected_groups_count & next_group_order from remaining rows
    try {
      const allRows = rows;
      const allDistinct = [...new Set(allRows.map(r => build_group_key(r)))];
      progress.expected_groups_count = allDistinct.length;
      // Determine next_group_order based on groups already created
      const createdCount = Object.keys(groups || {}).length;
      progress.next_group_order = createdCount + 1;
      save_progress(progress);
    } catch(e){
      console.warn('[edge_bands] failed to retro-compute expected_groups_count', e.message);
    }
  }
  // New grouping strategy: group key is just the Subcategory column value; all SKUs share one sub_category_id.
  function getGroupKey(row){
    const raw = (row.Subcategory || '').trim();
    return raw || 'UNSPECIFIED';
  }

  const total = rows.length;
  while(row_index < total){
    const slice = rows.slice(row_index, row_index + BATCH_SIZE);
    const batchStartIndex = row_index;
    console.log(`[edge_bands] Preparing batch starting at row_index ${batchStartIndex}`);
    const skus = [];
    for(const r of slice){
      // Lazy group creation per Subcategory
      const gKey = getGroupKey(r);
      if(!groups[gKey]){
        const groupDisplay = gKey;
        try {
          const grp = await create_sku_group({ name: groupDisplay, sku_sub_category_id: sub_category_id, order: progress.next_group_order || (Object.keys(groups).length + 1), business_unit_id: BUSINESS_UNIT_ID });
          groups[gKey] = grp.id;
          progress.next_group_order = (progress.next_group_order || 1) + 1;
          const createdCount = Object.keys(groups).length;
          if(progress.expected_groups_count){
            console.log(`[edge_bands] group ${createdCount}/${progress.expected_groups_count} created -> ${groupDisplay} (${grp.id})`);
          } else {
            console.log(`[edge_bands] group created -> ${groupDisplay} (${grp.id})`);
          }
          // Persist after each group to allow early stop/resume
          save_progress(progress);
          // Light pacing between group creations
          await sleep(60);
        } catch(e){
          console.error('[edge_bands] failed to create group for key (Subcategory)', gKey, e.message);
          throw e;
        }
      }
      const thickness_mm = normalize_mm(r['Thickness']);
      const width_mm = normalize_mm(r['Tape Width']);
      const variant_label = build_variant_label(thickness_mm, width_mm);
      const group_id = groups[gKey];
      const purchasePriceRaw = r['Purchase Price'];
      let purchasePrice = parseFloat(purchasePriceRaw);
      if(Number.isNaN(purchasePrice)) purchasePrice = null;
      let sales_channels = [];
      if (pricingCtx && purchasePrice != null) {
        // Pricing unit assumed MTR -> canonical per mm
        const canonicalPrice = purchasePrice / 1000; // per mm
        sales_channels = [{
          id: pricingCtx.sales_channel_id,
          price_types: [{
            id: pricingCtx.price_type_id,
            price: canonicalPrice,
            margin: 0,
            tax: 0,
            display_unit: 'metre'
          }]
        }];
      }
      const brandName = (r['Brand'] || '').trim();
      let brand_id = null;
      if (brandName) brand_id = await brandMap.getOrCreate(brandName);
      if (brandName && !brand_id){
        console.warn('[edge_bands] brand unresolved, continuing without brand_id ->', brandName);
      }

      skus.push({
        id: generate_id(),
        name: r['SKU Name']?.trim() || variant_label,
        model_no: (r['SKU ID ( Model No)'] || '').toString().trim() || null,
        sku_group_id: group_id,
        additional_properties: null,
        placement_id: null,
        brand_id,
        sales_channels,
        // size properties mapped
        depth: thickness_mm != null ? thickness_mm : null,
        height: width_mm != null ? width_mm : null,
        business_unit_id: BUSINESS_UNIT_ID
      });
    }
    try {
      console.log(`[edge_bands] Creating ${skus.length} SKUs (rows ${row_index}..${row_index+skus.length-1})`);
      if(!category_id){
        throw new Error('Missing category_id before bulk create');
      }
      const created = await bulk_create_skus({ sku_data: skus, sku_category_id: category_id, business_unit_id: BUSINESS_UNIT_ID });
      console.log(`[edge_bands] Created ${created.length} SKUs`);
      // Asset enrichment (best-effort) – images folder may not exist
      if (fs.existsSync(IMAGES_DIR)) {
        await enrich_skus_with_assets({ skus: created, laminateTemplate, imagesDir: IMAGES_DIR });
      }
      row_index += skus.length;
  progress.category_id = category_id;
  progress.sub_category_id = sub_category_id;
  progress.row_index = row_index;
      save_progress(progress);
    } catch(err){
      console.error('[edge_bands] Batch failed at starting index', batchStartIndex, 'error:', err.message);
      // Save current progress (row_index unchanged) for resume
      save_progress(progress);
      throw err; // exit to allow external retry
    }
    await sleep(300); // pacing
  }

  console.log('[edge_bands] Completed all rows');
}

if (require.main === module){
  main().catch(err => { console.error('Edge Bands upload failed', err); process.exit(1); });
}
