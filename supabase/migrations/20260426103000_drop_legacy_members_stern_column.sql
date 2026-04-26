-- Remove legacy Stern field from members now that external_accounts is canonical.
alter table public.members
  drop column if exists stern_insider_username;
