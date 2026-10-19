# Measured results

All numbers are from the ground-truth harness in `tests/` (synthetic scenes with known truth, ported from the Specimen Camera project, 512×384 frames, 8 per scene, fixed seeds). PSNR is against the true image; higher is better. "v1.1.1" is the frozen uploaded engine (`tests/baseline/`). Re-run with `node tests/bench/baseline.js site`.

| Scenario | v1.1.1 | 1.2.0 | Oracle |
|---|---|---|---|
| Lighting (glare, reflections, shadows) | 27.9 dB | **34.7 dB** | – |
| Focus stack, default method | 29.5 dB (best old mode 30.4) | **30.5 dB** | 30.85 dB |
| Both at once | 23.5 dB | **25.4 dB** | 28.1 dB |

Design finding: one weight map per frame (computed on the finest band and carried down the pyramid) is as good as per-band weights on pure focus and only 0.5 dB worse on the hardest combined scene, so weights are computed once at working resolution and reused for tiled preview and full-resolution export.

## Speed (Node, 2048×1536, 8 frames, one thread)
| Stage | v1.1.1 | 1.2.0 |
|---|---|---|
| Focus weights | 24 s | 38 s |
| Both weights | 25 s | 46 s |
| Lighting preview render | – | 14.7 s |

The new focus maps cost 1.6–1.8× more than v1.1.1 for the quality gain above.

## Browser (headless Chromium, production headers, OPFS)
| Run | Stack ready | Save | Output | Renderer peak RSS |
|---|---|---|---|---|
| 12 MP × 8 | 93 s | 65 s | 3980×2980, 1.7 MB | 603 MB |
| 24 MP × 5 | 59 s | 96 s | 5970×3972, 2.9 MB | 545 MB |

(Desktop-class CPU in a container; phones will be slower. Test images are synthetic and compress unusually well; real photos produce larger JPEGs.) Saved JPEGs were cross-checked by decoding with libjpeg (Pillow).

## Known limitation
Alignment has a residual error of about 0.2 px mean (max ≈0.4 px) on the jittered synthetic series. Experiments with smoother alignment features and with chaining neighbour-to-neighbour alignment under a mutual-sharpness mask did not improve it (0.18 → 0.20–0.39 px), so v1.1.1's direct phase-correlation + ECC alignment is kept.
