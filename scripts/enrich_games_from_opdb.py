"""
Enrich data/games.json from data/latest-opdb.json using safe, non-destructive merges.

Matching strategy:
1) Parse ipdbId from each game's ipdbUrl and match OPDB machines by ipdbId.
2) If no machine match, match OPDB aliases by ipdbId.

Write policy:
- Only set new fields when they are currently missing/blank on the game record.
- Never overwrite existing values.
- Do not modify UI code; this is data enrichment only.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


IPDB_ID_RE = re.compile(r"id=(\d+)")


def parse_ipdb_id(ipdb_url: Any) -> int | None:
    if not isinstance(ipdb_url, str) or not ipdb_url.strip():
        return None
    match = IPDB_ID_RE.search(ipdb_url)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def is_missing(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    return False


def set_if_missing(target: dict[str, Any], key: str, value: Any) -> bool:
    if is_missing(value):
        return False
    if key in target and not is_missing(target.get(key)):
        return False
    target[key] = value
    return True


def enrich_game_from_opdb(game: dict[str, Any], opdb_record: dict[str, Any], *, matched_via: str) -> int:
    changed = 0
    changed += int(set_if_missing(game, "opdbId", opdb_record.get("opdbId")))
    changed += int(set_if_missing(game, "opdbMatchedVia", matched_via))
    changed += int(set_if_missing(game, "opdbCanonicalName", opdb_record.get("name")))

    manufacturer = opdb_record.get("manufacturer")
    if isinstance(manufacturer, dict):
        changed += int(set_if_missing(game, "manufacturer", manufacturer.get("name")))
        changed += int(set_if_missing(game, "manufacturerFullName", manufacturer.get("fullName")))

    changed += int(set_if_missing(game, "manufactureDate", opdb_record.get("manufactureDate")))
    changed += int(set_if_missing(game, "type", opdb_record.get("type")))
    changed += int(set_if_missing(game, "display", opdb_record.get("display")))
    changed += int(set_if_missing(game, "playerCount", opdb_record.get("playerCount")))
    return changed


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    games_path = root / "data" / "games.json"
    opdb_path = root / "data" / "latest-opdb.json"

    games_doc = json.loads(games_path.read_text(encoding="utf-8"))
    opdb_doc = json.loads(opdb_path.read_text(encoding="utf-8"))

    games = games_doc.get("games")
    machines = opdb_doc.get("machines")
    aliases = opdb_doc.get("aliases")
    if not isinstance(games, list) or not isinstance(machines, list) or not isinstance(aliases, list):
        raise ValueError("Unexpected JSON format. Expected games, machines, and aliases arrays.")

    machine_by_ipdb: dict[int, dict[str, Any]] = {}
    for m in machines:
        if not isinstance(m, dict):
            continue
        ipdb_id = m.get("ipdbId")
        if isinstance(ipdb_id, int):
            machine_by_ipdb[ipdb_id] = m

    alias_by_ipdb: dict[int, dict[str, Any]] = {}
    for a in aliases:
        if not isinstance(a, dict):
            continue
        ipdb_id = a.get("ipdbId")
        if isinstance(ipdb_id, int):
            alias_by_ipdb[ipdb_id] = a

    total_games = 0
    no_ipdb = 0
    matched_machine = 0
    matched_alias = 0
    unmatched_ipdb = 0
    changed_games = 0
    changed_fields = 0

    for game in games:
        if not isinstance(game, dict):
            continue
        total_games += 1
        ipdb_id = parse_ipdb_id(game.get("ipdbUrl"))
        if ipdb_id is None:
            no_ipdb += 1
            continue

        matched = machine_by_ipdb.get(ipdb_id)
        matched_via = "machine"
        if matched is None:
            matched = alias_by_ipdb.get(ipdb_id)
            matched_via = "alias"
        if matched is None:
            unmatched_ipdb += 1
            continue

        if matched_via == "machine":
            matched_machine += 1
        else:
            matched_alias += 1

        field_changes = enrich_game_from_opdb(game, matched, matched_via=matched_via)
        if field_changes > 0:
            changed_games += 1
            changed_fields += field_changes

    games_path.write_text(
        json.dumps(games_doc, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    print("OPDB enrichment complete")
    print(f"Games processed: {total_games}")
    print(f"No ipdbUrl: {no_ipdb}")
    print(f"Matched via machine: {matched_machine}")
    print(f"Matched via alias: {matched_alias}")
    print(f"IPDB present but unmatched in OPDB: {unmatched_ipdb}")
    print(f"Games updated: {changed_games}")
    print(f"Fields added: {changed_fields}")


if __name__ == "__main__":
    main()
