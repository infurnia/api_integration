require('dotenv').config();
const path = require('path');
const fs = require('fs');
const {
  read_catalog_csv,
  get_laminate_template,
  ensure_category_tree,
  create_groups,
  base_sku_payload_from_rows,
  enrich_skus_with_assets
} = require('./common');
const { bulk_create_skus, BUSINESS_UNIT_ID, sleep, fetch_sales_channels } = require('../../utils');

const CSV_PATH = path.resolve(__dirname, '../../hinshitsu_catalog/hinshitsu_wall_papers.csv');
const IMAGES_DIR = path.resolve(__dirname, '../../hinshitsu_catalog/hinshitsu_images/WALLPAPERS');
const ENV_CATEGORY_TYPE_ID = "wallpaper_finish"; // fallback
const ENV_DIVISION_ID = "finish"; // fallback
const CATEGORY_NAME = 'Hinshitsu Wall Papers';
const ASSET_BATCH_SIZE = parseInt(process.env.ASSET_BATCH_SIZE || '15', 10);
const PROGRESS_PATH = path.resolve(__dirname, '../../hinshitsu_catalog/progress_wall_papers.json');
const FINAL_IDS_PATH = path.resolve(__dirname, '../../hinshitsu_catalog/created_ids_wall_papers.json');
const FORCE_RESTART = /^true$/i.test(process.env.FORCE_RESTART || '');

async function run() {
  if (FORCE_RESTART && fs.existsSync(PROGRESS_PATH)) {
    console.log('[wall_papers] FORCE_RESTART=true -> removing existing progress file');
    fs.unlinkSync(PROGRESS_PATH);
  }

  let progress = null;
  if (fs.existsSync(PROGRESS_PATH)) {
    try { progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')); } catch {}
  }

  let SKU_CATEGORY_TYPE_ID, SKU_DIVISION_ID, sku_category, sku_sub_category, skuPayload, created, next_index, pricingCtx;
  const useUniquePerRow = true;
  let groupIdMap;
  let rows;

  if (progress && !progress.completed) {
    console.log('[wall_papers] Resuming from progress file at index', progress.next_index, 'created so far', progress.created.length);
    ({
      SKU_CATEGORY_TYPE_ID,
      SKU_DIVISION_ID,
      sku_category_id: progress.meta.sku_category_id,
      sku_sub_category_id: progress.meta.sku_sub_category_id,
      groupIdMap
    } = {
      SKU_CATEGORY_TYPE_ID: progress.meta.sku_category_type_id,
      SKU_DIVISION_ID: progress.meta.sku_division_id,
      sku_category_id: progress.meta.sku_category_id,
      sku_sub_category_id: progress.meta.sku_sub_category_id,
      groupIdMap: progress.meta.groupIdMap
    });
    sku_category = { id: progress.meta.sku_category_id };
    sku_sub_category = { id: progress.meta.sku_sub_category_id };
    skuPayload = progress.skus;
    created = progress.created;
    next_index = progress.next_index;
    pricingCtx = progress.meta.pricingCtx; // ensure pricing context persists
  } else if (progress && progress.completed) {
    console.log('[wall_papers] Progress file indicates completion. Output already at', FINAL_IDS_PATH);
    return;
  } else {
    console.log('[wall_papers] reading CSV');
    rows = read_catalog_csv(CSV_PATH);
    console.log(`[wall_papers] rows: ${rows.length}`);
    // Transform per-unit (roll) pricing -> each roll = 25ft x 2ft = 50 sq ft.
    // If Pricing Unit indicates a per-unit roll (per_unit / unit / roll) convert price to per sq ft (divide by 50)
    // and change Pricing Unit to sqft so downstream canonical conversion yields price per sq mm.
    const ROLL_AREA_SQFT = 25 * 2; // 50
    for (const r of rows) {
      const unitRaw = (r['Pricing Unit'] || '').trim().toLowerCase();
      // Accept 'role' / 'per_role' (typo variant) in addition to 'roll'
      if (['per_unit','unit','roll','per roll','per_roll','role','per_role','per role'].includes(unitRaw) && r['Price'] != null && r['Price'] !== '') {
        const originalPrice = parseFloat(r['Price']);
        if (!isNaN(originalPrice)) {
          const perSqFt = originalPrice / ROLL_AREA_SQFT;
          r['Price'] = perSqFt.toString();
          r['Pricing Unit'] = 'sft';
        }
      }
    }
    const first = rows[0] || {};
    SKU_CATEGORY_TYPE_ID = first['category_type_id'] || ENV_CATEGORY_TYPE_ID;
    SKU_DIVISION_ID = first['sku_division_id'] || ENV_DIVISION_ID;
    if (!SKU_CATEGORY_TYPE_ID || !SKU_DIVISION_ID) {
      throw new Error('Missing category/division id for Wall Papers (env or CSV columns category_type_id, sku_division_id)');
    }
    console.log('[wall_papers] creating category tree');
    ({ sku_category, sku_sub_category } = await ensure_category_tree({
      categoryName: CATEGORY_NAME,
      sku_category_type_id: SKU_CATEGORY_TYPE_ID,
      sku_division_id: SKU_DIVISION_ID,
      business_unit_id: BUSINESS_UNIT_ID
    }));
    try {
      const scResp = await fetch_sales_channels();
      const owned = scResp.sales_channels?.owned || [];
      const sc = owned.find(s => Array.isArray(s.price_type_ids) && s.price_type_ids.length) || owned[0];
      if (sc && sc.price_type_ids && sc.price_type_ids.length){
        pricingCtx = { sales_channel_id: sc.id, price_type_id: sc.price_type_ids[0], default_margin: 0, default_tax: 0 };
        console.log('[wall_papers] pricing context selected sales_channel', sc.id, 'price_type', sc.price_type_ids[0]);
      } else {
        console.warn('[wall_papers] no suitable sales channel found; prices will be skipped');
      }
    } catch(e){
      console.warn('[wall_papers] failed to fetch sales channels; prices skipped', e.message);
    }
    console.log('[wall_papers] creating groups (unique per row)');
    groupIdMap = await create_groups(rows, sku_sub_category.id, BUSINESS_UNIT_ID, useUniquePerRow);
    skuPayload = base_sku_payload_from_rows(rows, groupIdMap, BUSINESS_UNIT_ID, useUniquePerRow, pricingCtx);
    created = [];
    next_index = 0;
    writeProgress({
      meta: { sku_category_id: sku_category.id, sku_sub_category_id: sku_sub_category.id, sku_category_type_id: SKU_CATEGORY_TYPE_ID, sku_division_id: SKU_DIVISION_ID, groupIdMap, pricingCtx },
      skus: skuPayload,
      created,
      next_index,
      completed: false
    });
  }

  const laminateTemplate = await get_laminate_template();
  const total = skuPayload.length;
  console.log(`[wall_papers] processing ${total} SKUs in asset batches of ${ASSET_BATCH_SIZE} starting from index ${next_index}`);
  for (let i=next_index;i<skuPayload.length;i+=ASSET_BATCH_SIZE){
    let slice = skuPayload.slice(i, i+ASSET_BATCH_SIZE);
    if (fs.existsSync(IMAGES_DIR)) {
      console.log(`[wall_papers] enriching assets for slice ${i+1}-${i+slice.length}`);
      slice = await enrich_skus_with_assets({ skus: slice, laminateTemplate, imagesDir: IMAGES_DIR });
    }
    console.log(`[wall_papers] creating ${slice.length} skus (slice ${(i/ASSET_BATCH_SIZE)+1})`);
    const part = await bulk_create_skus({ sku_data: slice, sku_category_id: sku_category.id, business_unit_id: BUSINESS_UNIT_ID });
    console.log('[wall_papers] sleeping 10s to avoid rate limits');
    await sleep(10000);
    created.push(...part.map(p => ({ id: p.id, name: p.name, model_no: p.model_no })));
    writeProgress({
      meta: { sku_category_id: sku_category.id, sku_sub_category_id: sku_sub_category.id, sku_category_type_id: SKU_CATEGORY_TYPE_ID, sku_division_id: SKU_DIVISION_ID, groupIdMap, pricingCtx },
      skus: skuPayload,
      created,
      next_index: i + ASSET_BATCH_SIZE,
      completed: false
    });
  }
  writeProgress({
    meta: { sku_category_id: sku_category.id, sku_sub_category_id: sku_sub_category.id, sku_category_type_id: SKU_CATEGORY_TYPE_ID, sku_division_id: SKU_DIVISION_ID, groupIdMap, pricingCtx },
    skus: skuPayload,
    created,
    next_index: skuPayload.length,
    completed: true
  });
  fs.writeFileSync(FINAL_IDS_PATH, JSON.stringify({
    meta: { sku_category_id: sku_category.id, sku_category_type_id: SKU_CATEGORY_TYPE_ID, sku_division_id: SKU_DIVISION_ID },
    skus: created
  }, null, 2));
  console.log('Wall Paper SKUs created:', created.length, 'IDs stored at', FINAL_IDS_PATH);
}

run().catch(e => { console.error(e); process.exit(1); });

function writeProgress(data){
  try {
    const tmp = PROGRESS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, PROGRESS_PATH);
  } catch (e){
    console.warn('[wall_papers] failed to write progress file', e.message);
  }
}
