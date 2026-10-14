-- Phase 1 Discord linking: protect verified Discord identities from client-side spoofing.
-- OAuth callback must write through a server-side service-role client after
-- validating the Discord authorization code and the initiating member.
-- Existing IFPA/Stern/Match Play profile editing remains unchanged.

create unique index if not exists external_accounts_discord_identity_unique
  on public.external_accounts (account_handle)
  where provider_slug = 'discord';

-- Existing RLS policies permit members to write their own unverified profiles.
-- Restrict Discord changes independently of ownership: a trusted server-side
-- OAuth callback is the only permitted writer for this provider.
create or replace function public.snh_protect_verified_external_account()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user <> 'service_role' then
    if (tg_op <> 'INSERT' and old.provider_slug = 'discord')
       or (tg_op <> 'DELETE' and new.provider_slug = 'discord') then
      raise exception 'Discord identities can only be changed by verified linking'
        using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.snh_protect_verified_external_account() from public;

drop trigger if exists trg_protect_verified_external_account on public.external_accounts;
create trigger trg_protect_verified_external_account
before insert or update or delete on public.external_accounts
for each row execute function public.snh_protect_verified_external_account();
