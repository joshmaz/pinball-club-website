"""
Merge Pinball Map location activity into data/games.json:
  - joinedClubDate: YYYY-MM-DD of first new_lmx (first time listed at this location)
  - leftClubDate: YYYY-MM-DD of last remove_machine if the machine is off-map at end of timeline
  - pinballMapMachineId: Pinball Map machine id when known
Games present in the map but missing from our JSON are appended to currentGames or previousGames.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

# Strip Pinball Map suffix: " (Manufacturer, 19xx)" from the end of machine_name
_RE_PINBALLMAP_SUFFIX = re.compile(r" \([^,]+, \d{4}\)\s*$")


def normalize_map_title(machine_name: str) -> str:
    s = (machine_name or "").strip()
    while True:
        m = _RE_PINBALLMAP_SUFFIX.search(s)
        if not m:
            break
        s = s[: m.start()].rstrip()
    return s


def to_ymd(created_at: str) -> str:
    """Pinball Map uses ISO-8601 with offset; we store YYYY-MM-DD in America/New_York (local) date."""
    if not created_at:
        return ""
    # fromisoformat handles '2025-12-31T13:11:10.284-05:00'
    dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    return dt.date().isoformat()


@dataclass
class MachineState:
    machine_ids: set[int] = field(default_factory=set)
    add_dates: list[str] = field(default_factory=list)  # YYYY-MM-DD, chronological
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
    """
    Replays adds/removes in date order (same day: adds before removes).
    Returns (joined_club_date, left_club_date_if_off_map, on_map_at_end).
    If the machine is on map at the end, left is None (even if it left earlier in history).
    """
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
        else:  # remove
            if on:
                last_left_if_off = d
            on = False
    if on:
        return (first_join, None, True)
    return (first_join, last_left_if_off, False)


def parse_year_mfr_from_original(machine_name: str) -> tuple[str | None, str | None]:
    """Last (Mfr, YYYY) in machine_name, for details line."""
    m = re.search(r"\(([^,]+), (\d{4})\)\s*$", machine_name.strip())
    if not m:
        return None, None
    return m.group(1).strip(), m.group(2).strip()


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    activity_path = root / "data" / "pinballmap-location-8908-activity.json"
    games_path = root / "data" / "games.json"

    with open(activity_path, encoding="utf-8") as f:
        activity = json.load(f)

    with open(games_path, encoding="utf-8") as f:
        data = json.load(f)

    subs = activity.get("user_submissions") or []
    by_key: dict[str, MachineState] = {}
    # Remember one machine_name per key for new-game details
    sample_name: dict[str, str] = {}

    # machine_id -> normalized title (from any submission; helps match our games to map rows)
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
        st_obj = by_key.setdefault(key, MachineState())
        st_obj.add_event(str(st), ymd, mid_i)
        sample_name.setdefault(key, mname)

    # Inferred dates per key
    inferred: dict[str, tuple[str | None, str | None, bool, int | None]] = {}
    for key, st in by_key.items():
        j, l, on = infer_join_and_leave(st.add_dates, st.remove_dates)
        rep_id = min(st.machine_ids) if st.machine_ids else None
        inferred[key] = (j, l, on, rep_id)

    all_keys = set()
    for arr_name in ("currentGames", "previousGames"):
        for g in data.get(arr_name) or []:
            t = (g.get("title") or "").strip()
            if t:
                all_keys.add(t)

    inferred_lower: dict[str, str] = {}
    for k in inferred:
        kl = k.lower()
        if kl not in inferred_lower:
            inferred_lower[kl] = k

    def resolve_inferred_key(title: str, game: dict[str, Any]) -> str | None:
        t = (title or "").strip()
        if not t:
            return None
        if t in inferred:
            return t
        kl = t.lower()
        if kl in inferred_lower:
            return inferred_lower[kl]
        pm = game.get("pinballMapMachineId")
        if pm is not None:
            try:
                mid_g = int(pm)
            except (TypeError, ValueError):
                mid_g = None
            if mid_g is not None and mid_g in mid_to_key:
                return mid_to_key[mid_g]
        return None

    # Merge into existing games (currentGames and previousGames): same Pinball Map rules everywhere,
    # including leftClubDate when the feed ends with a removal—even if the title still lives in currentGames.
    for arr_name in ("currentGames", "previousGames"):
        for g in data.get(arr_name) or []:
            title = (g.get("title") or "").strip()
            map_key = resolve_inferred_key(title, g)
            if map_key is None:
                continue
            j, l, on, mid = inferred[map_key]
            if j:
                g["joinedClubDate"] = j
            if l:
                g["leftClubDate"] = l
            elif on and arr_name == "currentGames":
                g.pop("leftClubDate", None)
            if mid is not None:
                g["pinballMapMachineId"] = mid

    # Titles in map that we don't have
    for key, (j, l, on, mid) in inferred.items():
        if key in all_keys:
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

        entry: dict[str, Any] = {
            "title": key,
            "details": deets,
        }
        if rel:
            entry["releaseDate"] = rel
        if j:
            entry["joinedClubDate"] = j
        if l and not on:
            entry["leftClubDate"] = l
        if mid is not None:
            entry["pinballMapMachineId"] = mid

        if on:
            data.setdefault("currentGames", []).append(entry)
        else:
            data.setdefault("previousGames", []).append(entry)
        all_keys.add(key)

    with open(games_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Updated {games_path} from {activity_path}")


if __name__ == "__main__":
    main()
