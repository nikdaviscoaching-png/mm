# Supplied logo and collection photographs

These assets come from the user’s `Half .zip`, provided October 21, 2026. No stock photography, AI-generated specimen images, invented location, mineral identification, ownership history or availability claim was added. The original ZIP and extracted files were left unchanged.

The logo is the actual supplied blue-and-white MM mark. Its black background is retained, and its PNG has exactly the same decoded RGB pixels as the supplied JPEG. It has not been redrawn or given a different color palette. Approximate colors measured from its blue bands are `#013462`, `#0467a8`, `#81c2f9` and pale `#cadffe`; these are supporting site colors, not a repaint of the photographs.

## Display assets

Website paths begin `/assets/brand/`. All photos retain their native aspect ratio, honor EXIF orientation, and carry their supplied ICC color profile. The display WebPs use quality 92 and conservative resizing. No exposure, saturation, contrast, sharpening or other styling filter was applied. Display variants are not archival originals.

| Display asset | Supplied file | Source dimensions | Display dimensions | Bytes |
| --- | --- | --- | --- | ---: |
| `mineral-murals-logo.png` | `C0FAEB0D-7344-4A02-9C98-2BFD39E93672.JPG` | 603 × 622 | 603 × 622 | 512,358 |
| `collection-case.webp` | `DSC08983.jpg` | 5737 × 3227 | 1920 × 1080 | 686,054 |
| `agate-detail.webp` | `IMG_0506.JPG` | 4799 × 6000 | 1440 × 1800 | 839,472 |
| `museum-paired-halves.webp` | `DSC09844.jpg` | 3498 × 3498 | 1600 × 1600 | 324,878 |
| `museum-display-specimen.webp` | `DSC08638.jpg` | 1482 × 1482 | 1482 × 1482 | 431,928 |
| `museum-banded-geode.webp` | `DSC09370.jpg` | 1519 × 1215 | 1519 × 1215 | 410,324 |
| `museum-golden-bands.webp` | `IMG_9650.JPG` | 2200 × 2200 | 1600 × 1600 | 650,680 |

Total bundled display assets: **3,855,694 bytes**. The full-size logo PNG is 603 × 622.

## Full-resolution gallery zoom

Full-resolution JPEGs are staged separately in the task’s `work/brand-full-resolution-assets/` for object storage. They should be served through `/brand/{filename}` after upload. The display source must remain the fallback until the full-resolution URL is actually reachable; do not advertise a missing object.

The six JPEGs retain the source JPEG image codestream, ICC profile and Adobe color transform markers. Only EXIF, XMP, Photoshop metadata and comments were removed. Every selected source was already correctly oriented (orientation 1 or absent). Pixel-by-pixel comparison of decoded source and prepared JPEGs confirmed identical RGB pixels. There is no additional JPEG recompression in these full-resolution files. EXIF/GPS metadata is absent in these public copies. The original user files retain all original metadata privately.

| Full-resolution object | Dimensions | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `collection-case-full.jpg` | 5737 × 3227 | 5,664,814 | `9bfbc655e839eb0d232b0c6e29ee0cd8e27ac7eb4c6a96cfe0af3856468f825a` |
| `agate-detail-full.jpg` | 4799 × 6000 | 14,396,509 | `724cbca25f343b499fb96ae319d369f612af78d3815e7eea05bb1cc98cea423e` |
| `museum-paired-halves-full.jpg` | 3498 × 3498 | 2,557,842 | `43e0d4a1cc6ba0a37ce70ec80d5f8fca5c703463c41448de48cd2b872ea9e12f` |
| `museum-display-specimen-full.jpg` | 1482 × 1482 | 737,542 | `d18bef8186927367c6e5c570126c56902ad86094804e6457a60317341053346c` |
| `museum-banded-geode-full.jpg` | 1519 × 1215 | 685,132 | `d86bcd4697813072941a4515d2106940be1665ebd744d441e7485ccd77e8fb8b` |
| `museum-golden-bands-full.jpg` | 2200 × 2200 | 2,164,990 | `31decbfd6b49bd7f11aacc899d7136c54fff54f673fd5be2ecbc4f147e0b3a20` |

Total full-resolution object storage: **26,206,829 bytes**. These photos belong in object storage, outside the Worker JavaScript bundle.

## Museum selection

The initial four photographs are collection/reference images, with no purchase controls or invented specimen facts:

- `museum-paired-halves`: paired polished halves, showing cream and tan bands.
- `museum-display-specimen`: a banded slice photographed on a clear stand.
- `museum-banded-geode`: nested bands around an open center.
- `museum-golden-bands`: a polished face with a golden exterior and contrasting bands.

Use neutral titles and visual captions. Locality, exact material identification, dimensions, treatment and specimen history need the owner’s confirmation before being presented as facts. The collection-case and agate-detail images support the home page and editorial collection sections; they do not become sale listings merely because they appear there.

## Original source audit

SHA-256 values identify the unchanged supplied source files:

- `C0FAEB0D-7344-4A02-9C98-2BFD39E93672.JPG` → `8f097bb2c4271b5f24d3ce32b7cd47791a0dfb881007ceaabe4ed58ec99b6b82`
- `DSC08983.jpg` → `2f84ca61f2f0574277abc13ee3d5c891bd63d48787083a2715f5a43d67781486`
- `IMG_0506.JPG` → `54ef850cc270dfbbba4bf4ef910ced36155aa53cf0dde64f89d7391008b64d43`
- `DSC09844.jpg` → `ec7775fdac287e51ae50f856185a51e42f58963c78ac8617181806f108c15cdd`
- `DSC08638.jpg` → `7519979d51a36901247a373424db6a3bf56ecc3d7dfc3808c937a4ee7537c9c6`
- `DSC09370.jpg` → `337fbcde2e94999759c07291993232d3cd3eed7daa5148cccddaf994ef7ca39d`
- `IMG_9650.JPG` → `6d7ab82b96f7955c281cffe5ef3ccbfa2d6ccc847ebf7ed66660f3da06035fd8`

Three supplied HEIC files were also converted locally with the existing native full-resolution ImageIO pathway for inspection only. `IMG_0769.HEIC` shows a collection display, `IMG_2818.HEIC` shows paired hand-held halves, and `IMG_2902.HEIC` shows a hand-held banded face in sunlight. These inspection previews are not bundled website assets. No decoder was downloaded or installed.
