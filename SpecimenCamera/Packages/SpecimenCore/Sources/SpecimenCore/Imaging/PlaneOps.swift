import Foundation

public extension Plane {
    /// Element-wise square.
    func squared() -> Plane { mapped { $0 * $0 } }

    mutating func addScaled(_ o: Plane, _ s: Float) {
        precondition(o.count == count)
        pixels.withUnsafeMutableBufferPointer { d in
            o.pixels.withUnsafeBufferPointer { src in
                for i in 0..<d.count { d[i] += s * src[i] }
            }
        }
    }

    mutating func multiply(by o: Plane) {
        precondition(o.count == count)
        pixels.withUnsafeMutableBufferPointer { d in
            o.pixels.withUnsafeBufferPointer { src in
                for i in 0..<d.count { d[i] *= src[i] }
            }
        }
    }

    mutating func scale(by s: Float) {
        pixels.withUnsafeMutableBufferPointer { d in for i in 0..<d.count { d[i] *= s } }
    }

    /// Median via partial sort of a strided sample (exact when `maxSamples` ≥ count).
    func median(maxSamples: Int = 200_000) -> Float {
        guard !pixels.isEmpty else { return 0 }
        let step = max(1, pixels.count / maxSamples)
        var s: [Float] = []
        s.reserveCapacity(pixels.count / step + 1)
        var i = 0
        while i < pixels.count { s.append(pixels[i]); i += step }
        s.sort()
        return s[s.count / 2]
    }

    /// q-quantile (0…1) of a strided sample.
    func quantile(_ q: Float, maxSamples: Int = 200_000) -> Float {
        guard !pixels.isEmpty else { return 0 }
        let step = max(1, pixels.count / maxSamples)
        var s: [Float] = []
        var i = 0
        while i < pixels.count { s.append(pixels[i]); i += step }
        s.sort()
        return s[min(s.count - 1, max(0, Int(Float(s.count - 1) * q)))]
    }
}
