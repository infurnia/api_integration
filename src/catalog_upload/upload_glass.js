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

/* CONFIG: Adjust these per CSV if needed */
const CSV_PATH = path.resolve(__dirname, '../../hinshitsu_catalog/hinshitsu_glass.csv');
const IMAGES_DIR = path.resolve(__dirname, '../../hinshitsu_catalog/hinshitsu_images/Glass');
// Provide the correct ids from CSV or environment later; placeholders for now
const ENV_CATEGORY_TYPE_ID = "other_finish_finish"; // fallback
const ENV_DIVISION_ID = "finish"; // fallback
const CATEGORY_NAME = 'Hinshitsu Glass';
const ASSET_BATCH_SIZE = parseInt(process.env.ASSET_BATCH_SIZE || '15', 10);
const PROGRESS_PATH = path.resolve(__dirname, '../../hinshitsu_catalog/progress_glass.json');
const FINAL_IDS_PATH = path.resolve(__dirname, '../../hinshitsu_catalog/created_ids_glass.json');
const FORCE_RESTART = /^true$/i.test(process.env.FORCE_RESTART || '');

async function run() {
  // Handle force restart
  if (FORCE_RESTART && fs.existsSync(PROGRESS_PATH)) {
    console.log('[glass] FORCE_RESTART=true -> removing existing progress file');
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
    console.log('[glass] Resuming from progress file at index', progress.next_index, 'created so far', progress.created.length);
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
  } else if (progress && progress.completed) {
    console.log('[glass] Progress file indicates completion. Output already at', FINAL_IDS_PATH);
    return;
  } else {
    console.log('[glass] reading CSV');
    rows = read_catalog_csv(CSV_PATH);
    console.log(`[glass] rows: ${rows.length}`);
    const first = rows[0] || {};
    SKU_CATEGORY_TYPE_ID = first['category_type_id'] || ENV_CATEGORY_TYPE_ID;
    SKU_DIVISION_ID = first['sku_division_id'] || ENV_DIVISION_ID;
    if (!SKU_CATEGORY_TYPE_ID || !SKU_DIVISION_ID) {
      throw new Error('Missing category/division id for Glass (env or CSV columns category_type_id, sku_division_id)');
    }
    console.log('[glass] fetching laminate template (will fetch again later if resuming)');
    // template fetched later
    console.log('[glass] creating category tree');
    ({ sku_category, sku_sub_category } = await ensure_category_tree({
      categoryName: CATEGORY_NAME,
      sku_category_type_id: SKU_CATEGORY_TYPE_ID,
      sku_division_id: SKU_DIVISION_ID,
      business_unit_id: BUSINESS_UNIT_ID
    }));
    // Fetch sales channel & price type (first owned channel with a price type)
    try {
      const scResp = await fetch_sales_channels();
      const owned = scResp.sales_channels?.owned || [];
      const sc = owned.find(s => Array.isArray(s.price_type_ids) && s.price_type_ids.length) || owned[0];
      if (sc && sc.price_type_ids && sc.price_type_ids.length){
        pricingCtx = {
          sales_channel_id: sc.id,
          price_type_id: sc.price_type_ids[0],
          default_margin: 0,
            default_tax: 0
        };
        console.log('[glass] pricing context selected sales_channel', sc.id, 'price_type', sc.price_type_ids[0]);
      } else {
        console.warn('[glass] no suitable sales channel found; prices will be skipped');
      }
    } catch (e){
      console.warn('[glass] failed to fetch sales channels; prices will be skipped', e.message);
    }
    console.log('[glass] creating groups (unique per row)');
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
  console.log(`[glass] processing ${total} SKUs in asset batches of ${ASSET_BATCH_SIZE} starting from index ${next_index}`);
  for (let i=next_index;i<skuPayload.length;i+=ASSET_BATCH_SIZE){
    let slice = skuPayload.slice(i, i+ASSET_BATCH_SIZE);
    if (fs.existsSync(IMAGES_DIR)) {
      console.log(`[glass] enriching assets for slice ${i+1}-${i+slice.length}`);
      slice = await enrich_skus_with_assets({ skus: slice, laminateTemplate, imagesDir: IMAGES_DIR });
    }
    console.log(`[glass] creating ${slice.length} skus (slice ${(i/ASSET_BATCH_SIZE)+1})`);
    const part = await bulk_create_skus({ sku_data: slice, sku_category_id: sku_category.id, business_unit_id: BUSINESS_UNIT_ID });
    console.log('[glass] sleeping 10s to avoid rate limits');
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
  // Finalize
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
  console.log('Glass SKUs created:', created.length, 'IDs stored at', FINAL_IDS_PATH);
}

run().catch(e => { console.error(e); process.exit(1); });

function writeProgress(data){
  try {
    const tmp = PROGRESS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, PROGRESS_PATH);
  } catch (e){
    console.warn('[glass] failed to write progress file', e.message);
  }
}
