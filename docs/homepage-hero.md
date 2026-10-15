# Homepage hero delivery

The homepage uses `assets/images/home-club-pinball.webp`, a checked-in copy of the
user-selected published club photo (1920 × 1080 WebP). It is shipped by both the
Netlify preview build and the existing AWS deployment.

Source: public photo asset `5d032449-aae6-4f13-bc5e-b8e8c96b1de0`, album
`6333864b-adc5-4966-96e2-be885150cdc7`, derivative
`web-e266054c-071b-4b20-b4f0-a8cadda33c09-ff15aa943ca5.webp`.

On 2026-10-14 the previous hardcoded hero object
`d5b1e902-de00-44fc-8d55-9409e257c1f1/web-2efd87a4ca7a.jpg` returned HTTP 400
with `404`, `NoSuchKey`, and `Object not found` in its Supabase response body.
The PR preview's image completed with naturalWidth 0. Production HTML used the
same missing object; continued rendering there is consistent with cached bytes,
not a different valid URL. The deleted asset was also absent from the public
photo listing. This is not a Netlify asset-copy or origin-permission issue.

Keeping the hero in the release makes it independent of gallery asset deletion.
The replacement photo has accurate alt text and a general club caption.
No storage policy change, migration, or separate production deployment is needed.
