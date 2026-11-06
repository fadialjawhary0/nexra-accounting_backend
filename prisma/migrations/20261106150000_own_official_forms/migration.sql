-- The office uses its own PDF forms (Ahmad's notes, 06-11-2026): the six made-up example forms that shipped with the system are taken out, the link to the
-- authority's web page goes, and every edition gets the state of its AI set-up (linking the fields, or finding the boxes of a PDF without fields).

-- 1. What was filled in with an example edition: the log entries go; the filled example PDFs are switched off in the client folders (they stay in the database).
UPDATE "StoredFile" SET "isActive" = false, "deactivatedAt" = now()
WHERE "isActive" = true
  AND "id" IN (SELECT s."fileId" FROM "FormSubmission" AS s JOIN "OfficialFormVersion" AS v ON v."id" = s."versionId" WHERE v."isSample" = true);
DELETE FROM "FormSubmission" WHERE "versionId" IN (SELECT "id" FROM "OfficialFormVersion" WHERE "isSample" = true);

-- 2. The example editions and their blank PDFs.
CREATE TEMP TABLE sample_blank_files AS SELECT "fileId" AS id FROM "OfficialFormVersion" WHERE "isSample" = true;
DELETE FROM "OfficialFormVersion" WHERE "isSample" = true;
DELETE FROM "StoredFile" WHERE "id" IN (SELECT id FROM sample_blank_files) AND "purpose" = 'form_blank';
DROP TABLE sample_blank_files;

-- 3. A form left without any edition and never used was only an example: it goes. A form the office gave a PDF of its own stays.
DELETE FROM "OfficialForm" AS f
WHERE NOT EXISTS (SELECT 1 FROM "OfficialFormVersion" AS v WHERE v."formId" = f."id")
  AND NOT EXISTS (SELECT 1 FROM "FormSubmission" AS s WHERE s."formId" = f."id")
  AND f."code" IN ('melding_loonheffingen', 'verzoek_deblokkering_g_rekening', 'aanvraag_g_rekening', 'verklaring_betalingsgedrag', 'opgaaf_rekeningnummer', 'aanvraag_uitstel');

-- 4. The columns that went.
ALTER TABLE "OfficialFormVersion" DROP COLUMN "isSample";
ALTER TABLE "OfficialForm" DROP COLUMN "officialUrl";

-- 5. The AI set-up of an edition.
ALTER TABLE "OfficialFormVersion" ADD COLUMN "setup" JSONB NOT NULL DEFAULT '{}';
