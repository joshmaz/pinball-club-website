# Event external links

`events.external_links` is the canonical JSONB array of `{ url, label? }` objects. An empty array means no links. The editor supports adding/removing rows and optional labels. Recognized services autofill labels until the label is manually edited, including manually clearing it. Existing saved labels are treated as intentional. Public cards use stored labels, then recognized service names, then “Event link”; only HTTP(S) links are rendered.

Migration `20260926120000_event_external_links.sql` was applied and recorded on September 26, 2026. All 215 existing URLs across 236 records were preserved, with independent readback confirming unrelated fields unchanged except automatic `updated_at`. A pre-migration backup is retained outside git in the task's reconciliation records. The refreshed public snapshot includes the arrays.

The legacy `external_url` remains a compatibility mirror of the first array entry. New clients write the array; a database trigger mirrors its first URL. Older importers that only change `external_url` replace/remove that first link while preserving additional links. Migration shape checks reject malformed arrays. No access policies were changed.

The JSON importer retains arrays and labels. Match Play review recognizes secondary links and the editor appends tournament links; it uses the full loaded event record to preserve links even when talking to an older review function. The updated review function should be deployed with this PR for secondary-link matching outside the nearby-date window.

Validation covers migration/backfill/idempotency, compatibility writes, removal, known service labels and deceptive domains, unsafe schemes, manual label preservation, editor reset/add/remove behavior, multiple-link read/write payloads, and secondary Match Play matching. The editor was also inspected in a local browser fixture using the site's actual markup, scripts, and styles.
