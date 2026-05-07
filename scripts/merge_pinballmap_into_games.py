"""
Merge Pinball Map location activity into data/games.json.

Per-game club presence is stored in locationStints[] (one object per physical
location / Pinball Map location id), for example:
  { "address": "...", "pinballMapLocationId": 8908,
    "joinedClubDate", "leftClubDate", "pinballMapMachineId",
    "dateUnknown", "sortKeyJoined", "sortKeyLeft" }

The last three are written by this script for sorting (mirrors assets/js/games.js):
dateUnknown = no joinedClubDate and no leftClubDate; sort keys use an editorial
2016 band for unknown tenure, or 9999-12-31 for current games with no leave date.

Legacy top-level joinedClubDate / leftClubDate / pinballMapMachineId are
migrated into the first stint for Haines St on first run.

Games live in a single `games` array (sorted newest-first by first stint join).
`mapAtClub` tracks floor status inferred from Pinball Map; editors may set
`manualAtClubOverride` (true/false) when map coverage is incomplete. `atClub`
is the resolved effective value (manual override when present, else map value).
Unknown-tenure sort keys use effective `atClub` the same way the old
current/previous split did.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

# Strip Pinball Map suffix: " (Manufacturer, 19xx)" from the end of machine_name.
# Require the inner segment before ", YYYY" to be a single paren level so titles like
# "Avengers: Infinity Quest (Pro) (Stern, 2020)" strip only " (Stern, 2020)".
_RE_PINBALLMAP_SUFFIX = re.compile(
    r" \(([^)]+, \d{4})\)\s*$"
)

# Pinball Map location id 8908 — pre-move club home (extend when new locations exist).
LEGACY_PINBALLMAP_LOCATION_ID = 8908
LEGACY_CLUB_ADDRESS = "Haines St"
BRIDGE_CLUB_ADDRESS = "Bridge St"
HAINES_LAST_DAY = "2026-04-23"
BRIDGE_FIRST_DAY = "2026-04-24"

UNKNOWN_TENURE_SORT_JOIN = "2016-01-01"
UNKNOWN_TENURE_SORT_LEFT_PREVIOUS = "2016-12-31"
STILL_AT_CLUB_SORT_LEFT = "9999-12-31"


def _has_nonempty_string(v: Any) -> bool:
    if v is None:
        return False
    return str(v).strip() != ""


def _is_bool(v: Any) -> bool:
    return isinstance(v, bool)


def _manual_at_club_override(game: dict[str, Any]) -> bool | None:
    val = game.get("manualAtClubOverride")
    return val if _is_bool(val) else None


def resolve_game_at_club(game: dict[str, Any]) -> bool:
    manual = _manual_at_club_override(game)
    if manual is not None:
        return manual
    map_at_club = game.get("mapAtClub")
    if _is_bool(map_at_club):
        return map_at_club
    return bool(game.get("atClub"))


def sync_game_at_club_fields(game: dict[str, Any]) -> None:
    """Keep map/manual/effective fields aligned and backward-compatible."""
    if not _is_bool(game.get("mapAtClub")):
        game["mapAtClub"] = bool(game.get("atClub"))
    game["atClub"] = resolve_game_at_club(game)


def enrich_location_stint_sort_fields(
    stint: dict[str, Any], *, is_current_game: bool
) -> None:
    """Set dateUnknown and ISO sortKey* on a stint (same rules as assets/js/games.js)."""
    has_join = _has_nonempty_string(stint.get("joinedClubDate"))
    has_leave = _has_nonempty_string(stint.get("leftClubDate"))
    date_unknown = not has_join and not has_leave
    stint["dateUnknown"] = date_unknown
    if date_unknown:
        stint["sortKeyJoined"] = UNKNOWN_TENURE_SORT_JOIN
        stint["sortKeyLeft"] = (
            STILL_AT_CLUB_SORT_LEFT
            if is_current_game
            else UNKNOWN_TENURE_SORT_LEFT_PREVIOUS
        )
        return
    stint["sortKeyJoined"] = (
        str(stint["joinedClubDate"]).strip()
        if has_join
        else UNKNOWN_TENURE_SORT_JOIN
    )
    if has_leave:
        stint["sortKeyLeft"] = str(stint["leftClubDate"]).strip()
    else:
        stint["sortKeyLeft"] = (
            STILL_AT_CLUB_SORT_LEFT
            if is_current_game
            else UNKNOWN_TENURE_SORT_LEFT_PREVIOUS
        )


def game_is_at_club(g: dict[str, Any]) -> bool:
    """Return effective floor status (manual override first, then map-derived)."""
    return resolve_game_at_club(g)


def migrate_data_shape_in_place(data: dict[str, Any]) -> None:
    """Normalize legacy { currentGames, previousGames } into { games }."""
    if isinstance(data.get("games"), list) and not (
        data.get("currentGames") or data.get("previousGames")
    ):
        data.pop("currentGames", None)
        data.pop("previousGames", None)
        return

    cur = [g for g in (data.get("currentGames") or []) if isinstance(g, dict)]
    prev = [g for g in (data.get("previousGames") or []) if isinstance(g, dict)]
    for g in cur:
        g.setdefault("atClub", True)
        g.setdefault("mapAtClub", True)
    for g in prev:
        g.setdefault("atClub", False)
        g.setdefault("mapAtClub", False)
    data["games"] = cur + prev
    data.pop("currentGames", None)
    data.pop("previousGames", None)


def primary_sort_key_joined(game: dict[str, Any]) -> str:
    stints = game.get("locationStints") or []
    if not isinstance(stints, list) or not stints:
        return "9999-12-31"
    best: str | None = None
    for st in stints:
        if not isinstance(st, dict):
            continue
        k = st.get("sortKeyJoined")
        if not _has_nonempty_string(k):
            continue
        ks = str(k).strip()
        if best is None or ks < best:
            best = ks
    return best if best is not None else "9999-12-31"


def sort_games_newest_join_first_in_place(data: dict[str, Any]) -> None:
    games = data.get("games") or []
    if not isinstance(games, list):
        return
    games.sort(key=lambda g: str((g or {}).get("title") or "").lower())
    games.sort(key=lambda g: primary_sort_key_joined(g), reverse=True)


def enrich_all_games_sort_fields(data: dict[str, Any]) -> None:
    for g in data.get("games") or []:
        if not isinstance(g, dict):
            continue
        sync_game_at_club_fields(g)
        on_floor = game_is_at_club(g)
        for st in g.get("locationStints") or []:
            if isinstance(st, dict):
                enrich_location_stint_sort_fields(st, is_current_game=on_floor)


def normalize_map_title(machine_name: str) -> str:
    s = (machine_name or "").strip()
    while True:
        m = _RE_PINBALLMAP_SUFFIX.search(s)
        if not m:
            break
        s = s[: m.start()].rstrip()
    return s


def to_ymd(created_at: str) -> str:
    if not created_at:
        return ""
    dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    return dt.date().isoformat()


@dataclass
class MachineState:
    machine_ids: set[int] = field(default_factory=set)
    add_dates: list[str] = field(default_factory=list)
    remove_dates: list[str] = field(default_factory=list)

    def add_event(self, kind: str, ymd: str, mid: int | None) -> None:
        if mid is not None:
            self.machine_ids.add(mid)
        if kind == "new_lmx":
            self.add_dates.append(ymd)
        elif kind == "remove_machine":
            self.remove_dates.append(ymd)


def infer_join_and_leave(
    add_dates: list[str], remove_dates: list[str]
) -> tuple[str | None, str | None, bool, str | None]:
    events: list[tuple[str, str]] = []
    for d in add_dates:
        events.append((d, "add"))
    for d in remove_dates:
        events.append((d, "remove"))
    events.sort(key=lambda x: (x[0], 0 if x[1] == "add" else 1))

    on = False
    first_join: str | None = None
    last_left_if_off: str | None = None
    current_join: str | None = None
    for d, k in events:
        if k == "add":
            if first_join is None:
                first_join = d
            if not on:
                current_join = d
            on = True
        else:
            if on:
                last_left_if_off = d
            on = False
    if on:
        return (first_join, None, True, current_join)
    return (first_join, last_left_if_off, False, None)


def parse_year_mfr_from_original(machine_name: str) -> tuple[str | None, str | None]:
    m = re.search(r"\(([^)]+), (\d{4})\)\s*$", machine_name.strip())
    if not m:
        return None, None
    # Only the map's trailing "(Manufacturer, YYYY)" — not e.g. "(Pro) (Stern, 2020)"
    inner = m.group(1).strip()
    if ")" in inner:
        return None, None
    return inner, m.group(2).strip()


def address_for_pinballmap_location(
    location_id: int, meta: dict[str, Any] | None
) -> str:
    if location_id == LEGACY_PINBALLMAP_LOCATION_ID:
        return LEGACY_CLUB_ADDRESS
    name = (meta or {}).get("location_name") if meta else None
    if name:
        return f"{name} (Pinball Map location {location_id})"
    return f"Pinball Map location {location_id}"


def choose_canonical_stint(
    *,
    location_id: int,
    join: str | None,
    leave: str | None,
    on: bool,
    fallback_address: str,
) -> tuple[str, str | None, str | None]:
    if location_id != LEGACY_PINBALLMAP_LOCATION_ID:
        return fallback_address, join, leave
    if join and join >= BRIDGE_FIRST_DAY:
        return BRIDGE_CLUB_ADDRESS, join, leave
    if leave and leave <= HAINES_LAST_DAY:
        return LEGACY_CLUB_ADDRESS, join, leave
    if join and join < BRIDGE_FIRST_DAY and (on or not leave or leave >= BRIDGE_FIRST_DAY):
        return BRIDGE_CLUB_ADDRESS, BRIDGE_FIRST_DAY, leave
    if not join and on:
        return BRIDGE_CLUB_ADDRESS, BRIDGE_FIRST_DAY, None
    return LEGACY_CLUB_ADDRESS, join, leave


def migrate_legacy_pinball_fields(game: dict[str, Any]) -> None:
    """Fold top-level Pinball fields into locationStints[0] for Haines / 8908; idempotent."""
    stints = game.get("locationStints")
    if isinstance(stints, list) and len(stints) > 0:
        for k in ("joinedClubDate", "leftClubDate", "pinballMapMachineId"):
            game.pop(k, None)
        return

    stint: dict[str, Any] = {
        "address": LEGACY_CLUB_ADDRESS,
        "pinballMapLocationId": LEGACY_PINBALLMAP_LOCATION_ID,
    }
    if game.get("joinedClubDate"):
        stint["joinedClubDate"] = game["joinedClubDate"]
    if game.get("leftClubDate"):
        stint["leftClubDate"] = game["leftClubDate"]
    if game.get("pinballMapMachineId") is not None:
        stint["pinballMapMachineId"] = game["pinballMapMachineId"]

    game["locationStints"] = [stint]
    for k in ("joinedClubDate", "leftClubDate", "pinballMapMachineId"):
        game.pop(k, None)


def find_stint_index(
    stints: list[dict[str, Any]],
    location_id: int,
    location_address: str,
) -> int:
    for i, s in enumerate(stints):
        if (
            s.get("pinballMapLocationId") == location_id
            and str(s.get("address") or "").strip().lower()
            == location_address.strip().lower()
        ):
            return i
    return -1


def apply_pinball_to_stints(
    game: dict[str, Any],
    *,
    location_id: int,
    location_address: str,
    j: str | None,
    l: str | None,
    on: bool,
    mid: int | None,
) -> None:
    stints = game.setdefault("locationStints", [])
    if not isinstance(stints, list):
        stints = []
        game["locationStints"] = stints

    address, joined, left = choose_canonical_stint(
        location_id=location_id,
        join=j,
        leave=l,
        on=on,
        fallback_address=location_address,
    )

    idx = find_stint_index(stints, location_id, address)
    if idx < 0:
        stints.append(
            {
                "address": address,
                "pinballMapLocationId": location_id,
            }
        )
        idx = len(stints) - 1

    st = stints[idx]
    st["address"] = address
    st["pinballMapLocationId"] = location_id

    if joined:
        st["joinedClubDate"] = joined
    if left:
        st["leftClubDate"] = left
    elif on:
        st.pop("leftClubDate", None)
    if mid is not None:
        st["pinballMapMachineId"] = mid
    game["mapAtClub"] = bool(on)
    game["atClub"] = resolve_game_at_club(game)


def machine_id_from_game(game: dict[str, Any], location_id: int) -> int | None:
    if game.get("pinballMapMachineId") is not None:
        try:
            return int(game["pinballMapMachineId"])
        except (TypeError, ValueError):
            pass
    for st in game.get("locationStints") or []:
        if st.get("pinballMapLocationId") == location_id and st.get("pinballMapMachineId") is not None:
            try:
                return int(st["pinballMapMachineId"])
            except (TypeError, ValueError):
                pass
    for st in game.get("locationStints") or []:
        if st.get("pinballMapMachineId") is not None:
            try:
                return int(st["pinballMapMachineId"])
            except (TypeError, ValueError):
                pass
    return None


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    activity_path = root / "data" / "pinballmap-location-8908-activity.json"
    games_path = root / "data" / "games.json"

    if len(sys.argv) >= 2:
        activity_path = Path(sys.argv[1]).resolve()
    if len(sys.argv) >= 3:
        games_path = Path(sys.argv[2]).resolve()

    with open(activity_path, encoding="utf-8") as f:
        activity = json.load(f)

    with open(games_path, encoding="utf-8") as f:
        data = json.load(f)

    migrate_data_shape_in_place(data)

    meta = activity.get("meta") or {}
    try:
        activity_location_id = int(meta.get("location_id") or LEGACY_PINBALLMAP_LOCATION_ID)
    except (TypeError, ValueError):
        activity_location_id = LEGACY_PINBALLMAP_LOCATION_ID
    location_address = address_for_pinballmap_location(activity_location_id, meta)

    subs = activity.get("user_submissions") or []
    by_key: dict[str, MachineState] = {}
    sample_name: dict[str, str] = {}
    mid_to_key: dict[int, str] = {}

    for row in subs:
        mname = row.get("machine_name") or ""
        key = normalize_map_title(mname)
        mid = row.get("machine_id")
        try:
            mid_i = int(mid) if mid is not None else None
        except (TypeError, ValueError):
            mid_i = None
        if mid_i is not None and key:
            mid_to_key[mid_i] = key

    for row in subs:
        st = row.get("submission_type")
        if st not in ("new_lmx", "remove_machine"):
            continue
        mname = row.get("machine_name") or ""
        key = normalize_map_title(mname)
        if not key:
            continue
        ymd = to_ymd(row.get("created_at") or "")
        if not ymd:
            continue
        mid = row.get("machine_id")
        try:
            mid_i = int(mid) if mid is not None else None
        except (TypeError, ValueError):
            mid_i = None
        by_key.setdefault(key, MachineState()).add_event(str(st), ymd, mid_i)
        sample_name.setdefault(key, mname)

    inferred: dict[str, tuple[str | None, str | None, bool, str | None, int | None]] = {}
    for key, st in by_key.items():
        j, l, on, current_join = infer_join_and_leave(st.add_dates, st.remove_dates)
        rep_id = min(st.machine_ids) if st.machine_ids else None
        inferred[key] = (j, l, on, current_join, rep_id)

    all_keys: set[str] = set()
    for g in data.get("games") or []:
        migrate_legacy_pinball_fields(g)
        t = (g.get("title") or "").strip()
        if t:
            all_keys.add(t)

    inferred_lower: dict[str, str] = {}
    for k in inferred:
        kl = k.lower()
        if kl not in inferred_lower:
            inferred_lower[kl] = k

    def find_canonical_for_short_map_key(
        short_key: str, rep_machine_id: int | None
    ) -> str | None:
        """When the map uses a base title (e.g. 'Deadpool') but the site lists an edition
        ('Deadpool (Pro)'), return that canonical title so we do not add a duplicate row."""
        sk = (short_key or "").strip()
        if not sk:
            return None
        if sk in all_keys:
            return sk
        skl = sk.lower()
        prefix_matches = [t for t in all_keys if t.lower().startswith(skl + " (")]
        if not prefix_matches:
            return None
        if len(prefix_matches) == 1:
            return prefix_matches[0]
        if rep_machine_id is not None:
            for g in data.get("games") or []:
                t = (g.get("title") or "").strip()
                if t not in prefix_matches:
                    continue
                if machine_id_from_game(g, activity_location_id) == rep_machine_id:
                    return t
        return max(prefix_matches, key=len)

    def resolve_inferred_key(title: str, game: dict[str, Any]) -> str | None:
        t = (title or "").strip()
        if not t:
            return None
        if t in inferred:
            return t
        kl = t.lower()
        if kl in inferred_lower:
            return inferred_lower[kl]
        prefix_keys = [
            ik
            for ik in inferred
            if ik and kl.startswith(ik.lower() + " (")
        ]
        if prefix_keys:
            return max(prefix_keys, key=len)
        mid_g = machine_id_from_game(game, activity_location_id)
        if mid_g is not None and mid_g in mid_to_key:
            return mid_to_key[mid_g]
        return None

    for g in data.get("games") or []:
        title = (g.get("title") or "").strip()
        map_key = resolve_inferred_key(title, g)
        if map_key is None:
            continue
        j, l, on, current_join, mid = inferred[map_key]
        stint_join = current_join or j if on else j
        apply_pinball_to_stints(
            g,
            location_id=activity_location_id,
            location_address=location_address,
            j=stint_join,
            l=l,
            on=on,
            mid=mid,
        )

    for key, (j, l, on, current_join, mid) in inferred.items():
        if key in all_keys:
            continue
        if find_canonical_for_short_map_key(key, mid) is not None:
            continue
        mname = sample_name.get(key, key)
        mfr, yr = parse_year_mfr_from_original(mname)
        rel = f"{yr}-01-01" if yr and len(yr) == 4 else None
        parts: list[str] = []
        if mfr and yr:
            parts.append(f"{yr} {mfr}.")
        parts.append("From Pinball Map location activity (not on our site list before).")
        if j:
            parts.append(f"First listed on the map on {j}.")
        if l:
            parts.append(f"Removed from the map on {l}.")
        elif on and j:
            parts.append("Still on the map as of the latest activity.")
        deets = " ".join(parts)

        stint_join = current_join or j if on else j
        canonical_address, canonical_join, canonical_left = choose_canonical_stint(
            location_id=activity_location_id,
            join=stint_join,
            leave=l,
            on=on,
            fallback_address=location_address,
        )
        stint: dict[str, Any] = {
            "address": canonical_address,
            "pinballMapLocationId": activity_location_id,
        }
        if canonical_join:
            stint["joinedClubDate"] = canonical_join
        if canonical_left and not on:
            stint["leftClubDate"] = canonical_left
        if mid is not None:
            stint["pinballMapMachineId"] = mid

        entry: dict[str, Any] = {
            "title": key,
            "details": deets,
            "locationStints": [stint],
            "mapAtClub": bool(on),
            "atClub": bool(on),
        }
        if rel:
            entry["releaseDate"] = rel

        data.setdefault("games", []).append(entry)
        all_keys.add(key)

    enrich_all_games_sort_fields(data)
    sort_games_newest_join_first_in_place(data)

    with open(games_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Updated {games_path} from {activity_path} (location_id={activity_location_id})")


if __name__ == "__main__":
    main()
