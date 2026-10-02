import Foundation
import Photos

/// Adds finished images to the user's Photos library (add-only permission — the app never reads the library to save).
enum PhotosSaver {
    enum PhotosError: LocalizedError {
        case notAllowed, failed(String)
        var errorDescription: String? {
            switch self {
            case .notAllowed: return "Saving to Photos is not allowed. Enable \"Add Photos Only\" for SPECIMEN CAMERA in Settings › Privacy › Photos."
            case .failed(let s): return "Could not save to Photos: \(s)"
            }
        }
    }

    static func requestAddAccess() async -> Bool {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        return status == .authorized || status == .limited
    }

    @discardableResult
    static func save(fileURL: URL, creationDate: Date? = nil) async throws -> String? {
        guard await requestAddAccess() else { throw PhotosError.notAllowed }
        let box = IdentifierBox()
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.shouldMoveFile = false            // copy: our file stays until the caller decides
                request.addResource(with: .photo, fileURL: fileURL, options: options)
                if let d = creationDate { request.creationDate = d }
                box.id = request.placeholderForCreatedAsset?.localIdentifier
            }
        } catch { throw PhotosError.failed(error.localizedDescription) }
        return box.id
    }

    private final class IdentifierBox: @unchecked Sendable { var id: String? }
}
