-- A spreadsheet import that was saved while some rows still had a problem used to close ("done") and lock those rows.
-- Such an import stays open now, so the left-out rows can still be corrected and saved: reopen the ones that were closed that way.
UPDATE "ImportJob" AS job
SET "status" = 'ready', "finishedAt" = NULL
WHERE job."kind" = 'spreadsheet'
  AND job."status" = 'done'
  AND EXISTS (SELECT 1 FROM "ImportItem" AS item WHERE item."jobId" = job."id" AND item."status" IN ('invalid', 'error'));
