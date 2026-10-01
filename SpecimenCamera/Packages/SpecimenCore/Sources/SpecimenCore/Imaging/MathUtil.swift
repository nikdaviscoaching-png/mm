import Foundation

@inline(__always)
public func smoothstep(_ a: Float, _ b: Float, _ x: Float) -> Float {
    let t = min(max((x - a) / (b - a), 0), 1)
    return t * t * (3 - 2 * t)
}

@inline(__always)
public func clamp01(_ x: Float) -> Float { min(max(x, 0), 1) }
