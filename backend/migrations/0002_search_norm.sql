-- Migration 0002: Add normalized columns for Unicode/Cyrillic case-insensitive search

ALTER TABLE publications ADD COLUMN title_norm TEXT NOT NULL DEFAULT '';
ALTER TABLE publications ADD COLUMN markdown_norm TEXT NOT NULL DEFAULT '';

UPDATE publications SET title_norm = lower(title), markdown_norm = lower(markdown);

CREATE INDEX IF NOT EXISTS idx_publications_title_norm ON publications (title_norm);

-- Triggers to auto-populate normalized fields if direct SQL inserts occur (e.g. in legacy tests)
CREATE TRIGGER IF NOT EXISTS trg_publications_search_norm_insert
AFTER INSERT ON publications
WHEN new.title_norm = '' AND new.markdown_norm = '' AND (new.title != '' OR new.markdown != '')
BEGIN
    UPDATE publications
    SET title_norm = lower(new.title), markdown_norm = lower(new.markdown)
    WHERE page_id = new.page_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_publications_search_norm_update
AFTER UPDATE OF title, markdown ON publications
WHEN (new.title != old.title OR new.markdown != old.markdown)
  AND new.title_norm = old.title_norm AND new.markdown_norm = old.markdown_norm
BEGIN
    UPDATE publications
    SET title_norm = lower(new.title), markdown_norm = lower(new.markdown)
    WHERE page_id = new.page_id;
END;
