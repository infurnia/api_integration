#!/usr/bin/env node
/**
 * Finishes (Laminates) Catalog Uploader
 * Features:
 * - Creates a category (Hinshitsu Finishes) and dynamic subcategories from CSV Subcategory column
 * - Creates groups lazily per (Subcategory + Group Name)
 * - Adds SKUs with pricing from Purchase Price canonicalized to per sq mm (baseline) while keeping display_unit (e.g. 'sq_foot')
 * - Brand resolution (create missing brands)
 * - Edge Band Mapping -> linked_skus (first token visible, second token invisible, ignore rest)
 *      Tokens parsed by splitting `Edgeband Mapping` column on ',' or '&'
 *      Mapping resolution attempts exact SKU name match, then contains match, then model_no match against existing Edge Band SKUs
 * - Resume capability via progress JSON (finishes_progress.json)
 * - Rate limiting / retry handled centrally in utils
 */

const path = require('path');
const fs = require('fs');
const {
  read_catalog_csv,
  get_laminate_template
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

// ---- Config ----
const CSV_PATH = path.join(__dirname, '../../hinshitsu_catalog/hinshitsu_finishes.csv');
const PROGRESS_PATH = path.join(__dirname, '../../finishes_progress.json');
const IMAGES_DIR = path.join(__dirname, '../../hinshitsu_catalog/hinshitsu_images/Finishes'); // if images later available
const ENABLE_ASSETS = process.env.FINISHES_ASSETS === 'true';
const CATEGORY_NAME = process.env.FINISHES_CATEGORY_NAME || 'Hinshitsu Finishes';
const SKU_CATEGORY_TYPE_ID = process.env.FINISHES_CATEGORY_TYPE_ID || 'cabinet_finish_finish';
const SKU_DIVISION_ID = process.env.FINISHES_DIVISION_ID || 'finish';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '40', 10);
const FORCE_RESTART = /^true$/i.test(process.env.FORCE_RESTART || 'false');
// Provide explicit edge band sub category id to speed mapping (optional)
const EDGEBAND_SUB_CATEGORY_ID = process.env.EDGEBAND_SUB_CATEGORY_ID || '6b482ca2f58dcd57';
const EDGE_BAND_PROGRESS_PATH = path.join(__dirname, '../../edge_bands_progress.json');
const USE_EDGE_BAND_PROGRESS_CHECK = process.env.USE_EDGE_BAND_PROGRESS_CHECK !== 'false';
const EDGE_INDEX_DEBUG = process.env.FINISHES_EDGE_DEBUG === 'true';

// ---- Progress helpers ----
async function load_progress(){
  if (!fs.existsSync(PROGRESS_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(PROGRESS_PATH,'utf8')); } catch { return null; }
}
function save_progress(obj){
  fs.writeFileSync(PROGRESS_PATH + '.tmp', JSON.stringify(obj,null,2));
  fs.renameSync(PROGRESS_PATH + '.tmp', PROGRESS_PATH);
}

// ---- Brand handling ----
async function ensure_brand_map(){
  const apiBrands = await get_brands();
  const existing = new Map();
  if (Array.isArray(apiBrands?.brands)) apiBrands.brands.forEach(b => existing.set(b.name.toLowerCase(), b));
  else if (Array.isArray(apiBrands)) apiBrands.forEach(b => existing.set(b.name.toLowerCase(), b));
  return {
    getOrCreate: async (name) => {
      if(!name) return null;
      const key = name.trim().toLowerCase();
      if (existing.has(key)) return existing.get(key).id;
      try {
        const created = await add_brand(name.trim());
        const brandObj = created?.brand || created;
        if (brandObj?.name) existing.set(brandObj.name.toLowerCase(), brandObj);
        return brandObj?.id || null;
      } catch(e){
        console.warn('[finishes] brand create failed', name, e.message);
        return null;
      }
    }
  };
}

// ---- Edge Band SKU Index (enhanced with progress file sanity + verbose logging) ----
async function buildEdgeBandIndex(){
  console.log('[finishes][edge-index] Starting edge band index build');
  const index = { byName: new Map(), all: [], source: 'api' };
  if(USE_EDGE_BAND_PROGRESS_CHECK && fs.existsSync(EDGE_BAND_PROGRESS_PATH)){
    try {
      const raw = fs.readFileSync(EDGE_BAND_PROGRESS_PATH,'utf8');
      const parsed = JSON.parse(raw);
      const groupCount = parsed && parsed.groups ? Object.keys(parsed.groups).length : 0;
      console.log('[finishes][edge-index] edge_bands_progress.json groups:', groupCount, 'row_index:', parsed.row_index, 'category_id:', parsed.category_id);
      if(groupCount === 0){
        throw new Error('edge_bands_progress.json has 0 groups; edge bands upload incomplete. Aborting finishes upload.');
      }
    } catch(e){
      console.warn('[finishes][edge-index] Could not parse progress file:', e.message);
    }
  } else {
    console.log('[finishes][edge-index] Progress file check skipped or file missing');
  }
  try {
    let subCategoryId = EDGEBAND_SUB_CATEGORY_ID;
    if(!subCategoryId){
      const tree = await get_all_sub_categories(BUSINESS_UNIT_ID);
      if(EDGE_INDEX_DEBUG) console.log('[finishes][edge-index] fetched full sub-category tree');
      const flat = [];
      const collect = (arr) => { if(Array.isArray(arr)) arr.forEach(o => { flat.push(o); if(o.children) collect(o.children); }); };
      collect(tree?.owned); collect(tree?.subscribed); collect(tree?.others);
      if(EDGE_INDEX_DEBUG) console.log('[finishes][edge-index] flattened sub categories:', flat.length);
      const found = flat.find(n => /all edge bands/i.test(n.name));
      if(found){
        subCategoryId = found.id;
        console.log('[finishes][edge-index] Resolved edge band sub_category_id ->', subCategoryId);
      } else {
        throw new Error('Edge band sub category "All Edge Bands" not located.');
      }
    } else {
      console.log('[finishes][edge-index] Using provided EDGEBAND_SUB_CATEGORY_ID ->', subCategoryId);
    }
    const groups = await get_groups(subCategoryId, BUSINESS_UNIT_ID);
    if(!Array.isArray(groups) || groups.length === 0){
      throw new Error('get_groups returned no groups for edge bands; cannot continue.');
    }
    console.log('[finishes][edge-index] group count:', groups.length);
    let skuCounter = 0;
    (groups || []).forEach((g, gi) => {
      const skuList = g.skus || g.sku || [];
      if(EDGE_INDEX_DEBUG) console.log(`[finishes][edge-index] g#${gi+1} name="${g.name}" id=${g.id} rawKeys=${Object.keys(g).join(',')} skus=${skuList.length}`);
      if(skuList.length === 0 && EDGE_INDEX_DEBUG){
        console.log('[finishes][edge-index][warn] group has no sku array entries');
      }
      skuList.forEach((s, si) => {
        const keyName = (s.name || '').trim().toLowerCase();
        if(keyName && !index.byName.has(keyName)) index.byName.set(keyName, s);
        if(s.model_no){
          const modelKey = s.model_no.toString().trim().toLowerCase();
          if(modelKey && !index.byName.has(modelKey)) index.byName.set(modelKey, s);
        }
        // Map group name to first SKU as a resolution aid when tokens match group names
        if(si === 0){
          const groupKey = (g.name || '').trim().toLowerCase();
          if(groupKey && !index.byName.has(groupKey)) index.byName.set(groupKey, s);
        }
        index.all.push(s);
        skuCounter++;
      });
    });
    console.log('[finishes][edge-index] total edge band SKUs indexed:', skuCounter, '(unique keys:', index.byName.size + ')');
    if(skuCounter === 0){
      // Provide one sample group object for diagnostics
      const sample = groups && groups[0] ? Object.keys(groups[0]) : [];
      throw new Error('Edge band index empty (0 SKUs). Aborting. Sample group keys: ' + sample.join(','));
    }
  } catch(e){
    console.error('[finishes][edge-index] FATAL:', e.message);
    throw e;
  }
  return index;
}

function resolveEdgeBandToken(index, rawToken){
  if(!rawToken) return null;
  const token = rawToken.trim().toLowerCase();
  if(!token) return null;
  if(index.byName.has(token)) return index.byName.get(token);
  // contains match fallback (prefer shortest first)
  let candidate = index.all.find(s => (s.name||'').toLowerCase() === token);
  if(candidate) return candidate;
  candidate = index.all.find(s => (s.name||'').toLowerCase().includes(token));
  if(candidate) return candidate;
  candidate = index.all.find(s => (s.model_no||'').toString().toLowerCase() === token);
  if(candidate) return candidate;
  candidate = index.all.find(s => (s.model_no||'').toString().toLowerCase().includes(token));
  if(candidate) return candidate;
  // As last resort, attempt splitting token by whitespace and match startsWith
  const parts = token.split(/\s+/).filter(Boolean);
  if(parts.length > 1){
    candidate = index.all.find(s => parts.every(p => (s.name||'').toLowerCase().includes(p)));
    if(candidate) return candidate;
  }
  return candidate || null;
}

// Detailed resolver with method trace for logging
function resolveEdgeBandTokenDetailed(index, rawToken){
  const trace = { raw: rawToken, normalized: null, method: null, resolved_id: null };
  if(!rawToken) return trace;
  const token = rawToken.trim().toLowerCase();
  trace.normalized = token;
  if(!token) return trace;
  if(index.byName.has(token)){ const s = index.byName.get(token); trace.method='direct-key'; trace.resolved_id=s.id; return trace; }
  let candidate = index.all.find(s => (s.name||'').toLowerCase() === token);
  if(candidate){ trace.method='name-exact'; trace.resolved_id=candidate.id; return trace; }
  candidate = index.all.find(s => (s.name||'').toLowerCase().includes(token));
  if(candidate){ trace.method='name-contains'; trace.resolved_id=candidate.id; return trace; }
  candidate = index.all.find(s => (s.model_no||'').toString().toLowerCase() === token);
  if(candidate){ trace.method='model_no-exact'; trace.resolved_id=candidate.id; return trace; }
  candidate = index.all.find(s => (s.model_no||'').toString().toLowerCase().includes(token));
  if(candidate){ trace.method='model_no-contains'; trace.resolved_id=candidate.id; return trace; }
  const parts = token.split(/\s+/).filter(Boolean);
  if(parts.length > 1){
    candidate = index.all.find(s => parts.every(p => (s.name||'').toLowerCase().includes(p)));
    if(candidate){ trace.method='name-all-parts'; trace.resolved_id=candidate.id; return trace; }
    // Part-based fallback prioritizing code-like fragments (digits / hyphen / underscore)
    const scoredParts = parts.map(p => ({ p, score: (/\d/.test(p) ? 2 : 0) + (/[-_]/.test(p) ? 1 : 0) })).sort((a,b) => b.score - a.score);
    for(const { p } of scoredParts){
      const term = p.toLowerCase();
      if(term.length < 2) continue;
      if(index.byName.has(term)){ const s = index.byName.get(term); trace.method='part-direct-key'; trace.resolved_id=s.id; return trace; }
      let partCandidate = index.all.find(s => (s.name||'').toLowerCase() === term);
      if(partCandidate){ trace.method='part-name-exact'; trace.resolved_id=partCandidate.id; return trace; }
      partCandidate = index.all.find(s => (s.model_no||'').toString().toLowerCase() === term);
      if(partCandidate){ trace.method='part-model_no-exact'; trace.resolved_id=partCandidate.id; return trace; }
      partCandidate = index.all.find(s => (s.name||'').toLowerCase().includes(term));
      if(partCandidate){ trace.method='part-name-contains'; trace.resolved_id=partCandidate.id; return trace; }
      partCandidate = index.all.find(s => (s.model_no||'').toString().toLowerCase().includes(term));
      if(partCandidate){ trace.method='part-model_no-contains'; trace.resolved_id=partCandidate.id; return trace; }
    }
  }
  // Variant-suffix heuristic: if token lacks a trailing letter but variants with P / PP / L / T exist
  if(!trace.resolved_id){
    const baseMatch = token.match(/^(.*?)(?:\s+rehau)?$/); // ignore trailing brand keyword
    const core = baseMatch ? baseMatch[1] : token;
    if(/\d$/.test(core)){ // ends with digit -> try common suffixes
      const suffixes = ['p','pp','t','l'];
      for(const suf of suffixes){
        const attempt = core + suf;
        if(index.byName.has(attempt)){ const s = index.byName.get(attempt); trace.method='variant-suffix-'+suf; trace.resolved_id=s.id; return trace; }
        let variantCandidate = index.all.find(s => (s.model_no||'').toString().toLowerCase() === attempt);
        if(variantCandidate){ trace.method='variant-suffix-model-no-'+suf; trace.resolved_id=variantCandidate.id; return trace; }
        variantCandidate = index.all.find(s => (s.name||'').toLowerCase() === attempt);
        if(variantCandidate){ trace.method='variant-suffix-name-'+suf; trace.resolved_id=variantCandidate.id; return trace; }
      }
    }
  }
  // Additional pattern handling for non-standard edge band codes
  if(!trace.resolved_id){
    // Handle patterns like "E3 1050", "DC-501", "6105(HG)-Indaco", "SIDMARK SF-27A6"
    let cleanToken = token;
    // Remove common prefixes/brands and extract core codes
    cleanToken = cleanToken.replace(/^(e3|dc|sidmark|sf|hg|rehau)\s*[-\s]*/i, '');
    cleanToken = cleanToken.replace(/\([^)]*\)/g, ''); // remove parentheses content
    cleanToken = cleanToken.replace(/[-_]/g, ''); // remove separators
    cleanToken = cleanToken.trim();
    
    if(cleanToken && cleanToken !== token){
      if(index.byName.has(cleanToken)){ const s = index.byName.get(cleanToken); trace.method='pattern-cleaned'; trace.resolved_id=s.id; return trace; }
      let patternCandidate = index.all.find(s => (s.name||'').toLowerCase().includes(cleanToken));
      if(patternCandidate){ trace.method='pattern-name-contains'; trace.resolved_id=patternCandidate.id; return trace; }
      patternCandidate = index.all.find(s => (s.model_no||'').toString().toLowerCase().includes(cleanToken));
      if(patternCandidate){ trace.method='pattern-model_no-contains'; trace.resolved_id=patternCandidate.id; return trace; }
    }
  }
  trace.method='unresolved';
  return trace;
}

// ---- Group key ----
function build_group_key(row){
  return `${row.Subcategory}||${row['Group Name']}`.trim();
}

// Pricing canonicalization: store price as per sq mm irrespective of display unit.
// Supported input units: sq.ft (sqft), sq_ft, sq foot, sq mm (already canonical), sq_mm, mm^2 (treated as sq mm)
function canonicalizePrice(row){
  const raw = row['Purchase Price'];
  if(raw == null || raw === '') return null;
  const val = parseFloat(raw);
  if(!Number.isFinite(val)) return null;
  const unitRaw = (row['Pricing Unit'] || row['pricing_unit'] || '').toString().trim().toLowerCase();
  const SQFT_TO_SQMM = 304.8 * 304.8; // 92903.04
  let canonicalPerSqMm = val; // assume already per sq mm unless converted
  let display_unit = 'sq_foot';
  if(/sq.?ft|sqft|ft2|foot/.test(unitRaw)){
    // val given per sq.ft => convert
    canonicalPerSqMm = val / SQFT_TO_SQMM;
    display_unit = 'sq_foot';
  } else if(/sq.?mm|mm2|sqmm/.test(unitRaw) || unitRaw === 'sq_mm'){
    canonicalPerSqMm = val; // already per sq mm
    display_unit = 'sq_mm';
  } else if(/sq.?m|sqm|m2/.test(unitRaw)){
    // per square meter -> 1 m^2 = 1,000,000 sq mm
    canonicalPerSqMm = val / 1_000_000;
    display_unit = 'sq_meter';
  } else if(!unitRaw){
    // default assumption price provided per sq.ft (as per catalog) if unit blank
    canonicalPerSqMm = val / SQFT_TO_SQMM;
    display_unit = 'sq_foot';
  } else {
    // Unknown unit -> log & treat as sq.ft to be safe
    console.warn('[finishes] Unknown pricing unit encountered ->', unitRaw, 'treating as sq.ft');
    canonicalPerSqMm = val / SQFT_TO_SQMM;
    display_unit = 'sq_foot';
  }
  return { price_per_sq_mm: canonicalPerSqMm, display_unit };
}

async function main(){
  if(FORCE_RESTART && fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
  let progress = await load_progress();
  let rows;
  let category_id, sub_categories = {}, groups = {}, row_index = 0, pricingCtx = null, laminateTemplate, brandMap, rowsSerialized;
  let expected_groups_count, expected_subcategories_count, next_group_order = 1, next_sub_category_order = 1;
  let edgeBandIndex;
  // Edge band mapping failure tracking
  let edgeBandFailures = [];

  if(progress){
    try {
      ({ rowsSerialized, category_id, sub_categories = {}, groups, row_index, pricingCtx, expected_groups_count, expected_subcategories_count, next_group_order, next_sub_category_order } = progress);
      rows = JSON.parse(rowsSerialized);
      console.log('[finishes] Resuming from row', row_index, 'of', rows.length);
    } catch(e){
      console.warn('[finishes] Failed parsing progress file, starting fresh. Error:', e.message);
      progress = null;
    }
  }
  if(!progress){
    console.log('[finishes] Fresh run, reading CSV');
    rows = read_catalog_csv(CSV_PATH).filter(r => r['Group Name'] && r['SKU Name']);
    // Create category
    const cat = await create_sku_category({ name: CATEGORY_NAME, sku_category_type_id: SKU_CATEGORY_TYPE_ID, sku_division_id: SKU_DIVISION_ID, business_unit_id: BUSINESS_UNIT_ID });
    category_id = cat.id;
    // Pre-compute distinct counts for logging
    const distinctGroups = [...new Set(rows.map(r => build_group_key(r)))];
    const distinctSubcats = [...new Set(rows.map(r => (r.Subcategory||'').trim()).filter(Boolean))];
    expected_groups_count = distinctGroups.length;
    expected_subcategories_count = distinctSubcats.length;
    // Sales channel context
    const scResp = await fetch_sales_channels();
    const owned = scResp.sales_channels?.owned || [];
    const sc = owned.find(o => o.price_type_ids && o.price_type_ids.length > 0);
    if(!sc) throw new Error('No sales channel with price_type_ids found');
    pricingCtx = { sales_channel_id: sc.id, price_type_id: sc.price_type_ids[0], default_margin: 0 };
    laminateTemplate = await get_laminate_template();
    brandMap = await ensure_brand_map();
    progress = { rowsSerialized: JSON.stringify(rows), category_id, sub_categories, groups, row_index: 0, pricingCtx, expected_groups_count, expected_subcategories_count, next_group_order, next_sub_category_order };
    save_progress(progress);
  }

  if(!laminateTemplate) laminateTemplate = await get_laminate_template();
  if(!brandMap) brandMap = await ensure_brand_map();
  // Build edge band index once
  edgeBandIndex = await buildEdgeBandIndex();

  async function ensureSubCategory(name){
    const key = (name||'').trim();
    if(!key) return null;
    if(sub_categories[key]) return sub_categories[key].id;
    const scObj = await create_sku_sub_category({ name: key, sku_category_id: category_id, order: next_sub_category_order, business_unit_id: BUSINESS_UNIT_ID });
    sub_categories[key] = { id: scObj.id, order: next_sub_category_order };
    next_sub_category_order += 1;
    const createdCount = Object.keys(sub_categories).length;
    console.log(`[finishes] subcategory ${createdCount}/${expected_subcategories_count} created -> ${key} (${scObj.id})`);
    progress.sub_categories = sub_categories;
    progress.next_sub_category_order = next_sub_category_order;
    save_progress(progress);
    await sleep(60);
    return scObj.id;
  }

  const total = rows.length;
  while(row_index < total){
    const slice = rows.slice(row_index, row_index + BATCH_SIZE);
    const batchStart = row_index;
    console.log(`[finishes] Preparing batch starting at row_index ${batchStart}`);
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
        console.log(`[finishes] group ${createdCount}/${expected_groups_count} created -> ${r['Group Name']} (${grp.id})`);
        progress.groups = groups;
        progress.next_group_order = next_group_order;
        save_progress(progress);
        await sleep(50);
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
            price: priceInfo.price_per_sq_mm, // canonical per sq mm
            margin: 0,
            tax: 0,
            display_unit: priceInfo.display_unit // for UI display
          }]
        }];
      }
      // Linked Edge Bands (strict)
      let linked_skus = [];
      const globalRow = row_index + sku_data.length;
      const mappingRaw = (r['Edgeband Mapping'] || '').trim();
      let parsedTokens = [];
      if(mappingRaw){
        const tokens = mappingRaw.split(/[,&/|;+]/).map(t => t.trim()).filter(Boolean);
        const uniq = [];
        for(const t of tokens){ if(!uniq.includes(t)) uniq.push(t); }
        parsedTokens = uniq.slice(0,2);
        console.log(`[finishes][row ${globalRow}][mapping] raw:"${mappingRaw}" -> parsed: ${parsedTokens.join(' | ')}`);
        if(!parsedTokens.length){
          throw new Error(`[finishes] Mapping column present but produced no valid tokens for SKU "${r['SKU Name']}" at global row ${globalRow}.`);
        }
        const mappingErrors = [];
        const resolutionTraces = [];
        parsedTokens.forEach((tok, idx) => {
          const trace = resolveEdgeBandTokenDetailed(edgeBandIndex, tok);
          resolutionTraces.push(trace);
          if(trace.resolved_id){
            linked_skus.push({ id: trace.resolved_id, quantity: 0, type: idx === 0 ? 'visible' : 'invisible' });
          } else {
            mappingErrors.push(tok);
          }
        });
        console.log(`[finishes][row ${globalRow}][mapping-results]`, resolutionTraces);
        if(mappingErrors.length || linked_skus.length !== parsedTokens.length){
          const failureInfo = {
            row: globalRow,
            sku_name: r['SKU Name'],
            group_name: r['Group Name'],
            raw_mapping: mappingRaw,
            parsed_tokens: parsedTokens,
            resolved_count: linked_skus.length,
            expected_count: parsedTokens.length,
            missing_tokens: mappingErrors,
            resolution_traces: resolutionTraces
          };
          edgeBandFailures.push(failureInfo);
          console.warn(`[finishes][row ${globalRow}] EDGE BAND WARNING: Incomplete mapping. Expected ${parsedTokens.length}, got ${linked_skus.length}. Missing: ${mappingErrors.join(', ') || 'partial resolution'}`);
          // Continue without linked_skus instead of throwing
          linked_skus = [];
        }
        console.log(`[finishes][row ${globalRow}][linked_skus]`, linked_skus);
      } else {
        console.log(`[finishes][row ${globalRow}][mapping] no mapping provided`);
      }
      const skuPayload = {
        id: generate_id(),
        name: r['SKU Name']?.trim() || r['Group Name']?.trim(),
        model_no: (r['SKU ID ( Model No)'] || '').toString().trim() || null,
        sku_group_id: group_id,
        sub_category: subCatId,
        linked_skus,
        additional_properties: null,
        placement_id: null,
        brand_id,
        sales_channels,
        // thickness captured as depth if present
        depth: (() => { const val = parseFloat(r['Thickness (mm)']); return Number.isFinite(val) ? val : null; })(),
        business_unit_id: BUSINESS_UNIT_ID,
        sku_checked: true,
        group_name: r['Group Name']?.trim()
      };
      console.log(`[finishes][row ${globalRow}][payload]`, JSON.stringify(skuPayload));
      sku_data.push(skuPayload);
    }
    try {
      // Optional asset enrichment if enabled and directory exists
      if(ENABLE_ASSETS && fs.existsSync(IMAGES_DIR)){
        try {
          const { enrich_skus_with_assets, get_laminate_template } = require('./common');
          if(!laminateTemplate) laminateTemplate = await get_laminate_template();
          console.log(`[finishes][assets] enriching ${sku_data.length} SKUs with images`);
          await enrich_skus_with_assets({ skus: sku_data, laminateTemplate, imagesDir: IMAGES_DIR });
        } catch(e){
          console.warn('[finishes][assets] enrichment failed', e.message);
        }
      }
      console.log(`[finishes] Creating ${sku_data.length} SKUs (rows ${row_index}..${row_index+sku_data.length-1})`);
      const created = await bulk_create_skus({ sku_data, sku_category_id: category_id, business_unit_id: BUSINESS_UNIT_ID });
      console.log(`[finishes] Created ${created.length} SKUs`);
      row_index += sku_data.length;
      progress.row_index = row_index;
      progress.category_id = category_id;
      progress.sub_categories = sub_categories;
      progress.groups = groups;
      progress.next_group_order = next_group_order;
      progress.next_sub_category_order = next_sub_category_order;
      save_progress(progress);
    } catch(err){
      console.error('[finishes] Batch failed at starting index', batchStart, err.message);
      save_progress(progress);
      throw err;
    }
    await sleep(300);
  }

  console.log('[finishes] Completed all rows');
  
  // Report edge band mapping failures
  if(edgeBandFailures.length > 0){
    console.log(`\n[finishes] EDGE BAND MAPPING FAILURES SUMMARY:`);
    console.log(`Total failures: ${edgeBandFailures.length}`);
    console.log(`Success rate: ${((total - edgeBandFailures.length) / total * 100).toFixed(1)}%\n`);
    
    // Group failures by mapping pattern for analysis
    const failuresByPattern = {};
    edgeBandFailures.forEach(f => {
      const pattern = f.raw_mapping.replace(/\d+/g, 'N').replace(/[A-Z]{2,}/g, 'X');
      if(!failuresByPattern[pattern]) failuresByPattern[pattern] = [];
      failuresByPattern[pattern].push(f);
    });
    
    console.log('Failure patterns:');
    Object.entries(failuresByPattern).forEach(([pattern, failures]) => {
      console.log(`  ${pattern}: ${failures.length} cases`);
      if(failures.length <= 3){
        failures.forEach(f => console.log(`    Row ${f.row}: "${f.raw_mapping}" (${f.sku_name})`));
      } else {
        failures.slice(0,2).forEach(f => console.log(`    Row ${f.row}: "${f.raw_mapping}" (${f.sku_name})`));
        console.log(`    ... and ${failures.length - 2} more`);
      }
    });
    
    // Export detailed failures to JSON for analysis
    const failuresPath = path.join(__dirname, '../../finishes_edge_band_failures.json');
    fs.writeFileSync(failuresPath, JSON.stringify({
      summary: {
        total_rows: total,
        failed_mappings: edgeBandFailures.length,
        success_rate: ((total - edgeBandFailures.length) / total * 100).toFixed(1) + '%'
      },
      failures: edgeBandFailures,
      patterns: failuresByPattern
    }, null, 2));
    console.log(`\nDetailed failure analysis saved to: ${failuresPath}`);
  } else {
    console.log('[finishes] All edge band mappings resolved successfully!');
  }
}

if(require.main === module){
  main().catch(e => { console.error('Finishes upload failed', e); process.exit(1); });
}
