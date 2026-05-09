import test from "node:test";
import assert from "node:assert/strict";
import { PROPOSAL_VERSION, validateAiProposalResponse } from "./ai-enrichment-contract.mjs";

test("validateAiProposalResponse accepts a minimally valid contract", () => {
  const sample = {
    proposalVersion: PROPOSAL_VERSION,
    runId: "run-1",
    status: "ok",
    game: { id: "g1", slug: "slug-1", title: "Game One" },
    fields: [
      {
        field: "details",
        confidenceScore: 0.8,
        warnings: [],
      },
    ],
    imageCandidates: [],
  };
  const errors = validateAiProposalResponse(sample);
  assert.equal(errors.length, 0);
});

test("validateAiProposalResponse rejects malformed payloads", () => {
  const sample = {
    proposalVersion: "2.0",
    fields: [{ field: "", warnings: "bad" }],
    imageCandidates: {},
  };
  const errors = validateAiProposalResponse(sample);
  assert.ok(errors.length >= 3);
});
