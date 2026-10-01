import Foundation

/// Metal Shading Language source, compiled at runtime (`MTLDevice.makeLibrary(source:)`). Compiling at runtime keeps the build
/// free of .metal files and lets the app fall back to the CPU overlay if a device rejects the shader.
///
/// `peakMask` implements exactly `SpecimenCore.FocusPeaking`: the step-1 modified Laplacian of luma, a noise-adaptive
/// threshold (computed on the CPU from a sparse sample and passed in), and a 2-of-8 neighbour-support rule. `composeOverlay`
/// thickens the mask by one pixel, colours it and adds zebra stripes. `vsMain`/`fsMain` present the overlay (and, for the
/// magnifier, the live video) through a region-of-interest transform.
enum OverlayShaders {
    static let source = """
    #include <metal_stdlib>
    using namespace metal;

    struct Params {
        float threshold;
        float supportFraction;
        float zebraThreshold;
        float peakingOn;
        float zebraOn;
        float stripePhase;
        float showVideo;
        float pad0;
        float4 peakColor;
        float2 roiOrigin;
        float2 roiSize;
    };

    static inline float lumaAt(texture2d<float, access::read> t, int2 p, int2 size) {
        p = clamp(p, int2(0), size - int2(1));
        float3 c = t.read(uint2(p)).rgb;
        return dot(c, float3(0.2110, 0.7148, 0.0742)) * 255.0;
    }

    static inline float responseAt(texture2d<float, access::read> t, int2 p, int2 size) {
        float c = 2.0 * lumaAt(t, p, size);
        float h = fabs(c - lumaAt(t, p + int2(-1, 0), size) - lumaAt(t, p + int2(1, 0), size));
        float v = fabs(c - lumaAt(t, p + int2(0, -1), size) - lumaAt(t, p + int2(0, 1), size));
        return h + v;
    }

    kernel void peakMask(texture2d<float, access::read> src [[texture(0)]],
                         texture2d<float, access::write> mask [[texture(1)]],
                         constant Params &P [[buffer(0)]],
                         uint2 gid [[thread_position_in_grid]]) {
        int2 size = int2(src.get_width(), src.get_height());
        if (int(gid.x) >= size.x || int(gid.y) >= size.y) { return; }
        float m = 0.0;
        if (P.peakingOn > 0.5) {
            int2 p = int2(gid);
            if (responseAt(src, p, size) >= P.threshold) {
                int n = 0;
                for (int dy = -1; dy <= 1; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        if (dx == 0 && dy == 0) { continue; }
                        if (responseAt(src, p + int2(dx, dy), size) >= P.threshold * P.supportFraction) { n++; }
                    }
                }
                if (n >= 2) { m = 1.0; }
            }
        }
        mask.write(float4(m, 0.0, 0.0, 0.0), gid);
    }

    kernel void composeOverlay(texture2d<float, access::read> src [[texture(0)]],
                               texture2d<float, access::read> mask [[texture(1)]],
                               texture2d<float, access::write> outTex [[texture(2)]],
                               constant Params &P [[buffer(0)]],
                               uint2 gid [[thread_position_in_grid]]) {
        int2 size = int2(src.get_width(), src.get_height());
        if (int(gid.x) >= size.x || int(gid.y) >= size.y) { return; }
        int2 p = int2(gid);
        float4 color = float4(0.0);
        if (P.peakingOn > 0.5) {
            float on = 0.0;
            for (int dy = -1; dy <= 1; dy++) {
                for (int dx = -1; dx <= 1; dx++) {
                    int2 q = clamp(p + int2(dx, dy), int2(0), size - int2(1));
                    on = max(on, mask.read(uint2(q)).r);
                }
            }
            if (on > 0.5) { color = float4(P.peakColor.rgb * P.peakColor.a, P.peakColor.a); }
        }
        if (P.zebraOn > 0.5) {
            float3 c = src.read(gid).rgb;
            if (max(c.r, max(c.g, c.b)) >= P.zebraThreshold) {
                int band = (p.x + p.y + int(P.stripePhase)) / 5;
                color = (band % 2 == 0) ? float4(0.9, 0.9, 0.9, 0.9) : float4(0.0, 0.0, 0.0, 0.9);
            }
        }
        outTex.write(color, gid);
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
                           constant Params &P [[buffer(0)]]) {
        constexpr sampler s(filter::linear, address::clamp_to_edge);
        float2 uv = P.roiOrigin + in.uv * P.roiSize;
        float4 o = overlay.sample(s, uv);
        if (P.showVideo > 0.5) {
            float3 v = video.sample(s, uv).rgb;
            return float4(o.rgb + v * (1.0 - o.a), 1.0);
        }
        return o;
    }
    """
}
