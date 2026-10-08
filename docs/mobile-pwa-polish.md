# Mobile PWA polish

## Audit and changes

The site previously had no web app manifest or apple-touch-icon. Header links, including the nested donation page and dynamic account links, already use same-origin relative URLs and same-window navigation. Keep those links and genuine external links as authored. A shared manifest now sets an explicit root scope/start URL and standalone display. This addresses missing app boundaries; the reported iOS overlay symptom still needs confirmation on a device.

All nine app pages share the manifest, club artwork icons, and the short installation title **SNH Pinball**. The 180px iOS and 192/512px manifest PNGs come from `assets/images/SNHPC_logo_color.png`, centered on a square neutral background. The manifest icons retain the original 80% source scale; the iPhone artwork now uses 94% (17.5% larger), preserving the original artwork’s internal margins and the opaque 180×180 RGB PNG format. Icons use `purpose: any`; they are not advertised as maskable.

The footer logo links to a focusable header anchor on the current page. Native anchor/history behavior is retained, including the hash history entry and browser Back scroll restoration. There is no global scroll reset, click interception, smooth-scroll override, service worker, caching, or push feature.

Viewport safe-area coverage and body inset padding protect controls in portrait and landscape. The default iOS status bar avoids requesting translucent content underneath it. Existing appearance/account controls already had 44px minimum heights; header navigation now has 44px minimum width and height too.

Theme-color previously read a CSS `light-dark()` expression and used legacy palette values. It now supplies concrete colors matching the clubhouse palette, including before stylesheets load, explicit Light/Dark selections, and system appearance changes. Status-bar rendering remains controlled by the iOS version.

## Manual iPhone checks required

These cannot be verified by a desktop preview or Node tests. After deployment to an HTTPS origin:

1. In Safari, add the site to the Home Screen. Check the club logo and `SNH Pinball` suggested display name. Launch and confirm standalone mode. Also install from `/events.html` and `/donate/` to verify the same identity and root navigation scope.
2. Check every main navigation link, including Members/My Account when signed in, and navigation to/from `/donate/`. They should stay in the installed app. Verify Match Play, IFPA, Discord, Maps, and archive links retain their external behavior.
3. Check portrait and landscape on a notched iPhone. Ensure header links, appearance/account controls and footer clear the notch and home indicator. Check Light, Dark and System appearance, including a system appearance change while open; check status-bar legibility.
4. Scroll to a footer and activate its logo. Confirm the current page returns to its header. With VoiceOver or a keyboard, confirm its accessible name and focus movement. Test with Reduce Motion enabled.
5. Scroll down a long page, follow an internal link, then use the available Back gesture/control. Confirm the prior scroll position restores. Also test Back after the footer anchor, reload, and app background/resume. Async page content can affect browser restoration and must be checked on device.
6. Existing installations may retain old icons, names or inferred scope. Compare a fresh installation first; remove and re-add the shortcut if needed. Do not promise an automatic update of an existing iOS shortcut.

## References

- [Apple: configuring web applications](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html)
- [Apple: what's new in web apps, including navigation scope](https://developer.apple.com/videos/play/wwdc2023/10120/)

## Finishing changes

Home and About both offer understated, side-by-side Apple Maps and Google Maps links with a small location icon, visible vendor names, accessible directions labels and tooltips. Both retain the existing destination, 48 Bridge St, Unit 3A, Nashua, NH. Origin and travel mode are omitted so the map provider can offer the appropriate route choices.

- [Apple Map Links](https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/MapLinks/MapLinks.html): `daddr` directions destination.
- [Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started): `/maps/dir/?api=1&destination=…`.

After deployment, check both providers on iPhone and desktop, including the destination and available route choices. To validate the larger iPhone icon, remove the existing Home Screen shortcut, reload the deployed site in Safari and add it again. If stale artwork persists, clear this site’s Safari website data and retry (this may sign you out).
