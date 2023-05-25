const { get_renders_for_design } = require('../utils');

const SAMPLE_DESIGN_ID = 'ff00b30d59ad5a9c';

const _main = async () => {
    try {
        /*
            Fetch all the renders for given design ID
        */
        let data = await get_renders_for_design(SAMPLE_DESIGN_ID);

        /*
            data will look like an array of JSON objects each object containing metadata of a unique render
            The metadata will include the folllowing useful attributes -
            1. id - Unique identifier for the render (render_id)
            2. status - either of the following - [completed, initialized, failed, ongoing, retrying]
                All successful renders have status as 'completed'
            3. job_type - either 'render' or 'bake'
                'bake' job type represents baking rendering request
            4. quality - either of the following - [HD, Full_HD, 4K]
            5. design_branch_id 
            6.  - publicly viewable file path for rendered design. Append this path https://staticassets.infurnia.com/ to vie it publicly
                e.g. an output_file_path with value 'rendering/outputs/172176233816420146141.jpg' indicates the output file path as 'https://staticassets.infurnia.com/rendering/outputs/172176233816420146141.jpg'
                Output file path is non null only for completed renders
            7. params - all the parameters of renderoutput_file_path
                - bounces
                - comment
                - quality
                - samples
                - designer_id
                - aspect_ratio
                - field_of_view
                - camera_target_x
                - camera_target_y
                - camera_target_z
                - camera_position_x
                - camera_position_y
                - camera_position_z
                - environment_map_name
                - environment_map_intensity
        */

        console.log('Render[0]:', data?.[0]);

        let successful_renders = data.filter(obj => obj.status == 'completed');

        console.log('File paths for successful renders:', successful_renders.map(obj => {
            return 'https://staticassets.infurnia.com/' + obj.output_file_path
        }));

        return 1;
    } catch (err) {
        console.error(err);
    }
}

_main()
.then(console.log)
.catch(console.error)
.finally(process.exit);
