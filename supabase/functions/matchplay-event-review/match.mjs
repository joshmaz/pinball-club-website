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

function embeddedCalendarDate(title) {
  const match = String(title || "").match(/\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/);
  if (!match) return "";
  const value = match[1] + "-" + match[2] + "-" + match[3];
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}

export function hasConflictingMatchDates(tournament, event) {
  const tournamentTitleDate = embeddedCalendarDate(tournament?.title);
  const eventTitleDate = embeddedCalendarDate(event?.title);
  if (tournamentTitleDate && eventTitleDate && tournamentTitleDate !== eventTitleDate) return true;
  const tournamentStart = Date.parse(tournament?.starts_at || "");
  const eventStart = Date.parse(event?.starts_at || "");
  return Number.isFinite(tournamentStart) && Number.isFinite(eventStart) &&
    Math.abs(tournamentStart - eventStart) > 30 * 60 * 60 * 1000;
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
    const exactUrl = event.external_url === matchplayUrl || (Array.isArray(event.external_links) && event.external_links.some(link => link.url === matchplayUrl));
    const eventStart = Date.parse(event.starts_at || "");
    const hours = Number.isFinite(start) && Number.isFinite(eventStart)
      ? Math.abs(start - eventStart) / 3600000 : null;
    const sameDay = Number.isFinite(start) && Number.isFinite(eventStart) &&
      clubDate(tournament.starts_at) === clubDate(event.starts_at);
    const titleDateConflict = !!(embeddedCalendarDate(tournament.title) && embeddedCalendarDate(event.title) &&
      embeddedCalendarDate(tournament.title) !== embeddedCalendarDate(event.title));
    const similarTitle = !titleDateConflict && titleOverlap(tournament.title, event.title);
    let confidence = "";
    if (exactUrl) confidence = "linked URL";
    else if (sameDay && hours <= 4) confidence = "likely";
    else if (sameDay) confidence = "same day";
    else if (hours !== null && hours <= DAY_MS / 3600000 + 6 && similarTitle) confidence = "possible";
    if (!confidence) continue;
    ranked.push({ ...event, match: { confidence, hours_apart: hours, title_overlap: similarTitle, title_date_conflict: titleDateConflict } });
  }
  const order = { "linked URL": 0, likely: 1, "same day": 2, possible: 3 };
  ranked.sort((a, b) => order[a.match.confidence] - order[b.match.confidence] ||
    (a.match.hours_apart ?? Infinity) - (b.match.hours_apart ?? Infinity));
  return ranked;
}
