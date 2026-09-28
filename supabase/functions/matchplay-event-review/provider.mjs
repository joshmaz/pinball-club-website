// Keep provider diagnostics brief and remove credentials before truncating.
function safeExcerpt(body, token) {
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = typeof parsed?.message === "string" ? parsed.message
      : typeof parsed?.error === "string" ? parsed.error : "";
  } catch { /* plain text or HTML error page */ }
  for (const secret of [token, encodeURIComponent(token)]) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/((?:access[_-]?token|api[_-]?(?:token|key)|authorization|password|secret)\s*[=:]\s*)[^\s"'<>]+/gi, "$1[redacted]")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 240);
}

export async function getMatchplay(path, token) {
  try {
    const response = await fetch(`https://app.matchplay.events/api/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      // A broken error body must not hide the provider's HTTP status.
      const body = await response.text().catch(() => "");
      const detail = safeExcerpt(body, token);
      throw new Error(`MatchPlay request failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`MatchPlay request failed (${response.status}): invalid JSON response`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("MatchPlay request failed")) throw error;
    if (error?.name === "TimeoutError" || /timed out|timeout|signal timed out/i.test(message)) {
      throw new Error("Match Play is taking too long to respond. Please try again in a few minutes.");
    }
    // Fetch errors can contain request details; never return them verbatim.
    throw new Error("MatchPlay request failed: could not reach provider");
  }
}
