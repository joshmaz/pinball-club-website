# AWS clean URL routing

Netlify handles the friendly routes through the redirects in `netlify.toml`.
The production S3 REST origin needs an equivalent CloudFront viewer-request
rewrite because S3 does not resolve these extensionless object keys:

| Public path | S3 object |
| --- | --- |
| `/donate` | `/donate.html` |
| `/store` | `/store.html` |
| `/slideshow` | `/slideshow.html` |
| `/slideshow/play` | `/slideshow-play.html` |

The tested CloudFront Function source is
[`cloudfront/clean-url-rewrite.js`](../cloudfront/clean-url-rewrite.js). It
changes only those four paths and preserves query strings and all other request
fields.

## One-time CloudFront setup

1. In CloudFront, create a function using the `cloudfront-js-1.0` runtime and
   paste the checked-in source.
2. Run the CloudFront test cases for each mapped path and an unrelated path,
   then publish the function.
3. Associate the published function with the production distribution's default
   cache behavior at the **Viewer request** event.
4. After the association is deployed, verify the three public paths and their
   `.html` targets in production.

Do not associate or publish this function until the production release has been
approved. Once the S3 workflow switches to syncing `dist/`, this rewrite must
be associated so the three friendly paths continue to resolve. Netlify continues
to use its checked-in redirects.

The AWS workflow itself does not create or associate CloudFront Functions. The
function is a small, separately reviewable routing rule; the workflow continues
to deploy the static build to S3 and invalidate the distribution cache.
