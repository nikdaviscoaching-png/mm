// Minimal CPU emulation of the parts of Metal Shading Language that the app's overlay shaders use, so the EXACT shader text can
// be compiled by clang++ and executed on the CPU (there is no Metal compiler on Linux). It checks syntax, types and the
// algorithm; it cannot check Metal API usage (pipelines, bindings), which stays device-verified.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <type_traits>
#include <vector>

typedef unsigned int uint;
typedef float float2 __attribute__((ext_vector_type(2)));
typedef float float3 __attribute__((ext_vector_type(3)));
typedef float float4 __attribute__((ext_vector_type(4)));
typedef int int2 __attribute__((ext_vector_type(2)));
typedef unsigned int uint2 __attribute__((ext_vector_type(2)));

// Constructors: MSL writes float2(1, 2). A function-like macro only expands when followed by '(', so the type names keep
// working as types everywhere else.
static inline float2 make_float2(float x, float y) { return float2{x, y}; }
static inline float2 make_float2(float x) { return float2{x, x}; }
static inline float2 make_float2(int2 v) { return float2{(float)v.x, (float)v.y}; }
static inline float2 make_float2(uint2 v) { return float2{(float)v.x, (float)v.y}; }
static inline float3 make_float3(float x, float y, float z) { return float3{x, y, z}; }
static inline float4 make_float4(float x, float y, float z, float w) { return float4{x, y, z, w}; }
static inline float4 make_float4(float2 a, float z, float w) { return float4{a.x, a.y, z, w}; }
static inline float4 make_float4(float3 a, float w) { return float4{a.x, a.y, a.z, w}; }
static inline int2 make_int2(int x, int y) { return int2{x, y}; }
static inline int2 make_int2(int x) { return int2{x, x}; }
static inline int2 make_int2(uint2 v) { return int2{(int)v.x, (int)v.y}; }
static inline uint2 make_uint2(int2 v) { return uint2{(uint)v.x, (uint)v.y}; }
static inline uint2 make_uint2(uint x, uint y) { return uint2{x, y}; }
#define float2(...) make_float2(__VA_ARGS__)
#define float3(...) make_float3(__VA_ARGS__)
#define float4(...) make_float4(__VA_ARGS__)
#define int2(...) make_int2(__VA_ARGS__)
#define uint2(...) make_uint2(__VA_ARGS__)

// MSL treats 2.0 as float; C++ makes it double. Mixed-type max/min must still resolve.
template <typename A, typename B> static inline typename std::common_type<A, B>::type max(A a, B b) { return a > b ? a : b; }
template <typename A, typename B> static inline typename std::common_type<A, B>::type min(A a, B b) { return a < b ? a : b; }

template <typename V> static inline V clamp(V x, V lo, V hi) { return __builtin_elementwise_min(__builtin_elementwise_max(x, lo), hi); }
static inline float dot(float3 a, float3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static inline float dot(float2 a, float2 b) { return a.x * b.x + a.y * b.y; }
static inline float length(float2 v) { return std::sqrt(v.x * v.x + v.y * v.y); }
static inline float2 floor(float2 v) { return float2{std::floor(v.x), std::floor(v.y)}; }
static inline float smoothstep(float e0, float e1, float x) { float t = std::fmin(std::fmax((x - e0) / (e1 - e0), 0.0f), 1.0f); return t * t * (3.0f - 2.0f * t); }
using std::fabs; using std::cos; using std::sin; using std::atan2; using std::floor;

namespace access { enum { read, write, sample, read_write }; }
namespace filter { enum filter_t { nearest, linear }; }
namespace address { enum address_t { clamp_to_edge, clamp_to_zero, repeat }; }
namespace coord { enum coord_t { normalized, pixel }; }
struct sampler {
    int filt = 0, coordMode = 0;
    constexpr sampler() {}
    template <typename... Ts> constexpr sampler(Ts... ts) { (set(ts), ...); }
    constexpr void set(filter::filter_t f) { filt = f; }
    constexpr void set(coord::coord_t c) { coordMode = c; }
    constexpr void set(address::address_t) {}
};

// 8-bit unorm texture (every texture the shaders touch is 8-bit): writes are rounded exactly like the GPU's conversion.
template <typename T, int A = access::sample>
struct texture2d {
    std::shared_ptr<std::vector<float4>> data;
    uint w = 0, h = 0;
    texture2d() {}
    texture2d(uint w_, uint h_) : data(std::make_shared<std::vector<float4>>((size_t)w_ * h_, float4{0, 0, 0, 0})), w(w_), h(h_) {}
    template <int B> texture2d(const texture2d<T, B> &o) : data(o.data), w(o.w), h(o.h) {}
    uint get_width() const { return w; }
    uint get_height() const { return h; }
    float4 read(uint2 p) const { return (*data)[(size_t)p.y * w + p.x]; }
    void write(float4 v, uint2 p) const {
        float4 q;
        for (int i = 0; i < 4; i++) q[i] = std::nearbyint(std::min(std::max(v[i], 0.0f), 1.0f) * 255.0f) / 255.0f;
        (*data)[(size_t)p.y * w + p.x] = q;
    }
    float4 texel(int x, int y) const { return (*data)[(size_t)std::min(std::max(y, 0), (int)h - 1) * w + std::min(std::max(x, 0), (int)w - 1)]; }
    float4 sample(sampler s, float2 pos) const {
        float2 px = s.coordMode == coord::pixel ? pos : float2{pos.x * w, pos.y * h};
        if (s.filt == filter::nearest) return texel((int)std::floor(px.x), (int)std::floor(px.y));
        float fx = px.x - 0.5f, fy = px.y - 0.5f;
        int x0 = (int)std::floor(fx), y0 = (int)std::floor(fy);
        float tx = fx - x0, ty = fy - y0;
        return (texel(x0, y0) * (1 - tx) + texel(x0 + 1, y0) * tx) * (1 - ty) + (texel(x0, y0 + 1) * (1 - tx) + texel(x0 + 1, y0 + 1) * tx) * ty;
    }
};

#define kernel
#define vertex
#define fragment
#define constant
