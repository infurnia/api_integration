const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const {
  fetch_material_templates,
  create_sku_category,
  create_sku_sub_category,
  create_sku_group,
  bulk_create_skus,
  create_texture,
  create_material,
  create_display_pic,
  BUSINESS_UNIT_ID,
  generate_id,
  sleep
} = require('../../utils');

/**
 * Read a CSV file and return rows (excluding header)
 */
function read_catalog_csv(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, bom: true });
  return records;
}

/**
 * Load laminate material template details (assumes template name 'laminate').
 */
async function get_laminate_template() {
  const templates = await fetch_material_templates();
  const laminate = templates.find(t => /laminate/i.test(t.name));
  if (!laminate) throw new Error('Laminate material template not found');
  return laminate;
}

/**
 * Build (or reuse existing) category + one sub category + groups map keyed by group order/name.
 * For these simple catalogs we use a single sub-category whose name = provided subCategoryName.
 */
async function ensure_category_tree({ categoryName, sku_category_type_id, sku_division_id, business_unit_id }) {
  const sku_category = await create_sku_category({
    name: categoryName,
    sku_category_type_id,
    sku_division_id,
    business_unit_id
  });
  const sku_sub_category = await create_sku_sub_category({
    name: categoryName + ' Sub',
    sku_category_id: sku_category.id,
    order: 1,
    business_unit_id
  });
  return { sku_category, sku_sub_category };
}

/**
 * Create SKU groups.
 * If useUniquePerRow = true, create a group per row using key `${Group Order} - ${SKU Name}`.
 * Otherwise create one group per distinct Group Order value.
 */
async function create_groups(rows, sku_sub_category_id, business_unit_id, useUniquePerRow) {
  const groupIdMap = {};
  let order = 1;
  if (useUniquePerRow) {
    for (const r of rows) {
      const key = `${r['Group Order']} - ${r['SKU Name']}`;
      const grp = await create_sku_group({ name: key, sku_sub_category_id, order, business_unit_id });
      groupIdMap[key] = grp.id;
      order++;
    }
  } else {
    const distinct = [...new Set(rows.map(r => r['Group Order']))];
    for (const g of distinct) {
      const grp = await create_sku_group({ name: g, sku_sub_category_id, order, business_unit_id });
      groupIdMap[g] = grp.id;
      order++;
    }
  }
  return groupIdMap;
}

/**
 * Prepare bulk sku data array (without material/display yet) from CSV.
 */
function base_sku_payload_from_rows(rows, groupIdMap, business_unit_id, useUniquePerRow, pricingCtx) {
  return rows.map(r => {
    const key = useUniquePerRow ? `${r['Group Order']} - ${r['SKU Name']}` : r['Group Order'];
    const priceRaw = (r['Price'] || '').toString().trim();
  const unitRaw = (r['Pricing Unit'] || '').toString().trim().toLowerCase();
    let price = parseFloat(priceRaw);
    if (Number.isNaN(price)) price = null;
    let display_unit = null;
    if (unitRaw) display_unit = mapUnit(unitRaw);
    let sales_channels = [];
    if (pricingCtx && price != null && display_unit && pricingCtx.sales_channel_id && pricingCtx.price_type_id) {
    const canonicalPrice = convertToCanonical(price, display_unit);
      sales_channels = [{
        id: pricingCtx.sales_channel_id,
        price_types: [{
          id: pricingCtx.price_type_id,
      price: canonicalPrice,
          margin: pricingCtx.default_margin ?? 0,
          tax: pricingCtx.default_tax ?? 0,
          display_unit
        }]
      }];
    }
    return {
      id: generate_id(),
      name: r['SKU Name']?.trim(),
      model_no: r['SKU Code']?.trim() || null,
      sku_group_id: groupIdMap[key],
      additional_properties: null,
      placement_id: null,
      sales_channels,
      business_unit_id
    };
  });
}

function mapUnit(u){
  switch(u){
    case 'sft':
    case 'sqft':
    case 'sq.ft':
    case 'ft2':
      return 'sq_foot';
    case 'sqm':
    case 'sqmt':
    case 'm2':
      return 'sq_metre';
    case 'meter':
    case 'metre':
      return 'metre';
    case 'per_unit':
    case 'unit':
    case 'count':
  case 'role':
  case 'per_role':
  case 'perunit':
      return 'per_unit';
    default:
      return null;
  }
}

// Convert a price expressed in the display unit into canonical base units:
// length -> mm, area -> sq_millimetre, volume -> cu_millimetre, per_unit stays same
function convertToCanonical(price, display_unit){
  if (price == null) return price;
  const FT_IN_MM = 304.8; // exact conversion
  const SQFT_IN_SQMM = FT_IN_MM * FT_IN_MM; // 92903.04
  const CUBIC_FT_IN_CU_MM = FT_IN_MM * FT_IN_MM * FT_IN_MM; // 28316846.592
  switch(display_unit){
    case 'sq_foot':
      return price / SQFT_IN_SQMM; // price per sq mm
    case 'sq_metre':
      return price / 1_000_000; // 1 m^2 = 1e6 mm^2
    case 'foot':
      return price / FT_IN_MM; // per mm
  case 'metre':
  case 'meter':
      return price / 1000; // per mm
    case 'cu_foot':
      return price / CUBIC_FT_IN_CU_MM; // per cubic mm
    case 'cu_metre':
      return price / 1_000_000_000; // 1 m^3 = 1e9 mm^3
    // units already in base / unitless
    case 'millimetre':
    case 'sq_millimetre':
    case 'cu_millimetre':
    case 'per_unit':
      return price;
    default:
      return price; // unknown mapping -> leave unchanged
  }
}

/**
 * For each created sku, optionally add material & display pic.
 * We expect image file names to be derived from SKU Code or Name. Strategy:
 * 1. Try exact <SKU Code>.jpg in provided imagesDir (case-insensitive)
 * 2. Fallback to <SKU Name>.jpg with non-alphanumerics replaced by space collapse underscore.
 */
async function enrich_skus_with_assets({ skus, laminateTemplate, imagesDir }) {
  const files = fs.readdirSync(imagesDir).filter(f => !fs.statSync(path.join(imagesDir, f)).isDirectory());
  const lcIndex = new Map();
  for (const f of files) lcIndex.set(f.toLowerCase(), f);

  const exts = ['jpg','jpeg','png'];
  let processed = 0;
  const total = skus.length;
  const startTs = Date.now();
  for (const sku of skus) {
    let candidateNames = [];
    if (sku.model_no) exts.forEach(ext => candidateNames.push(`${sku.model_no}.${ext}`));
    const rawName = sku.name.trim();
    // Add raw name
    exts.forEach(ext => candidateNames.push(`${rawName}.${ext}`));
    // Dimension stripped variant (e.g., remove patterns like '1MM X 8FT X 4FT')
    const dimStripped = rawName.replace(/\b\d+mm\s*x\s*\d+ft\s*x\s*\d+ft\b/gi,'').replace(/\s{2,}/g,' ').trim();
    if(dimStripped && dimStripped !== rawName){ exts.forEach(ext => candidateNames.push(`${dimStripped}.${ext}`)); }
    // Include group_name if provided (finishes uploader)
    if(sku.group_name){
      const g = sku.group_name.trim();
      exts.forEach(ext => candidateNames.push(`${g}.${ext}`));
      const gStripped = g.replace(/\b\d+mm\s*x\s*\d+ft\s*x\s*\d+ft\b/gi,'').replace(/\s{2,}/g,' ').trim();
      if(gStripped && gStripped !== g){ exts.forEach(ext => candidateNames.push(`${gStripped}.${ext}`)); }
      // Also attempt upper-case variant
      exts.forEach(ext => candidateNames.push(`${g.toUpperCase()}.${ext}`));
    }
    // normalized slug (hyphenated) for each distinct textual base
    const baseForSlug = new Set(candidateNames.map(c => c.replace(/\.[^.]+$/,'')));
    for(const base of baseForSlug){
      const slug = normalize_name(base);
      if(slug && slug !== base){ exts.forEach(ext => candidateNames.push(`${slug}.${ext}`)); }
    }

    let foundFile = null;
    for (const c of candidateNames) {
      if (lcIndex.has(c.toLowerCase())) { foundFile = lcIndex.get(c.toLowerCase()); break; }
    }

    if (!foundFile){
      // Fuzzy fallback: find a single file containing group_name or dimStripped tokens
      const target = (sku.group_name || dimStripped || rawName).toLowerCase();
      const simplified = target.replace(/\s+/g,' ');
      const matches = files.filter(f => f.toLowerCase().includes(simplified)).slice(0,3);
      if(matches.length === 1) foundFile = matches[0];
    }
    if (!foundFile && sku.group_name){
      // Another fallback: look for starting digits + first word pattern
      const m = sku.group_name.match(/^(\d+\s+[A-Z]{1,5}\s+[^\d]+)/i);
      if(m){
        const fragment = m[1].trim().toLowerCase();
        const alt = files.find(f => f.toLowerCase().startsWith(fragment));
        if(alt) foundFile = alt;
      }
    }
    if (foundFile) {
      try {
        const fullPath = path.join(imagesDir, foundFile);
  const texture = await callWithRetry(() => create_texture({ path: fullPath, name: sku.name }));
        // Transform laminateTemplate.properties (array of {label,value:{value:..}}) into flat key:value
        let rawProps = laminateTemplate.properties;
        if (typeof rawProps === 'string') {
          try { rawProps = JSON.parse(rawProps); } catch (_) { rawProps = []; }
        }
        let baseProps = {};
        if (Array.isArray(rawProps)) {
          rawProps.forEach(p => {
            if (!p || !p.label) return;
            let v = p.value?.value;
            // color object convert to hex if r,g,b present (0-1 or 0-255)
            if (p.value?.type === 'color' && v && typeof v === 'object') {
              const r = v.r, g = v.g, b = v.b;
              if ([r,g,b].every(c => typeof c === 'number')) {
                // assume 0-1 range -> convert
                const conv = (c => c <= 1 ? Math.round(c*255) : c);
                const rr = conv(r), gg = conv(g), bb = conv(b);
                v = '#' + [rr,gg,bb].map(x => x.toString(16).padStart(2,'0')).join('');
              }
            }
            baseProps[p.label] = v == null ? (p.value?.type?.startsWith('double') ? 0 : null) : v;
          });
        }
  const material = await callWithRetry(() => create_material({
          name: sku.name + ' Material',
          material_template_id: laminateTemplate.id,
          properties: baseProps,
          texture_id: texture.id
  }));
  const display_pic = await callWithRetry(() => create_display_pic({ path: fullPath }));
        sku.material_id = material.id;
        sku.display_pic_id = display_pic.id;
        // ensure additional_properties remains an array
        if (typeof sku.additional_properties === 'string') {
          try { sku.additional_properties = JSON.parse(sku.additional_properties); } catch { sku.additional_properties = []; }
        }
      } catch (e) {
        console.warn('Asset creation failed for SKU', sku.name, e.message);
      }
    } else {
  // Optional debug: console.log('[assets][miss]', sku.name, 'model_no=', sku.model_no);
    }
    processed++;
    if (processed % 10 === 0 || processed === total) {
      const elapsed = ((Date.now() - startTs)/1000).toFixed(1);
      process.stdout.write(`\r[asset] ${processed}/${total} (${Math.round(processed/total*100)}%) ${elapsed}s`);
      if (processed === total) process.stdout.write('\n');
    }
  }
  return skus;
}

function normalize_name(n) {
  return n.replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

module.exports = {
  read_catalog_csv,
  get_laminate_template,
  ensure_category_tree,
  create_groups,
  base_sku_payload_from_rows,
  enrich_skus_with_assets
};

// ---- internal helpers ----
const MAX_RETRIES = 5;
const BASE_BACKOFF = 1000; // ms
async function callWithRetry(fn){
  let attempt = 0;
  while(true){
    try {
      return await fn();
    } catch(err){
      const status = err?.err?.response?.status || err?.response?.status;
      if(status === 429 && attempt < MAX_RETRIES){
        const delay = BASE_BACKOFF * Math.pow(2, attempt) + Math.random()*300;
        console.warn(`[rate-limit] 429 received. retrying in ${delay.toFixed(0)}ms (attempt ${attempt+1}/${MAX_RETRIES})`);
        await sleep(delay);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}
