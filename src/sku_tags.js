const {
    create_tag,
    get_tags_on_sku,
    attach_tags_on_sku
} = require('../utils');

const SAMPLE_SKU_ID = 'd2efeab2bd2a65ef';

const _main = async () => {
    try {
        /*
            Create a new Tag using the tag/add API
            Just provide a name to it and a new tag with a unique idenitifer is sent in the response
        */
        let tag_1_name = 'tag 1'
        let tag_1_id = await create_tag(tag_1_name);
        console.log('A new tag with id ' + tag_1_id + ' is created');
        
        let tag_2_name = 'tag 2'
        let tag_2_id = await create_tag(tag_2_name);
        console.log('A new tag with id ' + tag_2_id + ' is created');
        
        /*
            Attach the tags to the given SKU with sku/attach_tags API
            You can attach multiple tags at once using this API
        */
        await attach_tags_on_sku(SAMPLE_SKU_ID, [tag_1_id, tag_2_id]);

        /*
            You can get the attached tags to a SKU using the sku/get_tags API
        */
        const tags = await get_tags_on_sku(SAMPLE_SKU_ID);
        console.log('Found the following tags:', tags);

        return 1;
    } catch (err) {
        console.error(err);
    }
}

_main()
.then(console.log)
.catch(console.error)
.finally(process.exit);
