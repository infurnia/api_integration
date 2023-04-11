const {
    init_pricing_quotation_json,
    get_pricing_quotation_json_status,
    sleep,
    SERVER_PATH
} = require('./utils');

const DESIGN_BRANCH_ID = "d57e969750c4078"; // Example design branch
 
const _main = async () => {
    try {
        /**
         * API call to inititate request for printing presentation in JSON format
         * Request body must be a JSON 
         * It must have `commands` as an array with one string element called "GetPricingQuotationDetailsJSON"
         *      i.e. "commands": ["GetPricingQuotationDetailsJSON"]
         * 
         * It must have `design_branch_id` as a valid design branch id (string)
         *      for example, "design_branch_id": "d57e969750c4078"
         * 
         * 
         * Other supported commands are the following:
         *  GetPricingQuotationDetailsJSON  -> Get pricing quotation in JSON
         *  GetPricingQuotationXlsx         -> Get pricing quotation in XLSX
         *  GetPricingQuotationCsv          -> Get pricing quotation in CSV
         *  GetCabinetCompositeBoq          -> Get Cabinet Composite BOQ
         * 
         * You can send a subset of these commands as an array in the `commands` argument in the below API
         */
        const req_body = {
            "commands": ["GetPricingQuotationDetailsJSON"],
            "design_branch_id": DESIGN_BRANCH_ID,
        }
        const resp = await init_pricing_quotation_json(req_body);
        const request_id = resp.request_batch_id;
        
        let output_file_path;
        while(true) {
            /**
             * API call to check the status of request (polling)
             * Request body must be contain the request id
             * Response body will have attributes: `status` and `output_file_path`
             * On status === 'completed', `output_file_path` will be the path of pricing quotation file in JSON format
             * For other status values, `output_file_path` will be NULL
             */
            const resp = await get_pricing_quotation_json_status(request_id);
            if (resp.status === 'completed') {
                output_file_path = resp.output_file_path;
                break;
            }
            if (resp.status === 'failed') {
                console.error('Failed to create pricing quotation for design branch id:', DESIGN_BRANCH_ID, 'with request id:', request_id);
                break;
            }
            await sleep(2000);
        }
        if (output_file_path) {
            output_file_path = SERVER_PATH + '/' + output_file_path;
            console.log('Successfully generated pricing quotation in JSON format here:', output_file_path);
        }
        return 1;
    } catch (error) {
        console.error(error);
    }
}

_main()
.then(() => {
    console.log("SUCCESS");
    process.exit(0);
})
.catch((error) => {
    console.error(error);
    process.exit(1);
});
