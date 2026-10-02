// Runs the app's overlay shaders (extracted verbatim from OverlayShaders.swift) on the CPU.
// usage: run <dir>   reads frame.bin, params.txt   writes gpu_cand.bin, gpu_ridge.bin, gpu_view.bin
#include "metal_shim.h"
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#pragma clang diagnostic ignored "-Wunknown-attributes"
#include "shader.inc"

static_assert(sizeof(Params) == 96, "Params must be 96 bytes");
static_assert(offsetof(Params, peakColor) == 32 && offsetof(Params, roiOrigin) == 48 && offsetof(Params, roiSize) == 56, "layout");
static_assert(offsetof(Params, viewScale) == 64 && offsetof(Params, segHalfLength) == 72 && offsetof(Params, cOrigin) == 80 && offsetof(Params, cSize) == 88, "layout");

int main(int argc, char **argv) {
    std::string dir = argc > 1 ? argv[1] : ".";
    FILE *f = fopen((dir + "/frame.bin").c_str(), "rb");
    if (!f) { fprintf(stderr, "no frame.bin\n"); return 1; }
    int32_t W, H; fread(&W, 4, 1, f); fread(&H, 4, 1, f);
    std::vector<uint8_t> bgra((size_t)W * H * 4); fread(bgra.data(), 1, bgra.size(), f); fclose(f);
    texture2d<float, access::read> src(W, H);
    for (int i = 0; i < W * H; i++) (*src.data)[i] = float4{bgra[i * 4 + 2] / 255.0f, bgra[i * 4 + 1] / 255.0f, bgra[i * 4] / 255.0f, bgra[i * 4 + 3] / 255.0f};

    Params P;
    std::memset(&P, 0, sizeof(P));
    std::ifstream pf(dir + "/params.txt");
    float threshold, steep, cx, cy, cw, ch, vx, vy, vw, vh, viewScale, lineHalfWidth, segHalf, alpha; int outW, outH;
    pf >> threshold >> steep >> cx >> cy >> cw >> ch >> vx >> vy >> vw >> vh >> outW >> outH >> viewScale >> lineHalfWidth >> segHalf >> alpha;
    P.threshold = threshold; P.minSteepness = steep; P.peakingOn = 1; P.zebraOn = 0; P.showVideo = 0;
    P.peakColor = float4{1, 0.05f, 0.05f, alpha};
    P.cOrigin = uint2{(uint)cx, (uint)cy}; P.cSize = uint2{(uint)cw, (uint)ch};
    P.roiOrigin = float2{vx / W, vy / H}; P.roiSize = float2{vw / W, vh / H};
    P.viewScale = viewScale; P.lineHalfWidth = lineHalfWidth; P.segHalfLength = segHalf;

    texture2d<float, access::write> cand(W, H), ridge(W, H), overlay(W, H);
    texture2d<float, access::sample> srcLinear(src);
    texture2d<float, access::read> candR(cand), candRead(cand);
    for (uint y = 0; y < P.cSize.y; y++) for (uint x = 0; x < P.cSize.x; x++) peakCandidates(src, cand, srcLinear, P, uint2{x, y});
    texture2d<float, access::read> candForFinish(cand);
    for (uint y = 0; y < P.cSize.y; y++) for (uint x = 0; x < P.cSize.x; x++) peakFinish(src, candForFinish, ridge, overlay, P, uint2{x, y});

    auto dump = [&](const char *name, texture2d<float, access::write> &t) {
        std::vector<uint8_t> out((size_t)W * H * 2);
        for (int i = 0; i < W * H; i++) { float4 v = (*t.data)[i]; out[i * 2] = v.x > 0.5f ? 255 : 0; out[i * 2 + 1] = (uint8_t)std::nearbyint(v.y * 255.0f); }
        FILE *o = fopen((dir + "/" + name).c_str(), "wb"); fwrite(out.data(), 1, out.size(), o); fclose(o);
    };
    dump("gpu_cand.bin", cand); dump("gpu_ridge.bin", ridge);

    texture2d<float> ridgeS(ridge), overlayS(overlay), videoS(src);
    std::vector<float> view((size_t)outW * outH);
    for (int oy = 0; oy < outH; oy++) for (int ox = 0; ox < outW; ox++) {
        VOut v; v.uv = float2{(ox + 0.5f) / outW, (oy + 0.5f) / outH};
        float4 c = fsMain(v, overlayS, videoS, ridgeS, P);
        view[(size_t)oy * outW + ox] = c.w / alpha;                 // coverage
    }
    FILE *o = fopen((dir + "/gpu_view.bin").c_str(), "wb"); fwrite(view.data(), 4, view.size(), o); fclose(o);
    printf("ran %dx%d, view %dx%d\n", W, H, outW, outH);
    return 0;
}
