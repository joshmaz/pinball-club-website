# Homepage hero delivery

The homepage uses `assets/images/home-league-night.jpg`, a checked-in copy of the
published league-night derivative (900 × 1600 JPEG). It is shipped by both the
Netlify preview build and the existing AWS deployment.

Source: public photo asset `f6fe3d22-eb5d-4fec-886f-d2bb584ccf91`, album
`7f3e05a8-5595-4d09-be63-53a1712c9f12`, derivative `web-b22d476b7993.jpg`.

On 2026-10-14 the previous hardcoded hero object
`d5b1e902-de00-44fc-8d55-9409e257c1f1/web-2efd87a4ca7a.jpg` returned HTTP 400
with `404`, `NoSuchKey`, and `Object not found` in its Supabase response body.
The PR preview's image completed with naturalWidth 0. Production HTML used the
same missing object; continued rendering there is consistent with cached bytes,
not a different valid URL. The deleted asset was also absent from the public
photo listing. This is not a Netlify asset-copy or origin-permission issue.

Keeping the hero in the release makes it independent of gallery asset deletion.
The replacement photo has accurate alt text and a general league-night caption.
No storage policy change, migration, or separate production deployment is needed.
