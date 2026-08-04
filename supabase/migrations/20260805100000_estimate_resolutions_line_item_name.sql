-- A won-but-not-yet-invoiced estimate has no QBO line data to source a Line
-- Item from at all (nothing's been invoiced) -- this lets a human record
-- what the job actually is, same escape-hatch pattern as the other override
-- tables, reusing estimate_resolutions since it's already keyed by
-- estimate_number and already joined in findUnmatchedWonEstimates.
alter table estimate_resolutions
  add column if not exists line_item_name text;
