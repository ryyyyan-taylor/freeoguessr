-- How a game's rounds are split between city, town and rural locations
-- (see LOCATION_MIXES in src/lib/rules.ts). The start route reads it when
-- planning the game's locations, so games don't need their own copy.

alter table rooms add column location_mix text not null default 'balanced'
  check (location_mix in ('balanced', 'built-up', 'cities', 'countryside'));
