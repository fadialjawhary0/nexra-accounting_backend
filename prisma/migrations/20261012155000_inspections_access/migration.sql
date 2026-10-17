-- The permission area "tax_inspections" is now called "inspections" (the inspection screens replace the tax-audit prototype): carry what roles and people already hold over.
UPDATE "Role"
SET "permissions" = ("permissions" - 'tax_inspections') || jsonb_build_object('inspections', "permissions" -> 'tax_inspections')
WHERE jsonb_exists("permissions", 'tax_inspections');

UPDATE "User"
SET "permissionOverrides" = ("permissionOverrides" - 'tax_inspections') || jsonb_build_object('inspections', "permissionOverrides" -> 'tax_inspections')
WHERE jsonb_exists("permissionOverrides", 'tax_inspections');
