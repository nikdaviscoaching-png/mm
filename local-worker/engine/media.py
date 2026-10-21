"""Local video-to-drafts primitives for a stationary camera and empty intervals.

Apple AVFoundation decodes video, Vision reads a selected scale display, and
SpeechAnalyzer uses only installed on-device language assets. There are no model
downloads and no cloud fallback. All material identity and pricing stay outside
this image-processing module.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from collections import Counter
from decimal import Decimal, InvalidOperation
from typing import Any, Callable

import numpy as np
from PIL import Image, ImageFilter

NATIVE_DIR = Path(__file__).resolve().parent / "native"
_BUILD_LOCK = threading.Lock()
_SPEECH_READINESS: dict | None = None
_UNITS = {"g": "g", "kg": "kg", "oz": "oz", "lb": "lb", "lbs": "lb", "ounce": "oz", "ounces": "oz", "gram": "g", "grams": "g"}
_WEIGHT_RE = re.compile(r"(?<![\d.])(\d{1,6}(?:[.,]\d{1,3})?)\s*(kg|g|oz|lbs?|ounces?|grams?)\b", re.I)


class MediaError(RuntimeError):
    pass


def capabilities() -> dict:
    """Readiness without compiling, permission dialogs, or model downloads."""
    mac = sys.platform == "darwin"
    compiler = bool(shutil.which("swiftc")) if mac else False
    compiled = (NATIVE_DIR / "mm-media").is_file()
    global _SPEECH_READINESS
    if compiled and _SPEECH_READINESS is None:
        try:
            result = subprocess.run([str(NATIVE_DIR / "mm-media"), "speech-status"], capture_output=True, text=True, timeout=4)
            data = json.loads(result.stdout)
            _SPEECH_READINESS = data if data.get("ok") else {"status": "unknown"}
        except (OSError, subprocess.TimeoutExpired, ValueError):
            _SPEECH_READINESS = {"status": "unknown"}
    return {"installed": mac and (compiled or compiler), "native": compiled,
            "platform": sys.platform, "compiler_available": compiler,
            "video": "ready" if compiled else "compile_on_first_use" if compiler else "unavailable",
            "ocr": "Apple Vision" if mac else "unavailable",
            "transcription": "Apple SpeechAnalyzer, installed on-device models; macOS 26+" if mac else "unavailable",
            "speech": _SPEECH_READINESS or {"status": "not_checked" if mac else "unavailable"},
            "cloud": False, "model_downloads": False,
            "message": "Video, scale OCR, and speech run locally. SpeechAnalyzer uses already-installed language assets; manual narration remains available if assets are missing."}


def ensure_native() -> Path:
    """Compile the small checked-in helper on macOS; install nothing."""
    if sys.platform != "darwin":
        raise MediaError("Video processing requires this Mac's AVFoundation helper.")
    swift = shutil.which("swiftc")
    if not swift:
        raise MediaError("Apple's Swift compiler is unavailable. Install the Apple command-line tools to enable local video processing.")
    source = NATIVE_DIR / "MediaBridge.swift"
    plist = NATIVE_DIR / "Info.plist"
    fingerprint = hashlib.sha256(source.read_bytes() + plist.read_bytes()).hexdigest()
    binary = NATIVE_DIR / "mm-media"
    stamp = NATIVE_DIR / ".build-hash"
    with _BUILD_LOCK:
        if binary.is_file() and stamp.exists() and stamp.read_text() == fingerprint:
            return binary
        temporary = NATIVE_DIR / f"mm-media-{os.getpid()}.tmp"
        command = [swift, "-O", str(source), "-o", str(temporary), "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", str(plist)]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=180)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise MediaError(f"Cannot build the local media helper: {error}") from error
        if result.returncode:
            temporary.unlink(missing_ok=True)
            raise MediaError(f"Cannot build the local media helper: {result.stderr[-2500:]}")
        temporary.replace(binary)
        stamp.write_text(fingerprint)
    return binary


def native(command: str, *, timeout: float = 240, **arguments: Any) -> dict:
    binary = ensure_native()
    argv = [str(binary), command] + [f"--{key}={value}" for key, value in arguments.items() if value is not None]
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise MediaError(f"Local {command} timed out. Your original recording is preserved.") from error
    except OSError as error:
        raise MediaError(f"Cannot run local {command}: {error}") from error
    try:
        payload = json.loads(result.stdout.strip())
    except (ValueError, TypeError) as error:
        status = f"signal {-result.returncode}" if result.returncode < 0 else f"exit {result.returncode}"
        raise MediaError(f"Local {command} did not return a readable result ({status}; {result.stderr[-500:]}).") from error
    if result.returncode or not payload.get("ok"):
        raise MediaError(payload.get("error", f"Local {command} failed."))
    return payload


def ensure_speech_app() -> Path:
    """Give Apple Speech a real signed bundle and an honest privacy usage string.

    CLI children inherit the parent's TCC identity, whose plist may not declare
    speech use. LaunchServices starts this small app under its own identity.
    Signing is local/ad-hoc; no developer account or internet access is needed.
    """
    binary = ensure_native()
    bundle = NATIVE_DIR / "Mineral Murals Local Speech.app"
    fingerprint = hashlib.sha256(binary.read_bytes() + (NATIVE_DIR / "Info.plist").read_bytes()).hexdigest()
    stamp = NATIVE_DIR / ".speech-build-hash"
    with _BUILD_LOCK:
        if bundle.is_dir() and stamp.exists() and stamp.read_text() == fingerprint:
            return bundle
        executable = bundle / "Contents" / "MacOS" / "mm-media"
        executable.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(binary, executable)
        shutil.copy2(NATIVE_DIR / "Info.plist", bundle / "Contents" / "Info.plist")
        result = subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", "com.mineralmurals.local-media", str(bundle)], capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise MediaError(f"Cannot sign the local speech app: {result.stderr[-1000:]}")
        stamp.write_text(fingerprint)
    return bundle


def _speech_app(path: str | Path, *, locale: str, hints: list[str], request_authorization: bool) -> dict:
    bundle = ensure_speech_app()
    with tempfile.TemporaryDirectory(prefix="mineral-murals-speech-") as temporary:
        result_file = Path(temporary) / "result.json"
        arguments = ["/usr/bin/open", "-W", "-n", "-a", str(bundle), "--args", "transcribe",
                     f"--input={Path(path).resolve()}", f"--locale={locale}", f"--hints={'|'.join(hints)}",
                     f"--authorize={1 if request_authorization else 0}", f"--result-file={result_file}"]
        try:
            process = subprocess.run(arguments, capture_output=True, text=True, timeout=290)
        except subprocess.TimeoutExpired as error:
            raise MediaError("Local speech or its macOS consent dialog timed out. Your recording is preserved.") from error
        if not result_file.exists():
            raise MediaError(f"The local speech app could not produce a result (exit {process.returncode}; {process.stderr[-500:]}). Check macOS Speech Recognition permission for Mineral Murals Local Speech.")
        result = json.loads(result_file.read_text())
        if not result.get("ok"):
            raise MediaError(result.get("error", "Local speech failed."))
        return result


def transcribe(path: str | Path, *, locale: str = "en-US", hints: list[str] | None = None,
               request_authorization: bool = False) -> dict:
    """Timestamped SpeechAnalyzer transcription using installed local assets.

    The modern on-device API needs no SFSpeechRecognizer consent. The optional
    legacy fallback requests consent only when explicitly enabled. Neither path
    uses a cloud API or downloads a language model. Failures return a status.
    """
    try:
        result = native("speech-analyze", input=Path(path).resolve(), locale=locale, timeout=260)
        # Explicit legacy fallback is only for macOS versions lacking the newer
        # on-device-only API. Never switch to cloud or download language assets.
        if result.get("status") == "unavailable" and request_authorization:
            result = _speech_app(path, locale=locale, hints=hints or [], request_authorization=True)
        result.pop("ok", None)
        result["cues"] = _validated_cues(result.get("cues", []), float("inf"))
        result["text"] = stitch_cues(result["cues"]) if result["cues"] else result.get("text", "")
        result.setdefault("engine", "Apple SpeechAnalyzer (on-device, installed assets)")
        result["cloud"] = False
        result["model_downloads"] = False
        result["inference_cost"] = 0
        return result
    except Exception as error:
        return {"status": "unavailable", "text": "", "cues": [], "message": str(error),
                "engine": "Apple Speech (on-device only)", "cloud": False,
                "model_downloads": False, "inference_cost": 0}


def convert_image(input: str | Path, output: str | Path) -> dict:
    """Create a full-resolution derivative; never overwrite the source.

    Use .png or .tiff for a lossless browser/master derivative. Camera RAW
    compatibility is provided by the installed macOS decoder, not thumbnails.
    RAW previews preserve the camera's as-shot white balance and baseline
    exposure, then render full-resolution 8-bit sRGB with an embedded ICC. No
    additional exposure, contrast, sharpening or tone boost is applied. The
    unchanged RAW original retains its sensor bit depth and archival metadata.
    """
    source, destination = Path(input).resolve(), Path(output).resolve()
    if not source.is_file() or source == destination:
        raise MediaError("A readable original and a separate preview path are required.")
    if destination.suffix.lower() not in {".jpg", ".jpeg", ".png", ".tif", ".tiff"}:
        raise MediaError("Use PNG, TIFF, or JPEG for the full-resolution preview.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.stem + ".pending" + destination.suffix)
    profile_path = temporary.with_suffix(".icc")
    try:
        result = native("convert-image", input=source, output=temporary, **{"icc-output": profile_path}, timeout=90)
        # ImageIO may replace an embedded standard sRGB ICC with an sRGB PNG
        # chunk. Keep the original ICC bytes too when Pillow can read them,
        # without a color conversion or any resampling/recompression loss.
        if destination.suffix.lower() == ".png" and result.get("bit_depth", 8) <= 8:
            profile = None
            try:
                with Image.open(source) as original:
                    profile = original.info.get("icc_profile")
            except (OSError, ValueError):
                pass
            if result.get("raw") or not profile:
                profile = profile_path.read_bytes() if profile_path.is_file() else profile
            if profile:
                with Image.open(temporary) as decoded:
                    if decoded.info.get("icc_profile") != profile:
                        decoded.load()
                        decoded.save(temporary, "PNG", icc_profile=profile)
                    result["icc_preserved"] = True
                    result["icc_bytes"] = len(profile)
        temporary.replace(destination)
        result.update(path=str(destination), original=str(source), lossless=destination.suffix.lower() in {".png", ".tif", ".tiff"})
        return result
    finally:
        temporary.unlink(missing_ok=True)
        profile_path.unlink(missing_ok=True)


def _number(value: Any, default: float, low: float, high: float) -> float:
    try:
        parsed = float(value)
        return min(high, max(low, parsed)) if math.isfinite(parsed) else default
    except (ValueError, TypeError):
        return default


def _roi(value: Any) -> tuple[float, float, float, float] | None:
    """Normalized x/y/width/height, measured from the upper-left image corner."""
    if isinstance(value, dict):
        value = [value.get("x"), value.get("y"), value.get("width"), value.get("height")]
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x, y, width, height = map(float, value)
        if not all(math.isfinite(n) for n in (x, y, width, height)) or x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1.001 or y + height > 1.001:
            return None
        return x, y, min(width, 1 - x), min(height, 1 - y)
    except (ValueError, TypeError):
        return None


def _small(path: str | Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB").resize((160, 120)).filter(ImageFilter.GaussianBlur(1)), dtype=np.float32) / 255


def _difference(frame: np.ndarray, background: np.ndarray, roi=None) -> tuple[float, float, np.ndarray]:
    delta = frame - background
    # Remove a uniform exposure change, retaining local specimen changes.
    delta -= np.median(delta.reshape(-1, 3), axis=0)
    difference = np.mean(np.abs(delta), axis=2)
    if roi:
        x, y, width, height = roi
        difference[int(y * 120):int((y + height) * 120), int(x * 160):int((x + width) * 160)] = 0
    return float(np.mean(difference)), float(np.mean(difference > 0.10)), difference


def detect_segments(samples: list[dict], duration: float, *, interval: float = 0.5,
                    threshold: float = 0.035, min_empty: float = 1.0,
                    min_specimen: float = 1.0) -> list[dict]:
    """Debounce empty intervals. Brief hands/movement cannot split a specimen."""
    # Remove brief foreground obstructions before closing short empty gaps. A
    # passing hand after a specimen leaves must not prolong that specimen.
    active = [sample["score"] >= threshold for sample in samples]
    index = 0
    while index < len(active):
        if not active[index]:
            index += 1
            continue
        first = index
        while index < len(active) and active[index]:
            index += 1
        end_time = float(samples[index]["time"]) if index < len(samples) else duration
        if end_time - float(samples[first]["time"]) < min_specimen:
            active[first:index] = [False] * (index - first)
    raw = []
    start = None
    empty_since = None
    for sample, occupied in zip(samples, active):
        time = float(sample["time"])
        if occupied:
            if start is None:
                start = time
            empty_since = None
        elif start is not None:
            if empty_since is None:
                empty_since = time
            if time + interval - empty_since >= min_empty:
                if empty_since - start >= min_specimen:
                    raw.append({"start": start, "end": min(duration, empty_since), "closed": True})
                start = None
                empty_since = None
    if start is not None:
        end = empty_since if empty_since is not None else duration
        if end - start >= min_specimen:
            raw.append({"start": start, "end": min(duration, end), "closed": empty_since is not None})
    return raw


def stable_scale_reading(readings: list[dict], minimum: int = 3) -> dict | None:
    """Require a unit, OCR confidence, and repeated agreeing sampled readings."""
    parsed = []
    for reading in readings:
        if float(reading.get("confidence", 0)) < 0.70:
            continue
        text = str(reading.get("text", ""))
        matches = list(_WEIGHT_RE.finditer(text))
        if len(matches) != 1 or re.search(r"[-−]\s*\d", text):
            continue
        match = matches[0]
        try:
            amount = Decimal(match.group(1).replace(",", "."))
        except InvalidOperation:
            continue
        if amount <= 0:
            continue
        parsed.append((str(amount.normalize()), _UNITS[match.group(2).lower()], reading))
    if not parsed:
        return None
    counts = Counter((value, unit) for value, unit, _ in parsed)
    (value, unit), count = counts.most_common(1)[0]
    if count < minimum or count / len(readings) < 0.7:
        return None
    matching = [reading for amount, symbol, reading in parsed if (amount, symbol) == (value, unit)]
    times = sorted(float(reading.get("time", 0)) for reading in matching)
    if times[-1] - times[0] < 0.75:
        return None
    return {"value": float(Decimal(value)), "unit": unit, "source": "scale_ocr",
            "status": "stable_ocr_review", "verified": False,
            "confidence": round(min(float(item["confidence"]) for item in matching), 3),
            "samples": count, "start": times[0], "end": times[-1],
            "raw_readings": [str(item["text"]) for item in matching]}


def _quality(path: str | Path, previous: np.ndarray | None = None) -> tuple[float, np.ndarray]:
    with Image.open(path) as image:
        grey = np.asarray(image.convert("L").resize((320, 240)), dtype=np.float32) / 255
    laplace = -4 * grey[1:-1, 1:-1] + grey[:-2, 1:-1] + grey[2:, 1:-1] + grey[1:-1, :-2] + grey[1:-1, 2:]
    sharpness = float(np.var(laplace))
    clipping = float(np.mean((grey > 0.97) | (grey < 0.02)))
    motion = 0 if previous is None else float(np.mean(np.abs(grey - previous)))
    return sharpness * 100 - clipping * 0.4 - motion * 0.25, grey


def _select_frames(samples: list[dict], start: float, end: float, limit: int) -> list[dict]:
    margin = min(0.5, (end - start) * 0.15)
    candidates = [sample.copy() for sample in samples if start + margin <= sample["time"] <= end - margin]
    if not candidates:
        candidates = [sample.copy() for sample in samples if start <= sample["time"] < end]
    previous = None
    for sample in candidates:
        sample["quality"], previous = _quality(sample["path"], previous)
    selected = []
    # Spread frames through the display interval; avoid near-identical timestamps.
    for sample in sorted(candidates, key=lambda item: item["quality"], reverse=True):
        if all(abs(sample["time"] - chosen["time"]) >= max(0.7, (end - start) / (limit + 1)) for chosen in selected):
            selected.append(sample)
        if len(selected) >= limit:
            break
    return selected


def _save_photos(full_frames: list[dict], folder: Path, background: np.ndarray, roi) -> tuple[list[str], list[str], list[dict]]:
    photos, originals, details = [], [], []
    for index, sample in enumerate(full_frames):
        original = folder / f"original-{index + 1}{Path(sample['path']).suffix}"
        shutil.move(sample["path"], original)
        originals.append(str(original))
        _, _, difference = _difference(_small(original), background, roi)
        ys, xs = np.where(difference > 0.10)
        destination = folder / f"photo-{index + 1}.png"
        crop = None
        with Image.open(original) as image:
            profile = image.info.get("icc_profile")
            image = image.convert("RGB")
            # Refuse aggressive crops when a changed region touches an image edge.
            if len(xs) >= 60 and min(xs) > 3 and max(xs) < 156 and min(ys) > 3 and max(ys) < 116:
                left, right, top, bottom = min(xs) / 160, (max(xs) + 1) / 160, min(ys) / 120, (max(ys) + 1) / 120
                margin_x, margin_y = max(0.045, (right - left) * 0.14), max(0.045, (bottom - top) * 0.14)
                crop = [max(0, left - margin_x), max(0, top - margin_y), min(1, right + margin_x), min(1, bottom + margin_y)]
                image = image.crop(tuple(round(value * (image.width if i % 2 == 0 else image.height)) for i, value in enumerate(crop)))
            image.save(destination, "PNG", **({"icc_profile": profile} if profile else {}))
        photos.append(str(destination))
        details.append({"photo": str(destination), "original": str(original), "time": sample["time"], "crop": crop,
                        "format": "PNG", "lossless_extraction": True, "color_adjustments": False})
    return photos, originals, details


def _batch_scale_ocr(groups: list[list[dict]], folder: Path, roi) -> dict[int, tuple[dict | None, list[dict]]]:
    """Amortize Vision initialization across a video, bounded to 200 ROIs/batch."""
    if not roi:
        return {}
    files = []
    plan = []
    readings_by_group = {index: [] for index in range(len(groups))}
    for group_index, samples in enumerate(groups):
        interior = samples[1:-1] if len(samples) > 3 else samples
        indices = np.linspace(0, len(interior) - 1, min(9, len(interior)), dtype=int) if interior else []
        for index, sample_index in enumerate(indices):
            sample = interior[sample_index]
            file = folder / f"scale-{group_index:04d}-{index:02d}.jpg"
            with Image.open(sample["path"]) as image:
                x, y, width, height = roi
                region = image.crop((round(x * image.width), round(y * image.height), max(round(x * image.width) + 1, round((x + width) * image.width)), max(round(y * image.height) + 1, round((y + height) * image.height))))
                region = region.resize((max(region.width, 600), max(1, round(region.height * max(1, 600 / region.width)))))
                region.save(file, "JPEG", quality=98)
            files.append(file)
            plan.append((group_index, sample["time"], str(file)))
    try:
        results = {}
        for offset in range(0, len(files), 200):
            paths = [str(file) for file in files[offset:offset + 200]]
            try:
                batch = native("ocr-batch", inputs=json.dumps(paths), timeout=180)
                results.update({item["input"]: item for item in batch.get("results", [])})
            except MediaError as error:
                results.update({path: {"observations": [], "error": str(error)} for path in paths})
        for group_index, time, file in plan:
            result = results.get(file, {})
            observations = result.get("observations", [])
            reading = {"time": time, "text": " ".join(str(item["text"]) for item in observations),
                       "confidence": min((float(item["confidence"]) for item in observations), default=0)}
            if result.get("error"):
                reading["error"] = result["error"]
            readings_by_group[group_index].append(reading)
        return {index: (stable_scale_reading(readings), readings) for index, readings in readings_by_group.items()}
    finally:
        for file in files:
            file.unlink(missing_ok=True)


def _validated_cues(cues: Any, duration: float) -> list[dict]:
    if not isinstance(cues, list):
        return []
    result = []
    for cue in cues:
        if not isinstance(cue, dict) or not str(cue.get("text", "")).strip():
            continue
        try:
            start, end = float(cue["start"]), float(cue["end"])
        except (ValueError, TypeError, KeyError):
            continue
        if math.isfinite(start) and math.isfinite(end) and 0 <= start < min(end, duration) and end <= duration + 1:
            item = {"start": start, "end": min(duration, end), "text": str(cue["text"]).strip()}
            if isinstance(cue.get("confidence"), (int, float)):
                item["confidence"] = max(0, min(1, float(cue["confidence"])))
            result.append(item)
    return sorted(result, key=lambda cue: cue["start"])


def stitch_cues(cues: list[dict]) -> str:
    """Join word timing runs without corrupting currencies, IDs or decimals."""
    pieces = []
    previous = None
    for cue in cues:
        text = str(cue.get("text", "")).strip()
        if not text:
            continue
        if previous and float(cue["start"]) - float(previous["end"]) > 1.1 and pieces:
            if not re.search(r"[.!?;:]$", pieces[-1]):
                pieces[-1] += "."
        pieces.append(text)
        previous = cue
    value = " ".join(pieces)
    value = re.sub(r"\s+([,.;:!?])", r"\1", value)
    value = re.sub(r"([$£€])\s+(?=\d)", r"\1", value)
    value = re.sub(r"(?<=\d)\s*\.\s*(?=\d)", ".", value)
    value = re.sub(r"\b([Nn]o)\.\s*(?=\d)", r"\1. ", value)
    return value.strip()


def cues_for_interval(cues: list[dict], start: float, end: float) -> list[dict]:
    """A word belongs to one display interval, using its timed midpoint."""
    return [cue for cue in cues if start <= (float(cue["start"]) + float(cue["end"])) / 2 < end]


def regenerate_clip(processing: dict | str | Path, start: float, end: float,
                    output_dir: str | Path | None = None) -> dict:
    """Export corrected boundaries from the preserved original, atomically."""
    if isinstance(processing, dict):
        source = Path(processing.get("original_video") or processing.get("source") or "")
    else:
        source = Path(processing)
    source = source.resolve()
    try:
        start, end = float(start), float(end)
    except (TypeError, ValueError) as error:
        raise MediaError("Use valid start and end timestamps.") from error
    if not source.is_file() or not all(math.isfinite(v) for v in (start, end)):
        raise MediaError("A preserved recording and valid timestamps are required.")
    duration = float(native("probe", input=source)["duration"])
    if not 0 <= start < end <= duration + 0.02:
        raise MediaError("Keep the interval inside the preserved recording.")
    folder = Path(output_dir).resolve() if output_dir else source.parent
    folder.mkdir(parents=True, exist_ok=True)
    failures = []
    for extension in ("mp4", "mov"):
        destination = folder / f"specimen-{round(start * 1000)}-{round(end * 1000)}.{extension}"
        with tempfile.TemporaryDirectory(prefix=".clip-", dir=folder) as temporary:
            pending = Path(temporary) / ("clip." + extension)
            try:
                native("clip", input=source, output=pending, start=start, end=min(end, duration))
                pending.replace(destination)
                return {"clip": str(destination), "start": start, "end": min(end, duration),
                        "original_video": str(source), "status": "complete"}
            except MediaError as error:
                failures.append(str(error))
    raise MediaError("Clip export was unavailable. The corrected interval remains playable from the original. " + failures[-1])


def process_segment(path: str | Path, start: float, end: float, output_dir: str | Path,
                    settings: dict | None = None, progress_callback=None) -> dict:
    """Rebuild photos, clip and timed narration for an explicit edited interval.

    Returned keys match a process_video segment. The original is already owned
    by the batch and is reused rather than copied for each manual adjustment.
    """
    options = {**(settings or {}), "manual_intervals": [{"start": start, "end": end}],
               "preserve_source": False}
    result = process_video(path, output_dir, options, progress_callback)
    if not result["segments"]:
        raise MediaError("The edited interval could not produce a specimen draft.")
    return {**result["segments"][0], "transcription": result["transcript"],
            "analysis": result["analysis"], "processing_warnings": result["warnings"]}


def process_video(path: str | Path, output_dir: str | Path, settings: dict | None = None,
                  progress_callback: Callable[[int, str], None] | None = None) -> dict:
    """Preserve source, detect intervals, extract photos/clips, OCR and narration.

    settings: sample_interval, difference_threshold, min_empty_seconds,
    min_specimen_seconds, empty_reference_time, scale_roi (normalized xywh),
    photos_per_segment, export_clips, transcript_cues, speech_locale,
    vocabulary, request_speech_authorization. All detections require review.
    """
    settings = settings or {}
    output = Path(output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = Path(path).resolve()
    if not source.is_file():
        raise MediaError("The original video could not be found.")
    if source.suffix.lower() not in {".mp4", ".mov", ".m4v"}:
        raise MediaError("Use an MP4 or MOV recording.")
    notify = progress_callback or (lambda percent, message: None)
    notify(3, "Reading the original recording")
    metadata = native("probe", input=source)
    duration = float(metadata["duration"])
    if duration > 3600:
        raise MediaError("For this lightweight worker, split recordings longer than one hour before importing.")
    preserved = output / ("original-video" + source.suffix.lower()) if settings.get("preserve_source", True) else source
    if source != preserved:
        shutil.copy2(source, preserved)
    interval = _number(settings.get("sample_interval"), 0.5, 0.2, 5)
    interval = max(interval, duration / 4000)
    threshold = _number(settings.get("difference_threshold"), 0.035, 0.005, 0.6)
    min_empty = _number(settings.get("min_empty_seconds"), 1, 0.4, 15)
    min_specimen = _number(settings.get("min_specimen_seconds"), 1, 0.4, 30)
    photo_limit = int(_number(settings.get("photos_per_segment"), 3, 1, 6))
    roi = _roi(settings.get("scale_roi"))
    warnings = []
    if settings.get("scale_roi") and not roi:
        warnings.append("The scale region is invalid. Weight OCR was skipped; choose a normalized x/y/width/height region.")
    if settings.get("empty_reference_time") is None:
        warnings.append("The first second was used as the empty workspace reference. Confirm the rock and hands were fully out of frame.")
    reference_time = _number(settings.get("empty_reference_time"), 0, 0, max(0, duration - 0.1))
    scratch = output / ".sampled-frames"
    scratch.mkdir(exist_ok=True)
    try:
        notify(8, "Sampling frames locally on this Mac")
        extracted = native("sample", input=source, output=scratch, interval=interval, dimension=800, timeout=max(240, duration * 2))
        samples = extracted["frames"]
        if not samples:
            raise MediaError("No frames could be read from this recording.")
        reference_folder = scratch / "reference"
        reference_times = [reference_time] if settings.get("empty_reference_time") is not None else [min(t, max(0, duration - 0.02)) for t in (0, 0.35, 0.7)]
        reference = native("sample", input=source, output=reference_folder, times=",".join(map(str, reference_times)), dimension=800)
        backgrounds = [_small(frame["path"]) for frame in reference["frames"]]
        background = np.median(np.stack(backgrounds), axis=0)
        if any(_difference(frame, background, roi)[0] > threshold * 0.65 for frame in backgrounds):
            warnings.append("The opening workspace moved or was not consistently empty. Set an empty reference time and check segment boundaries.")
        for sample in samples:
            sample["score"], sample["changed_fraction"], _ = _difference(_small(sample["path"]), background, roi)
        notify(28, "Detecting specimens and empty intervals")
        manual = settings.get("manual_intervals")
        if manual is not None:
            if not isinstance(manual, list) or not 1 <= len(manual) <= 250:
                raise MediaError("Supply at least one valid manual interval.")
            intervals = []
            for segment in manual:
                try:
                    start, end = float(segment["start"]), float(segment["end"])
                except (TypeError, ValueError, KeyError) as error:
                    raise MediaError("Manual interval timestamps are invalid.") from error
                if not all(math.isfinite(n) for n in (start, end)) or not 0 <= start < end <= duration + 0.02 or end - start < 0.2:
                    raise MediaError("Keep each manual interval within the recording and at least 0.2 seconds long.")
                intervals.append({"start": start, "end": min(end, duration), "closed": False, "manual": True})
        else:
            intervals = detect_segments(samples, duration, interval=interval, threshold=threshold, min_empty=min_empty, min_specimen=min_specimen)
        supplied = _validated_cues(settings.get("transcript_cues"), duration)
        if supplied:
            transcript = {"status": "provided", "text": stitch_cues(supplied), "cues": supplied, "engine": "User-supplied timestamped narration", "cloud": False, "inference_cost": 0}
        else:
            notify(33, "Checking on-device narration transcription")
            transcript = transcribe(source, locale=str(settings.get("speech_locale", "en-US")), hints=settings.get("vocabulary", []), request_authorization=bool(settings.get("request_speech_authorization")))
        if transcript["status"] not in {"complete", "provided"}:
            warnings.append(transcript.get("message", "Narration transcription is unavailable; enter or upload timestamped narration for review."))
        if not roi:
            warnings.append("No scale-display region is configured. Weight was not inferred.")
        if not intervals:
            warnings.append("No sustained specimen intervals were detected. Verify the empty reference and threshold; the original is preserved.")
        scale_groups = [[sample for sample in samples if segment["start"] <= sample["time"] < segment["end"]] for segment in intervals]
        if roi and intervals:
            notify(36, "Reading scale displays locally; first use may take a minute")
        scale_results = _batch_scale_ocr(scale_groups, scratch, roi)
        result_segments = []
        for index, segment in enumerate(intervals):
            notify(38 + round(55 * index / max(1, len(intervals))), f"Preparing specimen {index + 1} of {len(intervals)}")
            folder = output / f"segment-{index + 1:03d}"
            folder.mkdir(exist_ok=True)
            start, end = segment["start"], segment["end"]
            segment_samples = [sample for sample in samples if start <= sample["time"] < end]
            chosen = _select_frames(samples, start, end, photo_limit)
            chosen_times = [item["time"] for item in chosen] or [(start + end) / 2]
            full = native("sample", input=source, output=folder / ".full", times=",".join(map(str, chosen_times)), dimension=0, format="png")
            photos, originals, photo_details = _save_photos(full["frames"], folder, background, roi)
            shutil.rmtree(folder / ".full", ignore_errors=True)
            segment_warnings = ["Review specimen boundaries, image framing, and narration before approving this draft."]
            boundary_observed = start > 0 and segment["closed"]
            average_score = float(np.mean([sample["score"] for sample in segment_samples])) if segment_samples else 0
            confidence = min(0.91, 0.55 + min(0.23, max(0, average_score - threshold) * 3) + (0.12 if boundary_observed else 0))
            if any(sample["changed_fraction"] > 0.7 for sample in segment_samples):
                confidence = min(confidence, 0.48)
                segment_warnings.append("Most of the frame changed. Camera movement, hands, or an incorrect empty reference may affect detection.")
            if segment.get("manual"):
                segment_warnings.append("This is a manually edited interval. Photos, clip and narration were regenerated for these timestamps.")
            elif not boundary_observed:
                segment_warnings.append("A complete empty interval was not observed on both sides of this segment.")
            weight, readings = scale_results.get(index, (None, []))
            if roi:
                segment_warnings.append("Confirm the stable OCR weight before using it." if weight else "No stable, clear scale reading with a displayed unit was found. Enter weight manually.")
            cues = cues_for_interval(transcript.get("cues", []), start, end)
            crossing = [cue for cue in cues if float(cue["start"]) < start or float(cue["end"]) > end]
            if crossing:
                segment_warnings.append("A narration cue crosses a specimen boundary. Check its assignment.")
            segment_text = stitch_cues(cues)
            if any(float(cue.get("confidence", 1)) < 0.65 for cue in cues):
                segment_warnings.append("Some narration words have low speech confidence. Verify specimen number, material and asking price.")
            spoken_ids = set(re.findall(r"\b(?:number|specimen|no\.?)\s*#?\s*(\d{1,6})\b", segment_text, re.I))
            if len(spoken_ids) > 1:
                segment_warnings.append("Narration mentions multiple specimen numbers. This interval may need to be split.")
                confidence = min(confidence, 0.45)
            clip = None
            if settings.get("export_clips", True):
                for extension in ("mp4", "mov"):
                    destination = folder / f"specimen.{extension}"
                    destination.unlink(missing_ok=True)
                    try:
                        native("clip", input=source, output=destination, start=start, end=end)
                        clip = str(destination)
                        break
                    except MediaError:
                        destination.unlink(missing_ok=True)
                if clip is None:
                    segment_warnings.append("Short-clip export was unavailable. Replay this interval in the preserved original.")
            result_segments.append({"id": index + 1, "start": round(start, 3), "end": round(end, 3),
                                    "confidence": round(confidence, 3), "warnings": segment_warnings,
                                    "photos": photos, "original_photos": originals, "photo_details": photo_details,
                                    "clip": clip, "original_video": str(preserved), "transcript": segment_text,
                                    "source_interval": {"start": round(start, 3), "end": round(end, 3)},
                                    "transcription_engine": transcript.get("engine"),
                                    "transcript_cues": cues, "weight": weight, "scale_readings": readings})
        result = {"segments": result_segments, "duration": duration, "original_video": str(preserved),
                  "transcript": transcript, "warnings": warnings, "requires_review": True,
                  "analysis": {"method": "sampled-background-difference", "confidence_note": "Heuristic review priority, not a calibrated probability of correct specimen identification.", "sample_interval": interval, "difference_threshold": threshold,
                               "empty_reference_time": reference_time, "min_empty_seconds": min_empty,
                               "min_specimen_seconds": min_specimen, "scale_roi": list(roi) if roi else None,
                               "series": [{"time": round(sample["time"], 3), "score": round(sample["score"], 4)} for sample in samples]}}
        (output / "processing.json").write_text(json.dumps(result, indent=2))
        notify(100, f"Ready to review {len(result_segments)} specimen drafts")
        return result
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
