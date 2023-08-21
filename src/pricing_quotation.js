const {
    init_core_request,
    get_status_for_core_request,
    sleep,
    SERVER_PATH
} = require('../utils');

const DESIGN_BRANCH_ID = "c3753074dcfb798d"; // Example design branch
 
const _main = async () => {
    try {
        /**
         * API call to inititate request for printing presentation in JSON format
         * Request body must be a JSON 
         * It must have `commands` as an array of strings indicating the command need to be requested
         *      e.g. "commands": ["GetPricingQuotationDetailsJSON"]
         * 
         * It must have `design_branch_id` as a valid design branch id (string)
         *      for example, "design_branch_id": "d57e969750c4078"
         * 
         * 
         * All supported commands are the following:
         * 'GetPricingQuotationDetailsJSON' - Get pricing quotation in JSON
         * 'GetPricingQuotationXlsx' - Get pricing quotation in XLSX
         * 'GetPricingQuotationPdf' - Get pricing quotation in PDF
         * 'GetPricingQuotationCsv' - Get pricing quotation in CSV
         * 'GetCabinetCompositeBoq' - Get cabinet composite BOQ
         * 'GetStandardWoodenRmOutput' - Get standard wooden RM output
         * 'GetStandardHardwareRmOutput' - Get standard hardware RM output
         * 'GetCutlistCsv' - Get cutlist in CSV
         * 'GetManufacturingCutlistCsv' - Get manufacturing cutlist in CSV
         * 'GetCurrentBoardTypeCurrentBoard' - Get current board type current board
         * 'GetCurrentBoardTypeAllBoards' - Get current board type all boards
         * 'GetAllBoardTypeAllBoards' - Get all board type all boards
         * 'GetBoardLayoutCount' - Get board layout count
         * 'GetBoardLayoutFinishCount' - Get board layout finish count
         * 'GetFloorplanFloorViews' - Get floor plan floor views
         * 'GetFloorplanRoomViews' - Get floor plan room views
         * 'GetFulfillmentTags' - Get fulfillment tags
         * 'GetCNCMachineOutputCix' - Get CNC machine output CIX
         * 'GetCNCMachineOutputMpr' - Get CNC machine output MPR
         * 'GetCNCMachineOutputXcs' - Get CNC machine output XCS
         * 'GetCNCMachineOutputPdf' - Get CNC machine output PDF
         * 'GetAllPresentationSheetsPdf' - Get presentation PDF of a design branch 
         * 
         * You can send a subset of these commands as an array in the `commands` argument in the below API. 
         */
        const req_body = {
            "commands": ["GetPricingQuotationDetailsJSON"],
            "design_branch_id": DESIGN_BRANCH_ID,
        }
        const resp = await init_core_request(req_body);
        const request_id = resp.request_batch_id;
        
        let output_file_path;
        while(true) {
            /**
             * API call to check the status of request (polling)
             * Request body must be contain the request id
             * Response body will have attributes: `status` and `output_file_path`
             * On status === 'completed', `output_file_path` will be the path of pricing quotation file in JSON format if that command is requested 
             * For other status values, `output_file_path` will be NULL
             * When more than one command is requested, a zipped file will be generated
             */
            const resp = await get_status_for_core_request(request_id);
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
