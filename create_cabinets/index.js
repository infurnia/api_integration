/*
    Input: json object
    Output: component file of the cabinet

    Fields supported for Cabinet:

    width : double
    depth: double
    height: double
    carcass_core_panel_sku_id: string
    carcass_top_finish_material_id: string
    carcass_edge_band_material_id: string
    carcass_bottom_finish_material_id: string
    skirting_core_panel_sku_id: string
    skirting_top_finish_material_id: string
    skirting_edge_band_material_id: string
    skirting_bottom_finish_material_id: string
    shutter_core_panel_sku_id: string
    shutter_top_finish_material_id: string
    shutter_edge_band_material_id: string
    shutter_bottom_finish_material_id: string
    shutter_design_material_id: string
    drawer_fascia_core_panel_sku_id: string
    drawer_fascia_top_finish_material_id: string
    drawer_fascia_edge_band_material_id: string
    drawer_fascia_bottom_finish_material_id: string
    drawer_fascia_design_material_id: string

    For Partition:
        We take an array of partitions (key of array: “partitions”) where each partitions supports the following fields. The order of partitions (according to their id is from top to bottom, and left to right for sub-partitions within the same partition). 
        For example, partition with partition_id: “partition_1” is the outermost partition. “partition_1_1” denotes the lower/left most sub-partition of the outermost partition.

    partition_id: string (mandatory)
    shutter_system_type: string
    no_of_shelves: int
    no_of_vertical_partitions: int
    no_of_drawers: int
    drawer_system_construction_type: string
    drawer_system_offset_from_top: double
    internal_drawer_system: boolean

    For Drawers:
        For a given partition, one can either attach a shelf or drawers, but not both. 
        The size of the drawer array should be the lesser than/equal to the field “no_of_drawers” for that particular partition.
        For every partition, we accept an array of drawers (key of array: “drawers”) where each drawer supports the following fields. 

    drawer_id: int (mandatory)
    tandem_box_sku_id: string
    channel_sku_id: string
    

    Example Json 1:
    {
        "width": 500,
        "depth": 1000,
        "height": 1000,
        "sku_id": "dummy_sku_id",
        "carcass_top_finish_material_id": "1479702803899",
        "carcass_bottom_finish_material_id": "1479702803899",
        "carcass_core_panel_sku_id": "5c29af56da025254",
        "skirting_core_panel_sku_id": "5c29af56da025254",
        "partitions": [
            {
                "partition_id": "partition_1",
                "no_of_shelves": 1
            },
            {
                "partition_id": "partition_1_1",
                "no_of_drawers": 2
            }
        ]
    }
    In this example, even though we have 2 drawers in sub-partition 1 of the outermost partition, since we don’t need tandem box/drawer channel, we have not specified a separate array for drawers. Similarly, even though we have an existing partition “partition_1_2”, since we don’t need custom properties, we do not mention it in the array.

    Example Json 2:
    {
        "width": 100,
        "depth": 500,
        "height": 1000,
        "sku_id": "dummy_sku_id2",
        "carcass_top_finish_material_id": "1479702803899",
        "carcass_bottom_finish_material_id": "1479702803899",
        "carcass_core_panel_sku_id": "5c29af56da025254",
        "drawer_fascia_top_finish_material_id": "1479702803899",
        "partitions": [
            {
                "partition_id": "partition_1",
                "no_of_shelves": 1
            },
            {
                "partition_id": "partition_1_2",
                "no_of_shelves": 2
            },
            {
                "partition_id": "partition_1_1",
                "no_of_drawers": 2,
                "drawer_system_construction_type": "drawer_box"
            },
            {
                "partition_id": "partition_1_2_1",
                "no_of_vertical_partitions": 3
            },
            {
                "partition_id": "partition_1_2_2",
                "no_of_drawers": 2,
                "internal_drawer_system": true,
                "drawers": [
                    {
                        "drawer_id": 1,
                        "tandem_box_sku_id": "9cac39d10ea9be14"
                    },
                    {
                        "drawer_id": 2,
                        "channel_sku_id": "f2iJKqOVjyPSErcXWQB3"
                    }
                ]
            }
        ]
    }
*/

const {
    create_cabinets,
    get_create_cabinet_status
} = require('../utils');


const SKU_GROUP_ID_1 = 'valid_sku_group_id';
const SKU_GROUP_ID_2 = 'valid_sku_group_id';
const DISPLAY_PIC_ID_1 = 'valid_display_pic_id';
const DISPLAY_PIC_ID_2 = 'valid_display_pic_id';

const component_info_1 = require('./example1.json');
const component_info_2 = require('./example2.json');

const create_cabinet_skus = async () => {
    try {
        const sku_1_data = {
            name: 'dummy_sku_1',
            sku_group_id: SKU_GROUP_ID_1,
            display_pic_id: DISPLAY_PIC_ID_1,
            height: 10,
            component_info: component_info_1
        };
        const sku_2_data = {
            name: 'dummy_sku_2',
            sku_group_id: SKU_GROUP_ID_2,
            display_pic_id: DISPLAY_PIC_ID_2,
            height: 10,
            component_info: component_info_2
        };
        const sku_data = [sku_1_data, sku_2_data];

        /**
         * API call to request for creating cabinet skus
         * Request body must be an array of sku data to be created
         * Each sku data json should have `cabinet_info` property which contains the component file info
         * Each sku data json should have `sku_group_id` property
         */
        const create_cabinet_resp = await create_cabinets(sku_data);
        const request_id = create_cabinet_resp.request_batch_id;
        let sku_ids = [];

        while(true) {
            /**
             * API call to check the status of request
             * Request body must be contain the request id
             * Response body will have two attributes: `status` and `sku_ids`
             * On status === 'completed', sku_ids will be an array of creaetd sku ids
             */
            const status_resp = await get_create_cabinet_status(request_id);
            if (status_resp.status === 'completed') {
                sku_ids = status_resp.sku_ids;
                break;
            }
            if (status_resp.status === 'failed') {
                console.error('Failed to create SKUs for request id', request_id);
                break;
            }
        }

        console.log('SKU IDs generated =>', sku_ids);

        return 1;
    } catch (error) {
        console.error(error);
    }
}

create_cabinet_skus()
.then(() => {
    console.log("SUCCESS");
    process.exit(0);
})
.catch((error) => {
    console.error(error);
    process.exit(1);
});
