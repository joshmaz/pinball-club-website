-- Remove legacy avatar_url from auth user metadata.
update auth.users
set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - 'avatar_url'
where coalesce(raw_user_meta_data, '{}'::jsonb) ? 'avatar_url';
