const DAY_MS = 24 * 60 * 60 * 1000;

export function tournamentIdFromInput(input) {
  const raw = String(input || "").trim();
  if (/^[1-9]\d{0,9}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "app.matchplay.events") return "";
    const match = url.pathname.match(/^\/tournaments\/([1-9]\d{0,9})\/?$/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function clubDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

function titleWords(value) {
  return new Set(String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(
    (word) => word.length > 2 && !["the", "and", "snhpc", "pinball"].includes(word)
  ));
}

function titleOverlap(a, b) {
  const left = titleWords(a);
  const right = titleWords(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared >= Math.min(2, left.size, right.size);
}

export function rankEventCandidates(tournament, events) {
  const start = Date.parse(tournament.starts_at || "");
  const matchplayUrl = tournament.url;
  const ranked = [];
  for (const event of events || []) {
    const exactUrl = event.external_url === matchplayUrl;
    const eventStart = Date.parse(event.starts_at || "");
    const hours = Number.isFinite(start) && Number.isFinite(eventStart)
      ? Math.abs(start - eventStart) / 3600000 : null;
    const sameDay = Number.isFinite(start) && Number.isFinite(eventStart) &&
      clubDate(tournament.starts_at) === clubDate(event.starts_at);
    const similarTitle = titleOverlap(tournament.title, event.title);
    let confidence = "";
    if (exactUrl) confidence = "linked URL";
    else if (sameDay && hours <= 4) confidence = "likely";
    else if (sameDay) confidence = "same day";
    else if (hours !== null && hours <= DAY_MS / 3600000 + 6 && similarTitle) confidence = "possible";
    if (!confidence) continue;
    ranked.push({ ...event, match: { confidence, hours_apart: hours, title_overlap: similarTitle } });
  }
  const order = { "linked URL": 0, likely: 1, "same day": 2, possible: 3 };
  ranked.sort((a, b) => order[a.match.confidence] - order[b.match.confidence] ||
    (a.match.hours_apart ?? Infinity) - (b.match.hours_apart ?? Infinity));
  return ranked;
}
