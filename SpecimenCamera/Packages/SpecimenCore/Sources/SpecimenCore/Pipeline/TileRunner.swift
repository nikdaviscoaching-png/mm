import Foundation

/// Runs tile jobs on a bounded number of worker threads. Concurrency is the knob thermal management turns
/// (fewer workers, same quality). Errors and cancellation stop further tiles; in-flight tiles finish.
public enum TileRunner {
    public static func run(tiles: [Tile], concurrency: Int, isCancelled: CancelCheck? = nil,
                           onTileDone: (@Sendable (Int, Int) -> Void)? = nil,
                           work: @Sendable (Tile) throws -> Void) throws {
        let state = RunState(total: tiles.count)
        let workers = max(1, min(concurrency, tiles.count))
        withoutActuallyEscaping(work) { work in
            DispatchQueue.concurrentPerform(iterations: workers) { _ in
                while true {
                    if isCancelled?() == true { state.fail(SpecimenError.cancelled); return }
                    guard let idx = state.next() else { return }
                    do {
                        try autoreleasepoolCompat { try work(tiles[idx]) }
                        let done = state.finishOne()
                        onTileDone?(done, tiles.count)
                    } catch {
                        state.fail(error); return
                    }
                }
            }
        }
        if let e = state.error { throw e }
    }
}

private final class RunState: @unchecked Sendable {
    private let lock = NSLock()
    private var cursor = 0
    private var done = 0
    private(set) var error: Error?
    private let total: Int
    init(total: Int) { self.total = total }

    func next() -> Int? {
        lock.lock(); defer { lock.unlock() }
        if error != nil || cursor >= total { return nil }
        defer { cursor += 1 }
        return cursor
    }
    func finishOne() -> Int { lock.lock(); defer { lock.unlock() }; done += 1; return done }
    func fail(_ e: Error) { lock.lock(); if error == nil { error = e }; lock.unlock() }
}

/// `autoreleasepool` where it exists (Apple platforms) so tile temporaries are released promptly.
@inline(__always)
func autoreleasepoolCompat<T>(_ body: () throws -> T) rethrows -> T {
    #if canImport(ObjectiveC)
    return try autoreleasepool(invoking: body)
    #else
    return try body()
    #endif
}
