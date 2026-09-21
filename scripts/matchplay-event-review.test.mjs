import assert from "node:assert/strict";
import test from "node:test";
import { rankEventCandidates, tournamentIdFromInput } from "../supabase/functions/matchplay-event-review/match.mjs";

test("only accepts numeric IDs and canonical MatchPlay tournament URLs", () => {
  assert.equal(tournamentIdFromInput("228825"), "228825");
  assert.equal(tournamentIdFromInput("https://app.matchplay.events/tournaments/228825"), "228825");
  assert.equal(tournamentIdFromInput("https://app.matchplay.events/series/6497"), "");
  assert.equal(tournamentIdFromInput("https://example.com/tournaments/228825"), "");
});

test("prioritizes linked URL, then same-day time proximity, without assuming same-day identity", () => {
  const tournament = {
    title: "NEPL Week 1", starts_at: "2026-10-01T23:00:00Z",
    url: "https://app.matchplay.events/tournaments/123"
  };
  const events = [
    { id: "other-day", title: "Other", starts_at: "2026-10-05T23:00:00Z", external_url: "" },
    { id: "same-day-later", title: "Unrelated", starts_at: "2026-10-02T01:00:00Z", external_url: "" },
    { id: "same-day-near", title: "NEPL", starts_at: "2026-10-01T23:30:00Z", external_url: "" },
    { id: "linked", title: "Old listing", starts_at: null, external_url: tournament.url }
  ];
  const ranked = rankEventCandidates(tournament, events);
  assert.deepEqual(ranked.map((row) => row.id), ["linked", "same-day-near", "same-day-later"]);
  assert.deepEqual(ranked.map((row) => row.match.confidence), ["linked URL", "likely", "likely"]);
});

test("uses title only to suggest a nearby date, never a distant event", () => {
  const tournament = {
    title: "Yankee Swap", starts_at: "2026-10-01T23:00:00Z",
    url: "https://app.matchplay.events/tournaments/123"
  };
  const ranked = rankEventCandidates(tournament, [
    { id: "near", title: "Yankee Swap 2026", starts_at: "2026-10-02T23:00:00Z", external_url: "" },
    { id: "far", title: "Yankee Swap 2025", starts_at: "2025-10-01T23:00:00Z", external_url: "" }
  ]);
  assert.deepEqual(ranked.map((row) => row.id), ["near"]);
  assert.equal(ranked[0].match.confidence, "possible");
});
