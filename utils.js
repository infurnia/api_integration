const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const format = require('biguint-format');
require('dotenv').config()
const fetch = require("node-fetch");

/*
    CREDENTIALS
    set your credentials here
*/
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "rzNhSy7czdt7o6AlZQAzQlbXRYVKme0wYwVIzSDGJXMsqV32-JzoASDFL1T95bGwYVNZHRnzVSPWfT";
const EMAIL = process.env.EMAIL || "akash.dubey@infurnia.com";
let SERVER_PATH = process.env.SERVER_PATH || "https://productionbackend.infurnia.com";
const STORE_ID = process.env.STORE_ID || "34eb8eb39a5a179";
const BUSINESS_UNIT_ID = process.env.BUSINESS_UNIT_ID || "fca03a5c5366933a";

// Normalize server path (handle typos like httpd:// and add scheme if missing)
function normalizeServerPath(sp){
    if(!sp) return sp;
    const original = sp;
    sp = sp.trim();
    sp = sp.replace(/^httpd:\/\//i,'https://').replace(/^httpp:\/\//i,'https://');
    if(!/^https?:\/\//i.test(sp)) sp = 'https://' + sp.replace(/^\/*/, '');
    sp = sp.replace(/\/$/, '');
    if(original !== sp) console.warn(`[SERVER_PATH NORMALIZED] from="${original}" to="${sp}"`);
    return sp;
}
SERVER_PATH = normalizeServerPath(SERVER_PATH);


/*
    GENERATE ID
    this function is used to generate a unique id
*/
const generate_id = () => {
    var id = crypto.randomBytes(8);
    return format(id, 'hex');
}


const sleep = ms => new Promise(r => setTimeout(r, ms));

// Rate limit / retry configuration (env overridable)
const RETRY_ON_429 = process.env.RETRY_ON_429 !== 'false';
const BACKOFF_BASE_MS = parseInt(process.env.BACKOFF_BASE_MS || '1500', 10); // initial backoff
const BACKOFF_MAX_MS = parseInt(process.env.BACKOFF_MAX_MS || '20000', 10);   // capped exponential
const BACKOFF_JITTER_MS = parseInt(process.env.BACKOFF_JITTER_MS || '400', 10);
const RETRIES_BEFORE_LONG_WAIT = parseInt(process.env.RETRIES_BEFORE_LONG_WAIT || '6', 10); // after these retries, do a long wait
const LONG_WAIT_MS = parseInt(process.env.LONG_WAIT_MS || '60000', 10); // 60s cooldown
const MAX_TOTAL_RETRIES = parseInt(process.env.MAX_TOTAL_RETRIES || '0', 10); // 0 => infinite until success

// Client side proactive rate limiting (keep comfortably below 100/min server cap)
const RL_ENABLED = process.env.RL_ENABLED !== 'false';
// More conservative default (60/min) to avoid edge bursts + server side soft limits returning non-JSON bodies
let RL_MAX_PER_WINDOW = parseInt(process.env.RL_MAX_PER_WINDOW || '60', 10);
const RL_WINDOW_MS = parseInt(process.env.RL_WINDOW_MS || '60000', 10);
const RL_TRACE = process.env.RL_TRACE === 'true';
// Enforce a minimum spacing between calls (helps avoid micro-bursts right after sleep)
const RL_MIN_CALL_INTERVAL_MS = parseInt(process.env.RL_MIN_CALL_INTERVAL_MS || '80', 10);
let __rl_last_call_ts = 0;
let __rl_timestamps = [];

async function rateLimitGate(){
    if(!RL_ENABLED) return;
    const now = Date.now();
    // prune old
    if(__rl_timestamps.length && (now - __rl_timestamps[0]) > RL_WINDOW_MS){
        const cutoff = now - RL_WINDOW_MS;
        // fast prune
        let idx = 0; while(idx < __rl_timestamps.length && __rl_timestamps[idx] < cutoff) idx++;
        if(idx>0) __rl_timestamps.splice(0, idx);
    }
    if(__rl_timestamps.length >= RL_MAX_PER_WINDOW){
        const waitMs = RL_WINDOW_MS - (now - __rl_timestamps[0]);
        if (waitMs > 0){
            console.warn(`[rate-limit-client] quota ${__rl_timestamps.length}/${RL_MAX_PER_WINDOW} reached; sleeping ${(waitMs/1000).toFixed(2)}s`);
            await sleep(waitMs + 25); // add a small buffer
        }
    }
    // Minimum inter-call interval
    const sinceLast = Date.now() - __rl_last_call_ts;
    if (sinceLast < RL_MIN_CALL_INTERVAL_MS){
        const pad = RL_MIN_CALL_INTERVAL_MS - sinceLast;
        await sleep(pad);
    }
    __rl_last_call_ts = Date.now();
    __rl_timestamps.push(__rl_last_call_ts);
    if(RL_TRACE && (__rl_timestamps.length % 10 === 0)){
        console.log(`[rate-limit-client] ${__rl_timestamps.length} calls in current window`);
    }
}

function calcBackoff(attempt){
    const pow = Math.min(attempt, 30); // guard overflow
    const exp = Math.min(BACKOFF_BASE_MS * Math.pow(2, pow), BACKOFF_MAX_MS);
    const jitter = Math.random() * BACKOFF_JITTER_MS;
    return Math.round(exp + jitter);
}

async function handle429Wait(attempt){
    if (!RETRY_ON_429) return false;
    if (MAX_TOTAL_RETRIES && attempt >= MAX_TOTAL_RETRIES) return false;
    if ((attempt+1) % RETRIES_BEFORE_LONG_WAIT === 0) {
        console.warn(`[rate-limit] 429 persistence: long cooldown ${LONG_WAIT_MS}ms (attempt ${attempt+1})`);
        await sleep(LONG_WAIT_MS);
        return true;
    }
    const delay = calcBackoff(attempt);
    console.warn(`[rate-limit] 429 received. retrying in ${delay}ms (attempt ${attempt+1}${MAX_TOTAL_RETRIES?`/${MAX_TOTAL_RETRIES}`:''})`);
    await sleep(delay);
    return true;
}

/*
    GENERAL FETCH
    this function is used to make api calls
    @params
    url: api url
    full_url: if you want to use a full url instead of the server path
    method: http method
    headers: http headers
    body: http body
    is_form_data: if the body is form data
    data_field: the field in the response object that contains the data
*/
const general_fetch = async ({ url, full_url, method, headers, body, is_form_data, data_field }) => {
    let attempt = 0;
    while (true) {
        let respBody;
        try {
            if (!data_field) data_field = 'data';
            if (full_url) {
                url = full_url;
            } else {
                url = `${SERVER_PATH}/enterprise_api/${url}`;
            }
            if (!url) throw 'invalid url provided';
            if (!method) method = 'POST';
            if (!is_form_data) {
                if (!headers) {
                    headers = {
                        'Content-Type': 'application/json',
                        'infurnia-access-token': ACCESS_TOKEN,
                        'infurnia-email': EMAIL,
                        'infurnia-store-id': STORE_ID
                    };
                }
                if (body) body = JSON.stringify(body);
            }
            const options = { method, headers, body };
            await rateLimitGate();
            const resp = await fetch(url, options);
            const status = resp.status;
            const contentType = resp.headers.get('content-type') || '';
            let rawText = await resp.text();
            let parsed;
            if (/json/i.test(contentType) || /^[\[{]/.test(rawText.trim())) {
                try { parsed = JSON.parse(rawText); } catch(parseErr){
                    // fall through to heuristic handling
                }
            }
            if (!parsed) {
                // Heuristic: detect API limit / rate messages in plain text
                if (/api limit|rate limit|too many/i.test(rawText)) {
                    const proceed = await handle429Wait(attempt++);
                    if (proceed) continue; else throw { response: { status: 429 }, rawText };
                }
                // If not JSON and not rate-limit hint treat as error
                throw new Error('Non-JSON response received: ' + rawText.slice(0,120));
            }
            respBody = parsed;
            if (status === 429) {
                const proceed = await handle429Wait(attempt++);
                if (proceed) continue; else throw { response: { status }, respBody };
            }
            if (respBody.response_code == 1 || respBody.response_code == 0) {
                return respBody[data_field];
            }
            throw new Error('Server call failed with error -- ' + (respBody.error || respBody.message));
        } catch (err) {
            const status = err?.response?.status;
            if (status === 429) {
                const proceed = await handle429Wait(attempt++);
                if (proceed) continue;
            }
            // Dynamic back-off: if repeated limit errors, shrink window allowance
            if (/Non-JSON response.*API Limit/i.test(err?.message || '') && RL_MAX_PER_WINDOW > 30){
                RL_MAX_PER_WINDOW = Math.max(30, Math.floor(RL_MAX_PER_WINDOW * 0.8));
                console.warn(`[rate-limit-client] Adjusted RL_MAX_PER_WINDOW down to ${RL_MAX_PER_WINDOW} due to limit errors`);
            }
            return Promise.reject({ err, resp: respBody, info: 'Error in general_fetch ' + url });
        }
    }
}


/*
    UPLOAD FILE
    this function is used to upload files
    @params
    data: form data
    url: api url
    data_field: the field in the response object that contains the data
*/
const upload_file = async ({ data, url, data_field }) => {
    if (!data_field) data_field = 'data';
    let attempt = 0;
    while (true) {
        try {
            let config = {
                url: `${SERVER_PATH}/enterprise_api/${url}`,
                headers: {
                    'infurnia-access-token': ACCESS_TOKEN,
                    'infurnia-email': EMAIL,
                    'infurnia-store-id': STORE_ID,
                    ...(data ? data.getHeaders() : {})
                },
                data,
                method: 'POST'
            };
            await rateLimitGate();
            let resp = await axios(config);
            resp = resp.data;
            if (resp.response_code == 1 || resp.response_code == 0) {
                return resp[data_field];
            } else {
                throw new Error('Server call failed with error -- ' + resp.error);
            }
        } catch (err) {
            const status = err?.response?.status;
            if (status === 429) {
                const proceed = await handle429Wait(attempt++);
                if (proceed) continue;
            }
            console.error('Error in upload_file ->', err);
            return Promise.reject({ err, info: 'Error in upload_file ' + url });
        }
    }
}


/*
    FETCH SKU CATEGORY TYPES
    this function is used to fetch sku category types
*/
const fetch_sku_category_types = async () => {
    try {
        let sku_category_types = await general_fetch({ url: 'sku_category_type/get' });
        console.log('successfully fetched sku_category_types.');
        return sku_category_types;
    } catch(err) {
        console.error('Error in fetch_sku_category_types ->', err);
        return Promise.reject({ err, info: 'Error in fetch_sku_category_types' })
    }
}


/*
    FETCH SALES CHANNELS
    this function is used to fetch sales channels
*/
const fetch_sales_channels = async () => {
    try {
        let sales_channels = await general_fetch({ url: 'sales_channel/get_of_store', body: {include_price_type_mapping: true} });
        console.log('successfully fetched sales channels');
        return sales_channels;
    } catch(err) {
        console.error('Error in fetch_sales_channels ->', err);
        return Promise.reject({ err, info: 'Error in fetch_sales_channels' })
    }
}


/*
    FETCH MATERIAL TEMPLATES
    this function is used to fetch material templates
 */
const fetch_material_templates = async () => {
    try {
        let material_templates = await general_fetch({ url: 'material_template/get' });
        console.log('successfully fetched material_templates.');
        return material_templates;
    } catch(err) {
        console.error('Error in fetch_material_templates ->', err);
        return Promise.reject({ err, info: 'Error in fetch_material_templates' })
    }
}


/*
    CREATE SKU CATEGORY
    this function is used to create sku category
    @params
    name: name of the sku category
    sku_category_type_id: id of the sku category type
    sku_division_id: id of the sku division
    business_unit_id: business unit id
*/
const create_sku_category = async ({ name, sku_category_type_id, sku_division_id, business_unit_id }) => {
    try {
        let sku_category_data = {
            name,
            sku_category_type_id,
            sku_division_id,
            business_unit_id
        };
        console.log('body for cat creation:::', sku_category_data);
        let sku_category = await general_fetch({ url: 'sku_category/create', body: sku_category_data }); 
        console.log('successfully created sku_category with ID -> ', sku_category.id);
        return sku_category;
    } catch(err) {
        console.error('Error in create_sku_category ->', err);
        return Promise.reject({ err, info: 'Error in create_sku_category' })
    }
}


/*
    CREATE SKU SUB CATEGORY
    this function is used to create sku sub category
    @params
    name: name of the sku sub category
    sku_category_id: id of the sku category
    order: order of the sku sub category
    business_unit_id: business unit id 
*/
const create_sku_sub_category = async ({ name, sku_category_id, order, business_unit_id }) => {
    try {
        let sku_sub_category_data = {
            name,
            sku_category_id,
            order,
            business_unit_id
        };
        let sku_sub_category = await general_fetch({ url: 'sku_sub_category/create', body: sku_sub_category_data });
        console.log('successfully created sku_sub_category with ID -> ', sku_sub_category.id);
        return sku_sub_category;
    } catch(err) {
        console.error('Error in create_sku_sub_category ->', err);
        return Promise.reject({ err, info: 'Error in create_sku_sub_category' })
    }
}


/*
    CREATE SKU GROUP
    this function is used to create sku group
    @params
    name: name of the sku group
    sku_sub_category_id: id of the sku sub category
    order: order of the sku group
    business_unit_id: business unit id
*/
const create_sku_group = async ({ name, sku_sub_category_id, order, business_unit_id }) => {
    try {
        let sku_group_data = {
            name,
            sku_sub_category_id,
            order,
            business_unit_id
        };
        let sku_group = await general_fetch({ url: 'sku_group/create', body: sku_group_data });
        console.log('successfully created sku_group with ID -> ', sku_group.id);
        return sku_group;
    } catch(err) {
        console.error('Error in create_sku_group ->', err);
        return Promise.reject({ err, info: 'Error in create_sku_group' })
    }
}


/*
    CREATE TEXTURE
    this function is used to create texture
    @params
    path: path of the texture file
    name: name of the texture
*/
const create_texture = async ({ path, name }) => {
    try {
        let form = new FormData();
        form.append('file', fs.createReadStream(path));
        form.append('name', name);
        texture = await upload_file({ url: 'texture/add', data: form });
        console.log('successfully created texture with ID -> ', texture.id);
        return texture;
    } catch(err) {
        console.error('Error in create_texture ->', err);
        return Promise.reject({ err, info: 'Error in create_texture' })
    }
}


/*
    CREATE MATERIAL
    this function is used to create material
    @params
    name: name of the material
    properties: properties of the material template used
    texture_id: id of the texture
    material_template_id: id of the material template
*/
const create_material = async ({ name, properties, texture_id, material_template_id }) => {
    try {
        let material_data = {
            name: name,
            material_template_id: material_template_id,
            properties: JSON.stringify({
                ...properties,
                ...(texture_id ? { map: texture_id } : {})
            })
        };
        let material = await general_fetch({ url: 'material/add', body: material_data });
        console.log('successfully created material with ID -> ', material.id);
        return material;
    } catch(err) {
        console.error('Error in create_material ->', err);
        return Promise.reject({ err, info: 'Error in create_material' })
    }
}


/*
    CREATE DISPLAY PIC
    this function is used to create display pic
    @params
    path: path of the display pic file
*/
const create_display_pic = async ({ path }) => {
    try {
        let form = new FormData();
        form.append('upl', fs.createReadStream(path));
        let display_pic = await upload_file({ url: 'image/add', data: form });
        console.log('successfully created display_pic with ID -> ', display_pic.id);
        return display_pic;
    } catch(err) {
        console.error('Error in create_display_pic ->', err);
        return Promise.reject({ err, info: 'Error in create_display_pic' })
    }
}


/*
    CREATE MODEL 3D
    this function is used to create model 3d
    @params
    high: false
    format: 'obj' | 'glb'
    path: path of the model 3d file (.obj or .glb)
    mtl_path: path of the .mtl file if format is .obj
*/
const create_model_3d = async ({ path, mtl_path }) => {
    try {
        let form = new FormData();
        form.append('high', 'false');
        form.append('file', fs.createReadStream(path));
        if(mtl_path && mtl_path.length) {
            form.append('format', 'obj');
            form.append('mtl_file', fs.createReadStream(mtl_path));
        } else {
            form.append('format', 'glb');
        }
        let model_3d = await upload_file({ url: 'model_3d/upload_asset', data: form });
        console.log('successfully created model_3d with ID -> ', model_3d.id);
        return model_3d;
    } catch(err) {
        console.error('Error in create_model_3d ->', err);
        return Promise.reject({ err, info: 'Error in create_model_3d' })
    }
}


/*
    BULK CREATE SKUS
    this function is used to bulk create skus
    @params
    sku_data: data of the skus to be created
    sku_category_id: id of the sku category
    business_unit_id: business unit id
*/
const bulk_create_skus = async ({ sku_data, sku_category_id, business_unit_id }) => {
    try {
        let bulk_create_attempt = await general_fetch({ url: 'sku_bulk_operation/create_attempt', body: { sku_category_id, type: 'upload', business_unit_id } });
        let created_skus = await general_fetch({ url: 'sku_bulk_operation/trigger_attempt', body: { bulk_operation_attempt_id: bulk_create_attempt.id, data: sku_data } });
        console.log('successfully created skus with IDs -> ', created_skus.map(sku => sku.id));
        return created_skus;
    } catch(err) {
        console.error('Error in bulk_create_skus ->', err);
        return Promise.reject({ err, info: 'Error in bulk_create_skus' })
    }
}

/*
    CREATE CABINET SKUs
    this function is used to bulk create cabinet skus
    @params
        sku_data: data of the skus to be created
    @return
        request id (which can be used to fetch the status)
*/
const create_cabinets = async (sku_data) => {
    try {
        let create_cabinet_resp = await general_fetch({ url: 'production_detail/create_cabinet_skus', body: { data: sku_data }});
        console.log('successfully created an attempt to bulk create cabinets with request id -> ', create_cabinet_resp.request_batch_id);
        return create_cabinet_resp;
    } catch(err) {
        console.error('Error in create_cabinets ->', err);
        return Promise.reject({ err, info: 'Error in create_cabinets' });
    }
}


/*
    GET STATUS OF CREATE CABINET SKUs
    this function is used to fetch the status of create cabinet skus request
    @params
        id: id of create cabinet request
    @return
        {
            status: 'completed' | 'ongoing' | 'failed'
            sku_ids: [<successfully created sku ids>] | []
        }
*/
const get_create_cabinet_status = async (id) => {
    try {
        let resp = await general_fetch({ url: 'production_detail/get_bulk_create_sku_status', body: { id }});
        console.log('successfully requested the status of create cabinets with request id -> ', id, 'with status ->', resp?.status);
        return resp;
    } catch(err) {
        console.error('Error in get_create_cabinet_status ->', err);
        return Promise.reject({ err, info: 'Error in get_create_cabinet_status' })
    }
}

/*
    REQUEST PRICING QUOTATION IN JSON FORMAT
    this function is used to find pricing quotation for a design branch in json format
    @params
        sku_data: data of the skus to be created
    @return
        request id (which can be used to fetch the status)
*/
const init_core_request = async (body) => {
    try {
        let resp = await general_fetch({ url: 'production_detail/get_output', body});
        console.log('successfully created an attempt to request download reports from core with id -> ', resp.request_batch_id);
        return resp;
    } catch(err) {
        console.error('Error in init_core_request ->', err);
        return Promise.reject({ err, info: 'Error in init_core_request' });
    }
}


/*
    GET STATUS OF CREATE CABINET SKUs
    this function is used to fetch the status of create cabinet skus request
    @params
        id: id of create cabinet request
    @return
        {
            status: 'completed' | 'ongoing' | 'failed'
            sku_ids: [<successfully created sku ids>] | []
        }
*/
const get_status_for_core_request = async (id) => {
    try {
        let resp = await general_fetch({ url: 'production_detail/get_status', body: { ids: [id] }});
        console.log('successfully found the status of download reports request from core with id -> ', id, 'and status ->', resp?.[0]?.status);
        return resp[0];
    } catch(err) {
        console.error('Error in get_status_for_core_request ->', err);
        return Promise.reject({ err, info: 'Error in get_status_for_core_request' })
    }
}

/*
    FETCH STORE DETAILS
    Used to get the default business unit id in your store
*/
const get_store_info = async () => {
    try {
        const data = await general_fetch({ url: 'store/get_info' });
        console.log('succesfully fetched the store details -> ', data)
        return data;
    } catch (err) {
        console.error('Error in get_store_info ->', err);
        return Promise.reject({ err, info: 'Error in get_store_info' })
    }
}

/*
    FETCH ALL SUB CATEGORIES
    this function is used to fetch sub category tree (both owned/subscribed) for a given store (business_unit_id :== NULL) or business unit
    @param business_unit_id (optional)
*/
const get_all_sub_categories = async (business_unit_id) => {
    try {
        const data = await general_fetch({ url: 'inventory/get_all_sub_categories', body: {business_unit_id} });
        console.log('succesfully fetched the complete sub categories tree -> ', data)
        return data;
    } catch(err) {
        console.error('Error in get_all_sub_categories ->', err);
        return Promise.reject({ err, info: 'Error in get_all_sub_categories' })
    }
}


/*
    FETCH GROUP TREE
    this function is used to fetch sku group and underlying skus for a given sku category id
    @param sku_sub_category_id: mandatory
    @param business_unit_id: optional (if provided, it will fetch the underlying groups in the business unit otherwise in the Org)
*/
const get_groups = async (sku_sub_category_id, business_unit_id) => {
    try {
        const data = await general_fetch({ url: 'inventory/get_groups', body: { sku_sub_category_id, business_unit_id } });
        console.log(`succesfully fetched all the sku groups for sku sub category id: ${sku_sub_category_id} -> `, data)
        return data;
    } catch(err) {
        console.error('Error in get_groups ->', err);
        return Promise.reject({ err, info: 'Error in get_groups' })
    }
}


/*
    BULK REMOVE SKUs
    this function is used to remove skus from store
    @params
    id: sku ids (array of strings)
*/
const remove_skus = async (ids, business_unit_id) => {
    try {
        await general_fetch({ url: 'sku/remove_from_business_unit', body: { sku_ids: ids, business_unit_id } });
        console.log('successfully removed skus with IDs -> ', ids);
        return "OK";
    } catch(err) {
        console.error('Error in remove_skus ->', err);
        return Promise.reject({ err, info: 'Error in remove_skus' })
    }
}

/*
    BULK REMOVE SKU GROUPs (only owned)
    this function is used to remove owned sku groups 
    @params
    ids: sku group ids (array of strings)
*/
const remove_sku_group = async (ids, business_unit_id) => {
    try {
        await general_fetch({ url: 'sku_group/remove_from_business_unit', body: { sku_group_ids: ids, business_unit_id } });
        console.log('successfully removed sku group with IDs -> ', ids);
        return "OK";
    } catch(err) {
        console.error('Error in remove_sku_group ->', err);
        return Promise.reject({ err, info: 'Error in remove_sku_group' })
    }
}

/*
    REMOVE SKU SUB CATEGORY (only owned)
    this function is used to remove a given sku sub category id
    this function will only work when all sku groups mapped to this sku sub category are removed first
    @params
    id: a given sku sub category id
*/
const remove_sku_sub_category = async (id) => {
    try {
        await general_fetch({ url: 'sku_sub_category/deprecate', body: { sku_sub_category_id: id } });
        console.log('successfully removed sku sub category with ID -> ', id);
        return "OK";
    } catch(err) {
        console.error('Error in remove_sku_sub_category ->', err);
        return Promise.reject({ err, info: 'Error in remove_sku_sub_category' })
    }
}

/*
    REMOVE SKU CATEGORY (only owned)
    this function is used to remove a given sku category id
    this function will only work when all sku sub categories mapped to this sku category are removed first
    @params
    id: a given sku category id
*/
const remove_sku_category = async (id) => {
    try {
        console.log('Removing sku category with ID -> ', id);
        await general_fetch({ url: 'sku_category/deprecate', body: { sku_category_id: id } });
        console.log('successfully removed sku category with ID -> ', id);
        return "OK";
    } catch(err) {
        console.error('Error in remove_sku_category ->', err);
        return Promise.reject({ err, info: 'Error in remove_sku_category' })
    }
}

/*
    ADD BRAND
    this function is used to add a new brand
    @params
    name: name of the brand
*/
const add_brand = async (name) => {
    try {
        const data = await general_fetch({ url: 'brand/add', body: { name } });
    // data might be { brand: {...} } or direct brand object
    const added = data?.brand || data;
    console.log('successfully added brand -> ', added?.name || name);
    return data;
    } catch(err) {
        console.error('Error in add_brand ->', err);
        return Promise.reject({ err, info: 'Error in add_brand' })
    }
}

/*
    GET BRANDS
    this function is used to get all the brands
*/
const get_brands = async () => {
    try {
        const data = await general_fetch({ url: 'brand/get' });
        console.log('successfully fetched all the brands -> ', data);
        return data;
    } catch(err) {
        console.error('Error in get_brands ->', err);
        return Promise.reject({ err, info: 'Error in get_brands' })
    }
}

/*
    UPDATE SKU
    this function is used to update a given sku
    @params
    sku_id: id of the sku to be updated
    sku_data: data to be updated
*/
const update_sku = async (sku_id, sku_data) => {
    try {
        console.log('sku_update payload::', sku_id, sku_data);
        let form = new FormData();
        form.append('sku_id', sku_id);
        Object.keys(sku_data).forEach(key => {
            console.log('key:', key);
            if (sku_data[key]) form.append(key, sku_data[key]);
        })
        const data = await upload_file({ url: 'sku/update', data: form });
        console.log('successfully updated sku -> ', sku_id);
        return data;
    } catch(err) {
        console.error('Error in update_sku ->', err);
        return Promise.reject({ err, info: 'Error in update_sku' })
    }
}

/**
 * Disable rendering on a design branch
 * @param {*} design_branch_id 
 * @returns 
 */
const disable_rendering = async (design_branch_id) => {
    try {
        const data = await general_fetch({ url: 'design_branch/update_rendering_enabled_status', body: { design_branch_id, status: 'disable' } });
        console.log('successfully disabled rendering on design branch with id -> ', design_branch_id);
        return data;
    } catch(err) {
        console.error('Error in disable_rendering ->', err);
        return Promise.reject({ err, info: 'Error in disable_rendering' })
    }
}

/**
 * Enable rendering on a design branch
 * @param {*} design_branch_id 
 * @returns 
 */
const enable_rendering = async (design_branch_id) => {
    try {
        const data = await general_fetch({ url: 'design_branch/update_rendering_enabled_status', body: { design_branch_id, status: 'enable' } });
        console.log('successfully enabled rendering on design branch with id -> ', design_branch_id);
        return data;
    } catch(err) {
        console.error('Error in enable_rendering ->', err);
        return Promise.reject({ err, info: 'Error in enable_rendering' })
    }
}

/**
 * Create a new Tag
 * @param {*} name - Name of the new Tag
 * @returns 
 */
const create_tag = async (name) => {
    try {
        const data = await general_fetch({ url: 'tag/add', body: { name } });
        console.log('successfully created a tag with details -> ', data[0]);
        return data[0].id;
    } catch(err) {
        console.error('Error in create_tag ->', err);
        return Promise.reject({ err, info: 'Error in create_tag' })
    }
}

/**
 * Get attach Tags in the SKU
 * @param {*} sku_id - SKU ID
 * @returns 
 */
const get_tags_on_sku = async (sku_id) => {
    try {
        const data = await general_fetch({ url: 'sku/get_tags', body: { sku_ids: [sku_id] } });
        console.log(`successfully got the tags attached to the SKU id: ${sku_id} -> `, data?.[sku_id]?.sku_tags);
        return data?.[sku_id]?.sku_tags ?? [];
    } catch(err) {
        console.error('Error in create_tag ->', err);
        return Promise.reject({ err, info: 'Error in get_tags_on_sku' })
    }
}

/**
 * Attach Tags in the SKU
 * @param {*} sku_id - SKU ID
 * @param {*} tag_ids - Array of Tag IDs
 * @returns 
 */
const attach_tags_on_sku = async (sku_id, tag_ids) => {
    try {
        const data = await general_fetch({ url: 'sku/attach_tags', body: { sku_ids: [sku_id], tag_ids } });
        console.log(`successfully attached the following tags to the SKU id: ${sku_id}`);
        return data;
    } catch(err) {
        console.error('Error in create_tag ->', err);
        return Promise.reject({ err, info: 'Error in attach_tags_on_sku' })
    }
}

/**
 * Get all renders fired for a given design ID
 * @param {*} design_id - Design ID
 * @returns 
 */
const get_renders_for_design = async (design_id) => {
    try {
        const data = await general_fetch({ url: 'render/get_all_of_design', body: { design_id } });
        console.log(`successfully found renders fired for design id: ${design_id}`);
        return data;
    } catch(err) {
        console.error('Error in create_tag ->', err);
        return Promise.reject({ err, info: 'Error in get_renders_for_design' })
    }
}

const add_skus_to_sc = async ({sku_ids, sales_channel_id}) => {
    try{
        const data = await general_fetch({url : 'sales_channel/add_skus', body : {sku_ids, sales_channel_id}})
        console.log(`successfully added the following skus to the sales_channel with id: ${sales_channel_id}`);
        return data;
    }catch(err) {
        console.error('Error in adding skus to sc ->', err);
        return Promise.reject({err, info : 'Error in add_skus_to_sc'})
    }
}

const remove_skus_from_sc = async ({sku_ids, sales_channel_id}) => {
    try{
        const data = await general_fetch({url : 'sales_channel/remove_skus', body : {sku_ids, sales_channel_id}})
        console.log(`successfully removed the following skus from the sales_channel with id: ${sales_channel_id}`);
        return data;
    }catch(err) {
        console.error('Error in removing skus to sc ->', err);
        return Promise.reject({err, info : 'Error in remove_skus_from_sc'})
    }
}

const price_update = async ({sku_id = null, business_unit_id = null, price = null, tax = null, margin = null, display_unit= null, sales_channel_id = null, price_type_id = null} = {sku_id : null, business_unit_id : null, price : null, tax : null, margin : null, display_unit: null, sales_channel_id : null, price_type_id : null}) => {
    try{
            const data = await general_fetch({url : 'price/update', body : {sku_id, business_unit_id, price, tax, margin, display_unit, sales_channel_id, price_type_id}})
            console.log(`successfully updated the price of sku ${sku_id}`);
            return data;
        }catch(err) {
            console.error('Error in adding adding skus to sc ->', err);
            return Promise.reject({err, info : 'Error in add_skus_to_sc'})
        }
}

const update_sku_group = async ({sku_group_id = null, business_unit_id = null, name = null, sku_sub_category_id = null} = {sku_group_id : null, business_unit_id : null, name : null, sku_sub_category_id : null}) => {
    try{
            const data = await general_fetch({url : 'sku_group/update', body : {sku_group_id, business_unit_id, name, sku_sub_category_id}});
            console.log(`successfully updated the sku group with id ${sku_group_id}`);
            return data;
        }catch(err) {
            console.error('Error in updating sku group ->', err);
            return Promise.reject({err, info : 'Error in update_sku_group'})
        }
}


module.exports = {
    update_sku_group,
    price_update,
    remove_skus_from_sc,
    add_skus_to_sc,
    generate_id,
    sleep,
    fetch_sku_category_types,
    fetch_sales_channels,
    fetch_material_templates,
    create_sku_category,
    create_sku_sub_category,
    create_sku_group,
    create_texture,
    create_material,
    create_display_pic,
    create_model_3d,
    bulk_create_skus,
    create_cabinets,
    get_create_cabinet_status,
    init_core_request,
    get_status_for_core_request,
    get_store_info,
    get_all_sub_categories,
    get_groups,
    remove_skus,
    remove_sku_group,
    remove_sku_sub_category,
    remove_sku_category,
    get_brands,
    add_brand,
    update_sku,
    disable_rendering,
    enable_rendering,
    create_tag,
    get_tags_on_sku,
    attach_tags_on_sku,
    get_renders_for_design,
    STORE_ID,
    BUSINESS_UNIT_ID,
    SERVER_PATH
}
