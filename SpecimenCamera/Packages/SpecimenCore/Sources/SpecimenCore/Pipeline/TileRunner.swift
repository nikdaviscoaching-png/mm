import Foundation

/// Runs tile jobs on a bounded number of worker threads. Concurrency is the knob thermal management turns
/// (fewer workers, same quality). Errors and cancellation stop further tiles; in-flight tiles finish.
public enum TileRunner {
    /// `concurrencyProvider` is asked before every tile, so thermal throttling takes effect immediately: workers above the
    /// allowed count wait (0 = everything waits until the phone cools). Without it `concurrency` is fixed.
    public static func run(tiles: [Tile], concurrency: Int, concurrencyProvider: (@Sendable () -> Int)? = nil,
                           isCancelled: CancelCheck? = nil,
                           onTileDone: (@Sendable (Int, Int) -> Void)? = nil,
                           work: @Sendable (Tile) throws -> Void) throws {
        let state = RunState(total: tiles.count)
        let maxWorkers = concurrencyProvider == nil ? concurrency : max(concurrency, min(ProcessInfo.processInfo.activeProcessorCount - 1, 4))
        let workers = max(1, min(maxWorkers, tiles.count))
        withoutActuallyEscaping(work) { work in
            DispatchQueue.concurrentPerform(iterations: workers) { worker in
                while true {
                    if isCancelled?() == true { state.fail(SpecimenError.cancelled); return }
                    if let provider = concurrencyProvider {
                        var allowed = provider()
                        while worker >= allowed {
                            if state.finished { return }
                            if isCancelled?() == true { state.fail(SpecimenError.cancelled); return }
                            Thread.sleep(forTimeInterval: allowed <= 0 ? 1.0 : 0.25)
                            allowed = provider()
                        }
                    }
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
    var finished: Bool { lock.lock(); defer { lock.unlock() }; return error != nil || cursor >= total }
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
