-- PDF question-paper import: tag imported questions with the exam they came from,
-- and let chapter-less exercise rows exist (exercise_type is null for papers).
-- Run in the Supabase SQL editor (dashboard → SQL) or via `supabase db push`.

alter table questions
  add column if not exists paper_type text;

alter table questions
  drop constraint if exists questions_paper_type_check;

alter table questions
  add constraint questions_paper_type_check
  check (paper_type is null or paper_type in ('JEE', 'NEET', 'BITS', 'BOARDS', 'Other'));

alter table questions
  alter column exercise_type drop not null;

-- Optional: quick filter for the paper browser you may build later.
create index if not exists questions_paper_type_idx on questions (paper_type);
