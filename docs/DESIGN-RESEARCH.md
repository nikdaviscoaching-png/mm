# Storefront design research

Reviewed October 21, 2026. These are established specialist examples, not a claimed sales or quality ranking. The final design uses Mineral Murals' own supplied logo, photographs and copy; no dealer imagery or page design was copied.

| Primary source | What it demonstrates | Mineral Murals implementation |
| --- | --- | --- |
| [Hard Agates](https://hardagates.com/) | Available stock and a clearly marked museum collection serve different purposes. The dealer invites close inspection through more photographs and video. | Separate Shop and Museum navigation, explicit not-for-sale museum labels, an image inspection viewer, and brief collection notes. |
| [Gaia Agates](https://gaiaagates.com/) | Individual specimen galleries and structured search emphasize names, localities, availability and prices. | Searchable inventory, locality filters, price sorting, explicit sold/hold states, and a photograph-first specimen page. |
| [Agates.nl](https://www.agates.nl/) | Country and named locality are a primary way collectors browse agates. | Shop by origin appears when real published inventory exists in those sections. No locality is inferred from an unlabelled photograph. |

## The resulting design

The palette follows the supplied logo: navy `#013462`, blue `#0467a8`, powder blue `#cadffe`, with dark blue museum display mats. The real logo retains its black background. Large photographs lead the page, supported by restrained collection labels and readable serif headings.

The homepage presents the collection and the lapidary work without a long personal history. The shop shows only published inventory; recovered archive records do not become available stock automatically. Museum photographs are collection entries, not products with invented prices or provenance. The museum remains part of Mineral Murals, with optional, visibly labelled external references.

Product and museum photographs retain the full-resolution inspection viewer: pointer loupe, pinch and double-tap zoom, Fit, previous/next, keyboard controls, Escape, browser Back and restored focus. Web previews are distinct from original captures. Photography and archival source metadata are documented in the brand asset manifest.

## Checks to repeat before public launch

- At 390 px: home calls to action, museum search, gallery entry, photo viewer, Fit and close, and fixed mobile navigation.
- With actual published inventory: locality filtering, price order, sold/hold badge, purchase links, and full-size product photographs.
- With the real public media origin: all original-size museum images load and no private upload or EXIF GPS information is exposed.
- Confirm contact details, shipping terms and the availability of recovered pieces before they are offered for purchase.
