"""
Merge Pinball Map location activity into data/games.json.

Per-game club presence is stored in locationStints[] (one object per physical
location / Pinball Map location id), for example:
  { "address": "...", "pinballMapLocationId": 8908,
    "joinedClubDate", "leftClubDate", "pinballMapMachineId" }

Legacy top-level joinedClubDate / leftClubDate / pinballMapMachineId are
migrated into the first stint for 134 Haines on first run.

Games only on the map file are appended to currentGames or previousGames.
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
LEGACY_CLUB_ADDRESS = "134 Haines Street, Nashua, NH"


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
) -> tuple[str | None, str | None, bool]:
    events: list[tuple[str, str]] = []
    for d in add_dates:
        events.append((d, "add"))
    for d in remove_dates:
        events.append((d, "remove"))
    events.sort(key=lambda x: (x[0], 0 if x[1] == "add" else 1))

    on = False
    first_join: str | None = None
    last_left_if_off: str | None = None
    for d, k in events:
        if k == "add":
            if first_join is None:
                first_join = d
            on = True
        else:
            if on:
                last_left_if_off = d
            on = False
    if on:
        return (first_join, None, True)
    return (first_join, last_left_if_off, False)


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


def find_stint_index(stints: list[dict[str, Any]], location_id: int) -> int:
    for i, s in enumerate(stints):
        if s.get("pinballMapLocationId") == location_id:
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
    arr_name: str,
) -> None:
    stints = game.setdefault("locationStints", [])
    if not isinstance(stints, list):
        stints = []
        game["locationStints"] = stints

    idx = find_stint_index(stints, location_id)
    if idx < 0:
        stints.append(
            {
                "address": location_address,
                "pinballMapLocationId": location_id,
            }
        )
        idx = len(stints) - 1

    st = stints[idx]
    st.setdefault("address", location_address)
    st["pinballMapLocationId"] = location_id

    if j:
        st["joinedClubDate"] = j
    if l:
        st["leftClubDate"] = l
    elif on and arr_name == "currentGames":
        st.pop("leftClubDate", None)
    if mid is not None:
        st["pinballMapMachineId"] = mid


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

    inferred: dict[str, tuple[str | None, str | None, bool, int | None]] = {}
    for key, st in by_key.items():
        j, l, on = infer_join_and_leave(st.add_dates, st.remove_dates)
        rep_id = min(st.machine_ids) if st.machine_ids else None
        inferred[key] = (j, l, on, rep_id)

    all_keys: set[str] = set()
    for arr_name in ("currentGames", "previousGames"):
        for g in data.get(arr_name) or []:
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
            for arr in (data.get("currentGames") or [], data.get("previousGames") or []):
                for g in arr:
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

    for arr_name in ("currentGames", "previousGames"):
        for g in data.get(arr_name) or []:
            title = (g.get("title") or "").strip()
            map_key = resolve_inferred_key(title, g)
            if map_key is None:
                continue
            j, l, on, mid = inferred[map_key]
            apply_pinball_to_stints(
                g,
                location_id=activity_location_id,
                location_address=location_address,
                j=j,
                l=l,
                on=on,
                mid=mid,
                arr_name=arr_name,
            )

    for key, (j, l, on, mid) in inferred.items():
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

        stint: dict[str, Any] = {
            "address": location_address,
            "pinballMapLocationId": activity_location_id,
        }
        if j:
            stint["joinedClubDate"] = j
        if l and not on:
            stint["leftClubDate"] = l
        if mid is not None:
            stint["pinballMapMachineId"] = mid

        entry: dict[str, Any] = {
            "title": key,
            "details": deets,
            "locationStints": [stint],
        }
        if rel:
            entry["releaseDate"] = rel

        if on:
            data.setdefault("currentGames", []).append(entry)
        else:
            data.setdefault("previousGames", []).append(entry)
        all_keys.add(key)

    with open(games_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Updated {games_path} from {activity_path} (location_id={activity_location_id})")


if __name__ == "__main__":
    main()
