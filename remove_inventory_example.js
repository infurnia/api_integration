const {
    get_store_info,
    get_all_sub_categories,
    get_groups,
    remove_skus,
    remove_sku_group,
    remove_sku_sub_category,
    remove_sku_category,
    STORE_ID
} = require('./utils');

const MY_STORE_ID = STORE_ID;

const remove_complete_inventory = async () => {
    try {
        // fetch the complete sub category map in the Default Business Unit
        // get the default Business Unit Id from the store/get_info API
        const store_info = await get_store_info();
        const default_business_unit_id = store_info.default_business_unit_id;

        // this includes all owned sub categories and and non owned sub categories in which at least one sku is added to the default Business Unit Id
        const hierarchy = await get_all_sub_categories(default_business_unit_id);
        
        // this includes all owned sub categories and and non owned sub categories in which at least one sku is added to your store
        // const hierarchy = await get_all_sub_categories();


        /*
            hierarchy looks like =>
            heirarchy: [
                {
                    id: <sku_division_id>,
                    sku_category: [
                        {
                            id: <sku_category_id>,
                            name: <sku_category_name>,
                            store_id: <sku_category_store_id>,
                            sku_sub_category: [
                                {
                                    id: <sku_sub_category_id>,
                                    name: <sku_sub_category_name>,
                                    store_id: <sku_sub_category_store_id>,
                                },
                                ...
                            ]
                        }, 
                        ...
                    ]
                },
                ...
            ]

            At every level, you can distinguish if the inventory item is owned by your store or by another by comparing the 'store_id' attribute
        */
        
        // Now you can parse through individual sub categories and find corresponding groups and skus in it
        for (sku_division of hierarchy) {
            for (category of sku_division.sku_category) {
                for (sub_category of category.sku_sub_category) {
                    try {
                        const sku_sub_category_id = sub_category.id;
                        const sku_group_hierarchy = await get_groups(sku_sub_category_id, default_business_unit_id);

                        /*
                            sku_group_hierarchy looks like this:
                            sku_group_hierarchy: [
                                {
                                    id: <sku_group_id>,
                                    name: <sku_group_name>,
                                    store_id: <sku_group_store_id>,
                                    sku: [
                                        {
                                            id: <sku_category_id>,
                                            name: <sku_category_name>,
                                            store_id: <sku_category_store_id>,
                                            diplay_pic_id,
                                        }, 
                                        ...
                                    ]
                                },
                                ...
                            ]
                            At every level, you can distinguish if the inventory item is owned by your store or by another by comparing the 'store_id' attribute
                        */

                        // Collecting all owned sku group ids
                        const all_owned_sku_group_ids = sku_group_hierarchy.filter(obj => obj.store_id == MY_STORE_ID).map(obj => obj.id);

                        // removing all owned sku groups
                        remove_sku_group(all_owned_sku_group_ids);

                        // To remove non-owned sku groups, you must remove all the skus mapped within the groups. 
                        // This will automatically unmap the (non-owned) sku groups too
                        // Once all the sku groups gets unmapped, the corresponding (non-owned) sku sub category will also get unmapped
                        // Similarly once all the sku sub categories gets unmapped, the corresponding (non-owned) sku category will also get unmapped

                        // Collecting all the SKU IDs of non-owned sku groups
                        const to_remove_sku_ids = [];
                        sku_group_hierarchy.filter(obj => obj.store_id != MY_STORE_ID).forEach(sku_group => {
                            sku_group.sku.forEach(sku => {
                                to_remove_sku_ids.push(sku.id);
                            })
                        })

                        // remove all the sku ids
                        await remove_skus(to_remove_sku_ids);
                        
                        if (sub_category.store_id == MY_STORE_ID) {
                            // Owned sku sub categories do not get removed automatically
                            // To remove them, do the following
                            await remove_sku_sub_category(sub_category.id);
                        }
                    } catch (err) {
                        console.error('Failed to fetch groups for sub category', sub_category.id);
                        console.error(err);
                    }
                }
            }
        }

        // Owned sku caetgories do not get removed automatically even after removing all the underlying sku sub categories, sku groups and skus
        // To remove them, do the following => 

        for (const sku_division of hierarchy) {
            for (const sku_category of sku_division.sku_category) {
                try {
                    console.log(sku_category.name, sku_category.store_id);
                    if (sku_category.store_id == MY_STORE_ID) {
                        await remove_sku_category(sku_category.id);
                    }
                } 
                catch (err) {
                    console.error('Error in removing category', sku_category.id);
                    console.error(err);
                }
            }
        }
    }
    catch (error) {
        console.error(error);
    }
}


remove_complete_inventory()
.then(() => {
    console.log("SUCCESS");
    process.exit(0);
})
.catch((error) => {
    console.error(error);
    process.exit(1);
});