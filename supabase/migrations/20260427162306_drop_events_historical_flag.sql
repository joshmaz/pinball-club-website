-- Remove legacy historical-event flags from public.events.
-- Past/upcoming status is derived from event_date in app code.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'events'
  ) THEN
    ALTER TABLE public.events DROP COLUMN IF EXISTS historical_event;
    ALTER TABLE public.events DROP COLUMN IF EXISTS is_historical;
    ALTER TABLE public.events DROP COLUMN IF EXISTS historical;
  END IF;
END $$;
