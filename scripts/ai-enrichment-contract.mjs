export const PROPOSAL_VERSION = "1.0";

export function validateAiProposalResponse(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return ["Payload is not an object."];
  }
  if (payload.proposalVersion !== PROPOSAL_VERSION) {
    errors.push("proposalVersion mismatch.");
  }
  if (!payload.game || typeof payload.game !== "object") {
    errors.push("Missing game payload.");
  }
  if (!Array.isArray(payload.fields)) {
    errors.push("fields must be an array.");
  } else {
    for (const field of payload.fields) {
      if (!field || typeof field !== "object") {
        errors.push("Field entry must be an object.");
        continue;
      }
      if (!field.field || typeof field.field !== "string") {
        errors.push("Field entry missing field key.");
      }
      if (typeof field.confidenceScore !== "number") {
        errors.push("Field entry missing confidenceScore.");
      }
      if (!Array.isArray(field.warnings)) {
        errors.push("Field warnings must be an array.");
      }
    }
  }
  if (!Array.isArray(payload.imageCandidates)) {
    errors.push("imageCandidates must be an array.");
  }
  return errors;
}
