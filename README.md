# Infurnia API integration Example - Bulk Creation of Inventory

### Assumptions
1. You must have access token, org ID (store_id), email and server path (paste them in utils.js).
2. Sales Channels and Price Types must be created (if not, default sales channel and price types can be used).

### Caveats and potential pitfalls
* Example code uses Laminate as material template, other material templates may be used (for example Granite, Wood, etc. which are returned in the fetch_material_templates response).
* Example code uses miscellaneous_finish  as category type, other category types may be used (for example cabinet, wardrobe, panel_core, cabinet_finish, etc. which are returned in the fetch_catgeory_types response).
* Thickenss for finish skus and core_materials can be specified in the sku.height field.
* Additional properties - user may create any number of custom key value pairs.
* You can create Model 3D for a SKU using two ways - either using a GLB file or using OBJ and MTL files. Check the example code for more information on how to pass the appropriate arguments

### Pricing
display_unit field for price_types must be in agreement with pricing_dimension field of sku_category_type for the SKU. Acceptable values of display_unit can be determined as follows:
```
  {
      'per_unit_length': [ 'millimetre', 'metre', 'foot' ],
      'per_unit_area': [ 'sq_millimetre', 'sq_metre', 'sq_foot' ],
      'per_unit_volume': [ 'cu_millimetre', 'cu_metre', 'cu_foot' ],
      'per_unit': [ 'per_unit' ],
  }
```
If category_type has the pricing_dimension 'per_unit_length', display_unit for price_types can be 'millimetre', 'metre' or 'foot'.


### Generate Pricing Quoation
Please check the [pricing quotation code](src/pricing_quotation.js) to know more about supported commands and file formats to generate pricing quotation.

The following commands are supported in the production details API
1. `GetPricingQuotationDetailsJSON` - Get pricing quotation in JSON
2. `GetPricingQuotationXlsx` - Get pricing quotation in XLSX
3. `GetPricingQuotationPdf` - Get pricing quotation in PDF
4. `GetPricingQuotationCsv` - Get pricing quotation in CSV
5. `GetCabinetCompositeBoq` - Get cabinet composite BOQ
6. `GetStandardWoodenRmOutput` - Get standard wooden RM output
7. `GetStandardHardwareRmOutput` - Get standard hardware RM output
8. `GetCutlistCsv` - Get cutlist in CSV
9. `GetManufacturingCutlistCsv` - Get manufacturing cutlist in CSV
10. `GetCurrentBoardTypeCurrentBoard` - Get current board type current board
11. `GetCurrentBoardTypeAllBoards` - Get current board type all boards
12. `GetAllBoardTypeAllBoards` - Get all board type all boards
13. `GetBoardLayoutCount` - Get board layout count
14. `GetBoardLayoutFinishCount` - Get board layout finish count
15. `GetFloorplanFloorViews` - Get floor plan floor views
16. `GetFloorplanRoomViews` - Get floor plan room views
17. `GetFulfillmentTags` - Get fulfillment tags
18. `GetCNCMachineOutputCix` - Get CNC machine output CIX
19. `GetCNCMachineOutputMpr` - Get CNC machine output MPR
20. `GetCNCMachineOutputXcs` - Get CNC machine output XCS
21. `GetCNCMachineOutputPdf` - Get CNC machine output PDF
22. `GetAllPresentationSheetsPdf` - Get presentation PDF of a design branch
23. `PrintElevationViews` - Print elevation view in PDF


### SKU Update
Use the `update_sku` function in the utils folder to update any SKU's details. Only mention the fields supposed to be updated in the body of the API. Please stringify the `additional_properties` field if it exists before calling the API. Check the example code [here](src/inventory.js)


### Disable rendering for a design branch
Use the `disable_rendering` function in the utils folder to disable rendering for a given design branch. Alternatively, use the `enable_rendering` function in the utils folder to enable rendering for a given design branch. By default, a design branch has rendering enabled.


### Attach Tags
Pls check this [example code](src/sku_tags.js) for attaching tags to SKU.


### Fetch all renders for a given design branch
Pls check this [example code](src/render.js) for fetching all renders for a given design ID.


### Business Unit Migration Guide
A new API is supported to get the store info and corresponding default business unit id. This business unit id can be used in the other APIs. Or please ask the Infurnia admin to provide for the valid business unit id

##### Fetch store info
API named as `store/get_info`

The following APIs have been changed and their example codes have been updated accordingly. Please have a look at the API names, request bodies and response bodies.

##### Fetch sales channels
API name changed from `sales_channel/get` to `sales_channel/get_of_store`
Request body must have the following field `include_price_type_mapping: true`.
Response body now will have a field called `sales_channels` which has two more nested fields `owned` and `subscribed` representing the owned and subscribed sales channels respectively. You can combine both the arrays to get all the visible sales channels for your Org. For every sales channel, there will be a correpsonding field called `price_type_ids`.

##### Create SKU Category
API name changed from `sku_category/add` to `sku_category/create`.
It expects an extra parameter `business_unit_id`

##### Create SKU Sub Category
API name changed from `sku_sub_category/add` to `sku_sub_category/create`.
It expects an extra parameter `business_unit_id`

##### Create SKU Group
API name changed from `sku_group/add` to `sku_group/create`.
It expects an extra parameter `business_unit_id`

##### Bulk create SKU
It expects an extra parameter `business_unit_id`

##### Fetch all sub categories in the inventory
API `inventory/get_all_sub_categories` expects an extra parameter `business_unit_id` to fetch the sub categories in the the corresponding business unit. You can use the default business unit ID from `store/get_info` as mentioned above to fetch the sub categories in the default business unit.

##### Fetch all the groups in a sub category
API `inventory/get_groups` expects an extra parameter `business_unit_id` to fetch the sub groups in the the given sub category and business unit. You can use the default business unit ID from `store/get_info` as mentioned above to fetch the groups from the default business unit.

##### Remove SKU from the Business Unit 
API `sku/remove_from_business_unit` expects a different parameter in the request body: `sku_ids` should be the array of SKU IDs to be removed from the business unit and `business_unit_id` .

##### Remove SKU Group from the Business Unit 
API `sku_group/remove_from_business_unit` expects a different parameter in the request body: `sku_group_ids` should be the array of SKU Group IDs to be removed from the business unit and `business_unit_id`.

##### Update SKU Group 
API `sku_group/update` expects a different parameter in the request body: `sku_group_id` should be the id of the SKU Group which is to be updated, `business_unit_id`, `name` (optional field) provide the new name of the sku group, `sku_sub_category_id` (optional field) provide the new SKU Sub Category ID if the sku group need to be moved accross SKU Sub Categories (sku group can only be moved across SKU Sub Categories having the same SKU Category Type).

##### Remove SKU Sub Category from the store
API `sku_sub_category/deprecate` expects a different parameter in the request body: `sku_sub_category_id` should be the ID of the SKU Sub Category to be removed from the store.

##### Remove SKU Category from the store
API `sku_category/deprecate` expects a different parameter in the request body: `sku_category_id` should be the ID of the SKU Category to be removed from the store.

##### Update SKU details
API `sku/update` does not support `identifiers` and `updates` in the request body. Instead of `identifiers`, it expects `sku_id` to be the ID of the SKU to be updated. Instead of `updates`, it expects the corresponding fields like `name`, `order`, `model_no` (previously sent in the `updates` field) in the request body.

##### Disable design branch rendering
API `design/disable_branch_rendering` is changed to `design_branch/update_rendering_enabled_status` with an extra parameter `status: disable` along with the `design_branch_id` parameter in the request body.

##### Disable design branch rendering
API `design/disable_branch_rendering` is changed to `design_branch/update_rendering_enabled_status` with an extra parameter `status: enable` along with the `design_branch_id` parameter in the request body.

##### Fetch Tags
API `sku/get_tags` expects a different parameter `sku_ids` instead of `ids` in the request body.

##### Attach Tags to a SKU
API `sku/attach_tags` expects a different parameter `sku_ids` instead of `ids` in the request body.

#### Update sku price/sales channel information.
API `sales_channel/add_skus`  and `sales_channel/remove_skus` can be used to map and unmap skus to a sales channel respectively 
Both expect parameter `sku_ids` which is a list(Array) of skus that needs to be added or removed from the sales channel and `sales_channel_id` which the id of the sales channel in which the skus are to added.

To get sku_id the following ways can be used 
api `inventory/get_all_sub_categories` can be used to to get the sub category tree (both owned/subscribed) for a given store, sub category id can be inferred from its result by seraching on the name or individual sub category ids can directly picked selecting a particaular sub category , the last path segments/URL path component is the sku_sub_category id.
eg. in  `/catalogue/finish/984703946002946389/9927264560914371958/`  9927264560914371958 is the sub_category id.

Once a sub_category_id is selected,  sku group and underlying skus for a given sku category id can be obtained by the api `inventory/get_groups`.

API `price/update` is used to update the price of a sku, it accepts params sku_id, business_unit_id, price, tax, margin, display_unit, sales_channel_id, price_type_id 
If the price to be updated is the default price or the sku business_unit_id should be passed, and both sales_channel_id and price_type_id should be set as null.
If the price is to be set of sku for a particular sales channel and price type specify both sales_channel_id and price_type_id for which the price is to updated. 

To get sales channels and their mapped price_types API `sales_channel/get_of_store` can be used with parameter include_price_type_mapping set as true in the body,

#### Fetch SKU information
API `sku/get` is used to fetch information corresponding to a list of sku ids. 

- **Parameters**
  - `business_unit_id` (string): The ID of your business unit.
  - `identifiers` (stringified JSON): A JSON object with parameter `id` containing an array of SKU IDs you want to retrieve information for. This JSON object needs to be converted into strigified format. For example, to create stringified JSON for 2 SKUs having ids 1499253168870, 1488453826100.
    - Firstly generate a JSON in the format: `{"id":["1499253168870", "1488453826100"]}`
    - Then stringify it to obtain it in the following format: `"{\"id\":[\"1499253168870\", \"1488453826100\"]}"` 


- **Sample Request:**
```json
{
  "business_unit_id": "your_business_unit_id",
  "identifiers": "{\"id\":[\"1499253168870\", \"1488453826100\"]}"
}
```
## Caution

**Caution**: If you need to retrieve information for multiple SKUs, it's recommended to pass a list of SKU IDs in a single request rather than calling the API individually for each ID. This practice helps avoid potential issues like server request blocks and improves efficiency.

