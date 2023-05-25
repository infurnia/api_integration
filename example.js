/*
    Example for brand creation
    This script creates a brand with the following details:
    1. Brand Name: "Brand 1"

    let new_brand = await add_brand('Brand 1');
    console.log(new_brand);


    Example for fetching brands
    This script fetches all brands
    let all_brands = await get_brands();
    console.log(all_brands);


    Example for sku updation
    This script updates the following details of a sku:
    1. Name: "SKU 1"
    3. Model No: "model_no1"
    4. Brand: "brand_1"

    let sku_id = "sku_id";
    let updated_sku = await update_sku(sku_id, {
        name: "SKU 1",
        model_no: "model_no1",
        brand_id: "brand_1"
    });
    console.log(updated_sku);
    
    To update Material for an SKU:

    1. Create texture
    let texture = await create_texture({ 
        path: texture.file, //path to texture file
        name: "sample texture" 
    });
    
    2. create material
    let material = await create_material({
        name: "sample material name",
        material_template_id: material_template_id, //relevant material_template_id - use fetch_material_templates() to get all material templates
        properties: material_templates_map[material_template_id].properties, // properties of material template as returned by fetch_material_templates()
        texture_id: texture ? texture?.id??null : null
    });
    
    let sku_data = {}
    sku_data.material_id = material.id;
    let sku_id = "sku_id";
    let updated_sku = await update_sku(sku_id, sku_data);
    console.log(updated_sku);
*/


const {
    generate_id,
    get_store_info,
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
    update_sku,
    add_brand,
    get_brands,
    BUSINESS_UNIT_ID
} = require('./utils');

const create_inventory = async () => {
    try {
        //fetch SKU Category Types
        let sku_category_types = await fetch_sku_category_types();

        // Fetching store details and default business unit Id
        let store_info = await get_store_info();
        console.log(store_info)
        console.log(store_info.default_business_unit_id);
        let business_unit_id = BUSINESS_UNIT_ID ? BUSINESS_UNIT_ID : store_info.default_business_unit_id;

        //fetch Sales Channels
        let sales_channels = await fetch_sales_channels();
        sales_channels = sales_channels.sales_channels.owned;
        let sales_channel_details = sales_channels.filter(obj => obj.price_type_ids.length > 0)[0];
        console.log('All sales channels:', sales_channels);
        console.log('Owned sales channels 0:', sales_channels[0]);
        console.log('sales_channel_details', sales_channel_details);

        //fetch material templates
        let material_templates = await fetch_material_templates();
        
        let material_templates_map = material_templates.reduce((final, elem) => ({
            ...final,
            [ elem.id ]: elem            
        }), {});

        let sample_inventory = [{
            name: "Test Category 11",
            sku_category_type_id: 'miscellanous_finish', //must be one of the sku_category_types array
            sku_division_id: 'finish', //must be same as sku_division_id of sku_category_type
            sku_sub_categories: [{
                name: "Test Sub Category 1",
                order: 1, //can be any decimal number (used to set display order of sub categories)
                sku_groups: [{
                    name: "Test Group 1",
                    order: 2, //can be any decimal number (used to set display order of groups)
                    skus: [{
                        name: "Test 1",
                        height: 100,
                        model_no: "model_no1",
                        material: {
                            texture: {
                                file: "./dummy_image.jpg",
                                name: "demo_texture"
                            },
                            material_template_id: material_templates.find(elem => elem.name == 'Laminate').id,
                            name: "demo_material",
                        },
                        sales_channels: [{
                            id: sales_channel_details.id,
                            price_types: [{
                                id: sales_channel_details.price_type_ids[0],
                                price: 1000,
                                margin: 10,
                                tax: 10,
                                display_unit: "sq_foot", //must be in agreement with pricing_dimension of sku_category_type
                            }]
                        }],
                        additional_properties: [{ 
                            key: "key1",
                            value: "value1"
                        }, {
                            key: "key2",
                            value: "value2"
                        }]
                    }]
                }]
            }]
        }, {
            name: "SKU Category 2",
            sku_category_type_id: 'tap_hardware', //sku_category_types[x].id,
            sku_division_id: 'hardware', //sku_category_types[x].sku_division_id,
            sku_sub_categories: [{
                name: "SKU Sub Category 2",
                order: 2,
                sku_groups: [{
                    name: "SKU Group 2",
                    order: 1,
                    skus: [{
                        name: "SKU 2",
                        model_no: "model_no2",
                        placement_id: "base",
                        display_pic: {
                            file: "./dummy_image.jpg",
                        },
                        model_3d: {
                            file: "./dummy_model.glb",
                        },
                        sales_channels: [{
                            id: sales_channel_details.id,
                            price_types: [{
                                id: sales_channel_details.price_type_ids[0],
                                price: 1000,
                                margin: 10,
                                tax: 10,
                                display_unit: "sq_foot",
                            }]
                        }],
                        additional_properties: [{
                            key: "key3",
                            value: "value3"
                        }, {
                            key: "key4",
                            value: "value4"
                        }]
                    }]
                }]
            }]
        }];

        //script to create sample inventory
        for (let i = 0; i < sample_inventory.length; i++) {
            //create sku category
            let sample_category = sample_inventory[i];
            let sku_category = await create_sku_category({
                name: sample_category.name,
                sku_category_type_id: sample_category.sku_category_type_id,
                sku_division_id: sample_category.sku_division_id,
                business_unit_id: business_unit_id
            });
            //create sku sub categories
            let sample_sub_categories = sample_category.sku_sub_categories;
            for (let j = 0; j < sample_sub_categories.length; j++) {
                let sample_sub_category = sample_sub_categories[j];
                let sku_sub_category = await create_sku_sub_category({
                    name: sample_sub_category.name,
                    sku_category_id: sku_category.id,
                    order: sample_sub_category.order,
                    business_unit_id: business_unit_id
                });

                //create sku groups
                let sample_groups = sample_sub_category.sku_groups;
                for (let k = 0; k < sample_groups.length; k++) {
                    let sample_group = sample_groups[k];
                    let sku_group = await create_sku_group({
                        name: sample_group.name,
                        sku_sub_category_id: sku_sub_category.id,
                        order: sample_group.order,
                        business_unit_id: business_unit_id
                    });
                    //create skus
                    let sample_skus = sample_group.skus;
                    let all_sku_data = [];
                    for (let l = 0; l < sample_skus.length; l++) {
                        let sample_sku = sample_skus[l];
                        let sku_data = {
                            id: generate_id(),
                            name: sample_sku.name,
                            height: sample_sku?.height??null,
                            model_no: sample_sku.model_no,
                            sku_group_id: sku_group.id,
                            additional_properties: JSON.stringify(sample_sku.additional_properties),
                            placement_id: sample_sku.placement_id,
                            sales_channels: sample_sku.sales_channels,
                            business_unit_id: business_unit_id
                        };
                        if (sample_sku.material) {
                            let texture = null;
                            if (sample_sku.material.texture) {
                                //create texture
                                texture = await create_texture({ 
                                    path: sample_sku.material.texture.file, 
                                    name: sample_sku.material.texture.name 
                                })
                            }
                            //create material
                            let material = await create_material({
                                name: sample_sku.material.name,
                                material_template_id: sample_sku.material.material_template_id,
                                properties: material_templates_map[sample_sku.material.material_template_id].properties,
                                texture_id: texture ? texture?.id??null : null
                            });

                            sku_data.material_id = material.id;
                        }
                        if (sample_sku.display_pic) {
                            //create display pic
                            let display_pic = await create_display_pic({ path: sample_sku.display_pic.file });
                            sku_data.display_pic_id = display_pic.id;
                        }

                        if (sample_sku.model_3d) {
                            //create model 3d
                            // Two ways to create model 3d ->
                            // 1. Using GLB file (give .glb file path in `path` field) (below example)
                            // 2. Using OBJ and MTL files (give .obj file path in `path` field and .mtl file path in `mtl_path` field)
                            let model_3d = await create_model_3d({ path: sample_sku.model_3d.file });
                            sku_data.low_model_3d_id = model_3d.id;
                        }
                        all_sku_data.push(sku_data);
                    }
                    let created_skus = await bulk_create_skus({ 
                        sku_category_id: sku_category.id, 
                        sku_data: all_sku_data,
                        business_unit_id
                    });
                    console.log(`created_skus`, created_skus);
                    
                    // Update a SKU metadata, For example it's `name`, `order`, `model_no`
                    let sku_data_0 = created_skus[0];
                    sku_data_0.name = "updated_sku_name";
                    sku_data_0.order = 20;
                    sku_data_0.model_no = "Model 32";
                    sku_data_0.additional_properties = JSON.stringify(sku_data_0.additional_properties); // note: always stringify additional properties if it exists
                    let updated_sku = await update_sku(created_skus[0].id, sku_data_0);
                    console.log(`updated_sku_id`, updated_sku);
                }
            }
        }
        return 1;
    } catch (error) {
        console.error(error);
    }
}

create_inventory()
.then(() => {
    console.log("SUCCESS");
    process.exit(0);
})
.catch((error) => {
    console.error(error);
    process.exit(1);
});
