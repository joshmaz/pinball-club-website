-- Use short street-only labels on stint rows (member portal + ingest).

update public.game_location_stints
set address = 'Haines St'
where address = '134 Haines Street, Nashua, NH';

update public.game_location_stints
set address = 'Bridge St'
where address = '48 Bridge St, Unit 3A, Nashua';
