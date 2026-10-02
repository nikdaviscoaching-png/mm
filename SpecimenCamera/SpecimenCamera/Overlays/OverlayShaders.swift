import Foundation

/// Metal Shading Language source, compiled at runtime (`MTLDevice.makeLibrary(source:)`). Compiling at runtime keeps the build
/// free of .metal files and lets the app fall back to the CPU overlay if a device rejects the shader.
///
/// Focus peaking is drawn as **hairlines**, in three steps that mirror `SpecimenCore.FocusPeaking` / `PeakingRenderer`
/// (the unit-tested reference; `tools/msl-shim` compiles and runs this very text against it):
///  * `peakCandidates` — Sobel edge strength, non-maximum suppression along the gradient (one-pixel ridges) and a steepness test
///    (slope over ±1 px ÷ slope over ±2 px, measured along the gradient with hardware bilinear taps). Writes
///    (flag, edge direction) per pixel. When magnified, only the visible part of the frame is analysed.
///  * `peakFinish` — keeps ridge pixels that have a ridge neighbour (noise is speckle, edges are lines) and draws zebras.
///  * `fsMain` — presents the result at SCREEN resolution: every ridge pixel becomes a short segment along its edge, about
///    1.2 screen pixels wide at any magnification, so 4×/8× shows fine contours instead of blocks. For the magnifier it also
///    draws the live video through a region-of-interest transform.
///
/// `struct Params` must match `SpecimenCore.PeakingGPUParams` field for field (96 bytes).
enum OverlayShaders {
    static let source = """
    #include <metal_stdlib>
    using namespace metal;

    struct Params {
        float threshold;           // minimum edge strength (0...255 luma units), from the CPU's noise-adaptive estimate
        float minSteepness;        // 1 = any edge ... 2 = only perfectly crisp steps
        float zebraThreshold;
        float peakingOn;
        float zebraOn;
        float stripePhase;
        float showVideo;
        float pad0;
        float4 peakColor;
        float2 roiOrigin;          // visible region, normalised image coordinates
        float2 roiSize;
        float viewScale;           // screen pixels per buffer pixel
        float lineHalfWidth;       // hairline half width, screen pixels
        float segHalfLength;       // segment half length, buffer pixels
        float pad1;
        uint2 cOrigin;             // compute region (buffer pixels)
        uint2 cSize;
    };

    constant float3 kLuma = float3(0.2110, 0.7148, 0.0742);

    static inline float lumaAt(texture2d<float, access::read> t, int2 p, int2 size) {
        p = clamp(p, int2(0), size - int2(1));
        float3 c = t.read(uint2(p)).rgb;
        return dot(c, kLuma) * 255.0;
    }

    // Luma at a continuous position (pixel k covers [k, k+1)) with hardware bilinear filtering.
    static inline float lumaLinear(texture2d<float, access::sample> t, float2 pos) {
        constexpr sampler s(coord::pixel, filter::linear, address::clamp_to_edge);
        float3 c = t.sample(s, pos).rgb;
        return dot(c, kLuma) * 255.0;
    }

    // Sobel gradient divided by 4: a crisp step of contrast C scores C.
    static inline float2 sobel(texture2d<float, access::read> t, int2 p, int2 size) {
        float a = lumaAt(t, p + int2(-1, -1), size), b = lumaAt(t, p + int2(0, -1), size), c = lumaAt(t, p + int2(1, -1), size);
        float d = lumaAt(t, p + int2(-1, 0), size), f = lumaAt(t, p + int2(1, 0), size);
        float g = lumaAt(t, p + int2(-1, 1), size), h = lumaAt(t, p + int2(0, 1), size), i = lumaAt(t, p + int2(1, 1), size);
        float gx = ((c + 2.0 * f + i) - (a + 2.0 * d + g)) * 0.25;
        float gy = ((g + 2.0 * h + i) - (a + 2.0 * b + c)) * 0.25;
        return float2(gx, gy);
    }

    kernel void peakCandidates(texture2d<float, access::read> src [[texture(0)]],
                               texture2d<float, access::write> cand [[texture(1)]],
                               texture2d<float, access::sample> srcLinear [[texture(2)]],
                               constant Params &P [[buffer(0)]],
                               uint2 gid [[thread_position_in_grid]]) {
        int2 size = int2(src.get_width(), src.get_height());
        if (gid.x >= P.cSize.x || gid.y >= P.cSize.y) { return; }
        uint2 gp = gid + P.cOrigin;
        if (int(gp.x) >= size.x || int(gp.y) >= size.y) { return; }
        float2 result = float2(0.0, 0.0);
        if (P.peakingOn > 0.5) {
            int2 p = int2(gp);
            float2 g = sobel(src, p, size);
            float G = length(g);
            if (G >= P.threshold) {
                // non-maximum suppression along the gradient direction (four quantised axes)
                float ax = fabs(g.x), ay = fabs(g.y);
                int2 n;
                if (ay <= 0.4142 * ax) { n = int2(g.x >= 0.0 ? 1 : -1, 0); }
                else if (ax <= 0.4142 * ay) { n = int2(0, g.y >= 0.0 ? 1 : -1); }
                else { n = int2(g.x >= 0.0 ? 1 : -1, g.y >= 0.0 ? 1 : -1); }
                float gPlus = length(sobel(src, p + n, size));
                float gMinus = length(sobel(src, p - n, size));
                if (G > gMinus && G >= gPlus) {
                    // steepness along the gradient: slope over +-1 px divided by slope over +-2 px
                    float2 nrm = g / G;
                    float2 c = float2(p) + float2(0.5, 0.5);
                    float d1 = lumaLinear(srcLinear, c + nrm) - lumaLinear(srcLinear, c - nrm);
                    float d2 = lumaLinear(srcLinear, c + 2.0 * nrm) - lumaLinear(srcLinear, c - 2.0 * nrm);
                    if (2.0 * fabs(d1) >= P.minSteepness * fabs(d2)) {
                        float theta = atan2(g.y, g.x) + 1.5707963;                 // tangent = gradient rotated by 90 degrees
                        theta = theta - 3.14159265 * floor(theta / 3.14159265);    // into [0, pi)
                        result = float2(1.0, theta / 3.14159265);
                    }
                }
            }
        }
        cand.write(float4(result.x, result.y, 0.0, 0.0), gp);
    }

    kernel void peakFinish(texture2d<float, access::read> src [[texture(0)]],
                           texture2d<float, access::read> cand [[texture(1)]],
                           texture2d<float, access::write> ridge [[texture(2)]],
                           texture2d<float, access::write> outTex [[texture(3)]],
                           constant Params &P [[buffer(0)]],
                           uint2 gid [[thread_position_in_grid]]) {
        int2 size = int2(src.get_width(), src.get_height());
        if (gid.x >= P.cSize.x || gid.y >= P.cSize.y) { return; }
        uint2 gp = gid + P.cOrigin;
        if (int(gp.x) >= size.x || int(gp.y) >= size.y) { return; }
        int2 p = int2(gp);
        float2 kept = float2(0.0, 0.0);
        if (P.peakingOn > 0.5) {
            float2 c = cand.read(gp).rg;
            if (c.x > 0.5) {
                int n = 0;
                for (int dy = -1; dy <= 1; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        if (dx == 0 && dy == 0) { continue; }
                        int2 q = p + int2(dx, dy);
                        if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) { continue; }
                        if (cand.read(uint2(q)).r > 0.5) { n++; }
                    }
                }
                if (n >= 1) { kept = c; }
            }
        }
        ridge.write(float4(kept.x, kept.y, 0.0, 0.0), gp);
        float4 color = float4(0.0, 0.0, 0.0, 0.0);
        if (P.zebraOn > 0.5) {
            float3 c = src.read(gp).rgb;
            if (max(c.r, max(c.g, c.b)) >= P.zebraThreshold) {
                int band = (p.x + p.y + int(P.stripePhase)) / 5;
                color = (band % 2 == 0) ? float4(0.9, 0.9, 0.9, 0.9) : float4(0.0, 0.0, 0.0, 0.9);
            }
        }
        outTex.write(color, gp);
    }

    struct VOut { float4 position [[position]]; float2 uv; };

    vertex VOut vsMain(uint vid [[vertex_id]]) {
        float2 pos[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
        VOut o;
        o.position = float4(pos[vid], 0.0, 1.0);
        o.uv = float2((pos[vid].x + 1.0) * 0.5, 1.0 - (pos[vid].y + 1.0) * 0.5);
        return o;
    }

    fragment float4 fsMain(VOut in [[stage_in]],
                           texture2d<float> overlay [[texture(0)]],
                           texture2d<float> video [[texture(1)]],
                           texture2d<float> ridge [[texture(2)]],
                           constant Params &P [[buffer(0)]]) {
        constexpr sampler s(filter::linear, address::clamp_to_edge);
        constexpr sampler sn(filter::nearest, address::clamp_to_edge);
        float2 uv = P.roiOrigin + in.uv * P.roiSize;
        float4 o = overlay.sample(s, uv);
        if (P.peakingOn > 0.5) {
            float2 texSize = float2(ridge.get_width(), ridge.get_height());
            float2 tp = uv * texSize;                    // position in buffer pixels (pixel k covers [k, k+1))
            float2 cell = floor(tp);
            float cover = 0.0;
            for (int dy = -1; dy <= 1; dy++) {
                for (int dx = -1; dx <= 1; dx++) {
                    float2 cc = cell + float2(float(dx), float(dy));
                    if (cc.x < 0.0 || cc.y < 0.0 || cc.x >= texSize.x || cc.y >= texSize.y) { continue; }
                    float2 r = ridge.sample(sn, (cc + float2(0.5, 0.5)) / texSize).rg;
                    if (r.x > 0.5) {
                        float a = r.y * 3.14159265;
                        float2 dir = float2(cos(a), sin(a));
                        float2 d = tp - (cc + float2(0.5, 0.5));
                        float t = clamp(dot(d, dir), -P.segHalfLength, P.segHalfLength);
                        float dist = length(d - dir * t) * P.viewScale;      // distance to the segment in screen pixels
                        cover = max(cover, 1.0 - smoothstep(P.lineHalfWidth - 0.5, P.lineHalfWidth + 0.5, dist));
                    }
                }
            }
            cover = cover * P.peakColor.a;
            o = o * (1.0 - cover) + float4(P.peakColor.rgb * cover, cover);
        }
        if (P.showVideo > 0.5) {
            float3 v = video.sample(s, uv).rgb;
            return float4(o.rgb + v * (1.0 - o.a), 1.0);
        }
        return o;
    }
    """
}
