const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const format = require('biguint-format');


/*
    CREDENTIALS
    set your credentials here
*/
const ACCESS_TOKEN = "xxxx";
const EMAIL = "xxxx";
const SERVER_PATH = "xxxx";
const STORE_ID = "xxxx";


/*
    GENERATE ID
    this function is used to generate a unique id
*/
const generate_id = () => {
    var id = crypto.randomBytes(8);
    return format(id, 'hex');
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
	try {
		if (!data_field) {
			data_field = 'data';
		}
		if (full_url) {
			url = full_url;
		} else {
			url = `${SERVER_PATH}/enterprise_api/${url}`;
		}
		if (!url) {
			throw 'invalid url provided';
		}
		if(!method) {
			method = 'POST';
		}
		if (!is_form_data) {
			if (!headers) {
				headers = {
					'Content-Type': 'application/json',
                    'infurnia-access-token': ACCESS_TOKEN,
                    'infurnia-email': EMAIL,
                    'infurnia-store-id': STORE_ID
				};
			}
			if (body) {
				body = JSON.stringify(body);
			}
		}
		
        var options = { method, headers, body };
        var resp = await fetch(url, options);
        resp = await resp.json();
		
        if (resp.response_code == 1 || resp.response_code == 0) {
        	return resp[data_field];
        }else {
        	throw new Error('Server call failed with error -- ' + resp.error); 
        }
	} catch(err) {
		return Promise.reject({ err, resp, info: 'Error in general_fetch ' + url })
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
    try {
        if (!data_field) {
            data_field = 'data';
        }

        let config = {
            url: `${SERVER_PATH}/enterprise_api/${url}`,
            headers: {
                'infurnia-access-token': ACCESS_TOKEN,
                'infurnia-email': EMAIL,
                'infurnia-store-id': STORE_ID,
                ...data.getHeaders()
            },
            data,
            method: 'POST'
        }
        let resp = await axios(config);
        resp = resp.data;
        if (resp.response_code == 1 || resp.response_code == 0) {
        	return resp[data_field];
        }else {
        	throw new Error('Server call failed with error -- ' + resp.error); 
        }
    } catch(err) {
        console.error('Error in upload_file ->', err);
        return Promise.reject({ err, info: 'Error in upload_file ' + url })
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
        let sales_channels = await general_fetch({ url: 'sales_channel/get' });
        console.log('successfully fetched sales_channels.');
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
*/
const create_sku_category = async ({ name, sku_category_type_id, sku_division_id }) => {
    try {
        let sku_category_data = {
            name,
            sku_category_type_id,
            sku_division_id
        };
        let sku_category = await general_fetch({ url: 'sku_category/add', body: sku_category_data });
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
*/
const create_sku_sub_category = async ({ name, sku_category_id, order }) => {
    try {
        let sku_sub_category_data = {
            name,
            sku_category_id,
            order
        };
        let sku_sub_category = await general_fetch({ url: 'sku_sub_category/add', body: sku_sub_category_data });
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
*/
const create_sku_group = async ({ name, sku_sub_category_id, order }) => {
    try {
        let sku_group_data = {
            name,
            sku_sub_category_id,
            order
        };
        let sku_group = await general_fetch({ url: 'sku_group/add', body: sku_group_data });
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
    path: path of the model 3d file
*/
const create_model_3d = async ({ path }) => {
    try {
        let form = new FormData();
        form.append('format', 'glb');
        form.append('high', 'false');
        form.append('file', fs.createReadStream(path));
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
*/
const bulk_create_skus = async ({ sku_data, sku_category_id }) => {
    try {
        let bulk_create_attempt = await general_fetch({ url: 'sku_bulk_operation/create_attempt', body: { sku_category_id, type: 'upload'} });
        let created_skus = await general_fetch({ url: 'sku_bulk_operation/trigger_attempt', body: { bulk_operation_attempt_id: bulk_create_attempt.id, data: sku_data } });
        console.log('successfully created skus with IDs -> ', created_skus.map(sku => sku.id));
        return created_skus;
    } catch(err) {
        console.error('Error in bulk_create_skus ->', err);
        return Promise.reject({ err, info: 'Error in bulk_create_skus' })
    }
}


/*
    FETCH ALL SUB CATEGORIES
    this function is used to fetch sub category tree for a given store (both owned/non-owned)
*/
const get_all_sub_categories = async () => {
    try {
        const data = await general_fetch({ url: 'inventory/get_all_sub_categories' });
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
    @param

*/
const get_groups = async (sku_sub_category_id) => {
    try {
        const data = await general_fetch({ url: 'inventory/get_groups', body: { sku_sub_category_id } });
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
    id: a single sku id (string) or multiple sku ids (array of strings)
*/
const remove_skus = async (id) => {
    try {
        await general_fetch({ url: 'sku/remove_from_store', body: { identifiers: JSON.stringify({id}) } });
        console.log('successfully removed skus with IDs -> ', id);
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
    id: a single sku group id (string) or multiple sku group ids (array of strings)
*/
const remove_sku_group = async (id) => {
    try {
        await general_fetch({ url: 'sku_group/remove_from_store', body: { identifiers: JSON.stringify({id}) } });
        console.log('successfully removed sku group with ID -> ', id);
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
        await general_fetch({ url: 'sku_sub_category/deprecate', body: { id } });
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
        await general_fetch({ url: 'sku_category/deprecate', body: { id } });
        console.log('successfully removed sku category with ID -> ', id);
        return "OK";
    } catch(err) {
        console.error('Error in remove_sku_category ->', err);
        return Promise.reject({ err, info: 'Error in remove_sku_category' })
    }
}


module.exports = {
    generate_id,
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
    get_all_sub_categories,
    get_groups,
    remove_skus,
    remove_sku_group,
    remove_sku_sub_category,
    remove_sku_category,
    STORE_ID
}