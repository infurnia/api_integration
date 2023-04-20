# Infurnia API integration Example - Bulk Creation of Inventory

### Assumptions
1. You must have access token, org ID (store_id), email and server path (paste them in utils.js).
2. Sales Channels and Price Types must be created (if not, default sales channel and price types can be used).

### Caveats and potential pitfalls
* Example code uses Laminate as material template, other material templates may be used (for example Granite, Wood, etc. which are returned in the fetch_material_templates response).
* Example code uses miscellaneous_finish  as category type, other category types may be used (for example cabinet, wardrobe, panel_core, cabinet_finish, etc. which are returned in the fetch_catgeory_types response).
* Thickenss for finish skus and core_materials can be specified in the sku.height field.
* Additional properties - user may create any number of custom key value pairs.

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
Please check the [pricing quotation code](get_pricing_quotation_json.js) to know more about supported commands and file formats to generate pricing quotation.

### SKU Update
Use the `update_sku` function in the utils folder to update any SKU's details. Only mention the fields supposed to be updated in the body of the API.  Please stringify the `additional_roperties` field if it exists before calling the API.
