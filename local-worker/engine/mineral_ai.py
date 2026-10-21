"""Mineral Murals' offline, conservative specimen extraction and draft generation.

No dependencies, downloads, cloud calls, or model training. Settings are ordinary
JSON and can be persisted by the hub or with save_settings(). The original
narration is retained byte-for-byte as a Python string. All prices are integer
cents; incomplete, conflicting, approximate, or colloquial prices require review.

The installed Apple on-device language model composes grounded listing copy when
available. Its guided output selects natural phrasings and evidenced appearance
notes; a separate validator checks every choice and required fact. No cloud API,
model download, or inference charge is involved. Templates remain the fallback.
"""

from __future__ import annotations

import copy
import json
import re
import tempfile
import threading
import time
import unicodedata
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


REFERENCE_SOURCES = {
    "checked": "2026-10-20",
    "etsy_listing": "https://help.etsy.com/hc/en-us/articles/115015628707-How-to-Create-a-Listing",
    "etsy_tags": "https://help.etsy.com/hc/en-us/articles/360000336307-How-to-Use-Tags-to-Get-Found-in-Search",
    "etsy_api": "https://developers.etsy.com/documentation/tutorials/listings/",
    "ebay_title": "https://developer.ebay.com/devzone/xml/docs/reference/ebay/AddItem.html",
    "ebay_offer": "https://www.developer.ebay.com/api-docs/sell/static/inventory/inventory-item-to-offer.html",
    "ollama_generate": "https://docs.ollama.com/api/generate",
    "ollama_schema": "https://docs.ollama.com/capabilities/structured-outputs",
}

DEFAULT_SETTINGS = {
    "version": 1,
    "terminology": [
        "rough Laguna agate", "Kentucky agate", "Laguna agate", "agate",
        "geode", "quartz", "amethyst", "jasper", "calcite", "fluorite",
        "petrified wood", "mineral specimen", "lapidary material",
    ],
    # Reference vocabulary is not evidence of a specimen's geographic origin.
    # Names are never expanded to an unstated state, country, mine, or locality.
    "localities": ["Estill County", "Kentucky", "Laguna", "Chihuahua", "Mexico"],
    "corrections": {},
    "categories": ["Agates", "Geodes", "Mineral Specimens", "Rough & Lapidary"],
    "style": {
        "tone": "Concise, factual, collector-oriented. No unsupported rarity or quality claims.",
        "closing": "Review the photographs and condition notes for this specimen's details.",
    },
    "condition_language": "",
    "seo_vocabulary": ["mineral specimen", "rock specimen"],
    "specimen_numbers": [],
    "shipping": {"note": "", "profile_id": ""},
    "listing_formats": {"etsy_title_limit": 140, "etsy_tag_limit": 13,
                        "etsy_tag_characters": 20, "ebay_title_limit": 80},
    # Approval is separate from configuration. No price changes by default.
    "pricing": {"enabled": False, "approved": False,
                "website_discount_percent": 6, "etsy_markup_percent": 0,
                "ebay_markup_percent": 0},
    "ollama": {"enabled": False, "base_url": "http://127.0.0.1:11434",
               "model": "", "timeout_seconds": 4},
    "native_ai": {"enabled": True},
    "include_source_notes_in_description": False,
}

_AI_STATUS: tuple[float, dict] | None = None
_AI_CACHE: dict[str, tuple[list[str], str, list[str]]] = {}
_AI_LOCK = threading.Lock()

_ONES = {word: n for n, word in enumerate((
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen"))}
_TENS = dict(zip(("twenty", "thirty", "forty", "fifty", "sixty", "seventy",
                 "eighty", "ninety"), range(20, 100, 10)))
_NUMBER_WORDS = set(_ONES) | set(_TENS) | {"hundred", "thousand", "million", "and", "point", "half", "a"}
_NUMBER_TOKEN = r"(?:\d[\d,]*(?:\.\d+)?|" + "|".join(sorted(_NUMBER_WORDS, key=len, reverse=True)) + r")"
_NUMBER_SPAN = _NUMBER_TOKEN + r"(?:[ -]+" + _NUMBER_TOKEN + r")*"
_UNCERTAIN = re.compile(r"\b(?:maybe|perhaps|possibly|probably|might|could be|about|around|approximately|roughly|or|between|unsure|uncertain|guess|think|not sure)\b", re.I)
_DEFECT = re.compile(
    r"\b(?:fractur\w*|crack\w*|chip\w*|repair\w*|treat\w*|saw[ -]?mark\w*|"
    r"scratch\w*|pit(?:s|ted|ting)?|glue\w*|epoxy|resin|dyed?|dyeing|"
    r"heat(?:ed|ing)?|stabili[sz]\w*|fill(?:ed|ing)?|coat\w*|restor\w*|"
    r"damage\w*|imperfection\w*|craz\w*|broken|break\w*|bruise\w*|"
    r"inclusion\w*|wear|fissure\w*|cleav\w*|blemish\w*|residu\w*|"
    r"polish(?:ing)? compound|surface loss|condition|intact|unbroken|"
    r"un(?:repaired|treated|dyed|heated|stabili[sz]ed|coated|damaged)|defects?)\b", re.I)
_VISUAL_FEATURE = re.compile(r"\b(?:band(?:s|ed|ing)?|plume\w*|fortification\w*|color\w*|colour\w*|red|yellow|orange|blue|green|purple|pink|white|black|grey|gray|brown|crystal\w*|druzy|drusy|translucen\w*|opaque|pattern\w*|vug\w*|botryoidal|inclusion\w*)\b", re.I)
_FINISH = re.compile(
    r"\b(?:polished(?:\s+(?:face|faces|front|back|surface|surfaces|on\s+(?:one|both)\s+sides?))?|"
    r"unpolished|rough|sawn|saw[ -]cut|cut(?:\s+and\s+polished)?|tumbled|"
    r"natural(?:\s+(?:surface|finish|exterior)))\b", re.I)


def _merge(base: dict, updates: dict) -> dict:
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = copy.deepcopy(value)
    return base


def normalized_settings(settings: dict | None = None) -> dict:
    """Return an independent settings copy; never modify the caller's settings."""
    if settings is not None and not isinstance(settings, dict):
        raise TypeError("AI settings must be a JSON object.")
    return _merge(copy.deepcopy(DEFAULT_SETTINGS), settings or {})


def load_settings(path: str | Path) -> dict:
    """Load editable reference preferences, with defaults for omitted fields."""
    target = Path(path)
    return normalized_settings(json.loads(target.read_text()) if target.exists() else {})


def save_settings(path: str | Path, settings: dict) -> dict:
    """Atomically save preferences; this saves rules, not model training."""
    data = normalized_settings(settings)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(target)
    return data


def apply_corrections(transcript: str, corrections: dict | None) -> tuple[str, list[dict]]:
    """Apply longest matching terminology corrections once, without cascading."""
    items = {str(k).casefold(): str(v) for k, v in (corrections or {}).items()
             if isinstance(k, str) and k.strip() and isinstance(v, str) and v.strip()}
    if not items:
        return transcript, []
    pattern = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(k) for k in sorted(items, key=len, reverse=True)) + r")(?!\w)", re.I)
    applied = []

    def replace(match):
        replacement = items[match.group().casefold()]
        applied.append({"heard": match.group(), "replacement": replacement})
        return replacement

    return pattern.sub(replace, transcript), applied


def _under_hundred(tokens: list[str]) -> int | None:
    if len(tokens) == 1:
        return _ONES.get(tokens[0], _TENS.get(tokens[0]))
    if len(tokens) == 2 and tokens[0] in _TENS and 0 < _ONES.get(tokens[1], 99) < 10:
        return _TENS[tokens[0]] + _ONES[tokens[1]]
    return None


def _under_thousand(tokens: list[str]) -> int | None:
    if "hundred" not in tokens:
        return _under_hundred(tokens)
    if tokens.count("hundred") != 1 or tokens.index("hundred") != 1:
        return None
    head = 1 if tokens[0] == "a" else _ONES.get(tokens[0], 0)
    if not 1 <= head <= 9:
        return None
    tail = tokens[2:]
    if tail[:1] == ["and"]:
        tail = tail[1:]
        if not tail:
            return None
    rest = _under_hundred(tail) if tail else 0
    return head * 100 + rest if rest is not None else None


def parse_number(text: str) -> Decimal | None:
    """Parse explicit English numbers, rejecting 'one eighty' and 'three twenty'."""
    value = text.strip().lower().replace("-", " ")
    # Digits may use valid thousands grouping, never a comma as a decimal mark.
    if re.fullmatch(r"(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", value):
        try:
            return Decimal(value.replace(",", ""))
        except InvalidOperation:
            return None
    tokens = value.split()
    if not tokens:
        return None
    if tokens in (["half"], ["a", "half"]):
        return Decimal("0.5")
    if tokens[-2:] == ["and", "half"] or tokens[-3:] == ["and", "a", "half"]:
        n = 3 if tokens[-3:] == ["and", "a", "half"] else 2
        whole = parse_number(" ".join(tokens[:-n]))
        return whole + Decimal("0.5") if whole is not None else None
    if "point" in tokens:
        if tokens.count("point") != 1:
            return None
        idx = tokens.index("point")
        tail = tokens[idx + 1:]
        whole = parse_number(" ".join(tokens[:idx]))
        if whole is None or not tail or any(t not in _ONES or _ONES[t] > 9 for t in tail):
            return None
        return whole + Decimal("0." + "".join(str(_ONES[t]) for t in tail))
    if any(t not in _NUMBER_WORDS for t in tokens):
        return None
    total = 0
    previous_scale = 10**9
    while "million" in tokens or "thousand" in tokens:
        indexes = [(tokens.index(word), scale) for word, scale in (("million", 10**6), ("thousand", 1000)) if word in tokens]
        idx, scale = min(indexes)
        if scale >= previous_scale:
            return None
        head = _under_thousand(tokens[:idx])
        if not head:
            return None
        total += head * scale
        previous_scale = scale
        tokens = tokens[idx + 1:]
        if tokens[:1] == ["and"]:
            tokens = tokens[1:]
    tail = _under_thousand(tokens) if tokens else 0
    return Decimal(total + tail) if tail is not None else None


def _numeric_suffix(text: str) -> tuple[str, int] | None:
    """Get the entire immediately preceding numeric phrase, not a guessed suffix."""
    matches = list(re.finditer(r"(?<!\w)" + _NUMBER_SPAN + r"\s*$", text, re.I))
    if not matches:
        return None
    match = matches[-1]
    value = match.group().strip()
    # A conjunction at the start usually belongs to the surrounding sentence.
    value = re.sub(r"^(?:and\s+)", "", value, flags=re.I)
    return value, match.start()


def _parse_price(text: str) -> tuple[int | None, list[str]]:
    candidates: list[tuple[Decimal | None, int, int]] = []
    warnings = []
    covered = []
    for match in re.finditer(r"\$\s*([\d,]+(?:\.\d+)?)", text):
        value = parse_number(match.group(1))
        if re.match(r"[\w/]|\.\d", text[match.end():]) or re.search(r"[-−]\s*$", text[:match.start()]):
            value = None
        candidates.append((value, match.start(), match.end()))
        covered.append((match.start(), match.end()))
    for match in re.finditer(r"\b(?:US\s+)?dollars?\b|\bUSD\b", text, re.I):
        prefix = _numeric_suffix(text[:match.start()])
        # '$320 dollars' refers to the same amount, not two separate mentions.
        if prefix and any(start <= prefix[1] <= end for start, end in covered):
            continue
        value = parse_number(prefix[0]) if prefix else None
        start = prefix[1] if prefix else match.start()
        end = match.end()
        cents = re.match(r"\s+(?:and\s+)?(" + _NUMBER_SPAN + r")\s+cents?\b", text[end:], re.I)
        if cents:
            cent_value = parse_number(cents.group(1))
            if value is None or cent_value is None or cent_value != int(cent_value) or not 0 <= cent_value <= 99:
                value = None
            else:
                value += cent_value / 100
            end += cents.end()
        candidates.append((value, start, end))
        covered.append((start, end))
    for match in re.finditer(r"\b(?:asking(?:\s+price)?|price(?:\s+is)?|priced\s+at|sell(?:ing)?\s+(?:it\s+)?for)\s*[:=]?\s*\$?\s*(" + _NUMBER_SPAN + r")", text, re.I):
        if any(start <= match.end() - 1 <= end for start, end in covered):
            continue
        value = parse_number(match.group(1))
        if re.match(r"[\w/]|\.\d", text[match.end():]):
            value = None
        candidates.append((value, match.start(), match.end()))
    if not candidates:
        return None, ["No explicit price found; enter and verify a price before approval."]
    ambiguous = False
    prices = set()
    for value, start, end in candidates:
        before = re.split(r"[.!?;\n]", text[:start])[-1][-32:]
        after = re.split(r"[.!;\n]", text[end:])[0][:22]
        context = before + text[start:end] + after
        # Negated or approximate prices and ranges are deliberately not resolved.
        if _UNCERTAIN.search(context) or re.search(r"\b(?:not|was|used to|rather than)\b", context, re.I):
            ambiguous = True
        if re.match(r"\s*(?:-|–|—|to)\s*\$?\s*\d", text[end:]):
            ambiguous = True
        if re.search(r"(?:\bto|[/–—-])\s*$", before):
            ambiguous = True
        if after.lstrip().startswith("?"):
            ambiguous = True
        if value is None or value <= 0 or value * 100 != (value * 100).to_integral_value():
            ambiguous = True
        else:
            prices.add(int(value * 100))
    if ambiguous or len(prices) != 1:
        warnings.append("Ambiguous or conflicting price narration; price left empty for seller review.")
        return None, warnings
    return next(iter(prices)), warnings


def _clauses(text: str) -> list[str]:
    # Do not split decimal measurements or abbreviations embedded in numbers.
    return [s.strip(" \t\r\n,;") for s in re.split(r"[,;\n]|(?<!\d)[.!?]+\s*|[.!?]+(?=\s+[A-Za-z])", text)
            if s.strip(" \t\r\n,;.!?")]


def _term_name(term: Any) -> str:
    if isinstance(term, dict):
        return str(term.get("name", ""))
    return str(term)


def _material(text: str, settings: dict) -> tuple[str, list[str]]:
    terms = sorted({_term_name(t) for t in settings.get("terminology", []) if _term_name(t)}, key=len, reverse=True)
    found = []
    for term in terms:
        match = re.search(r"(?<!\w)" + re.escape(term) + r"(?!\w)", text, re.I)
        if not match or any(term.casefold() in bigger.casefold() for bigger, _ in found):
            continue
        clause_start = max(text.rfind(".", 0, match.start()), text.rfind(",", 0, match.start()), text.rfind(";", 0, match.start())) + 1
        prefix = text[clause_start:match.start()]
        if _UNCERTAIN.search(prefix) or re.search(r"\b(?:not|isn't|is not)\s+(?:an?\s+)?$", prefix, re.I):
            return "", ["Material identification was qualified or negated; confirm it before listing."]
        found.append((term, match.start()))
    if not found:
        return "", ["Material was not recognized from the saved terminology; confirm or add the term."]
    # Multiple unrelated identities require review, not a silent first-match choice.
    if len(found) > 1:
        return "", ["Multiple material names found; review the specimen identity."]
    return found[0][0], []


def _locality(text: str, material: str, settings: dict) -> tuple[str, list[str]]:
    working = re.sub(re.escape(material), " " * len(material), text, flags=re.I) if material else text
    names = [_term_name(t) for t in settings.get("localities", []) if _term_name(t)]
    explicit = re.search(r"\b(?:from|locality(?:\s+is)?\s*:?|collected\s+(?:at|in)|origin\s*:)\s+([^.;!?\n]+)", working, re.I)
    if explicit:
        locality_prefix = re.split(r"[.,;!?\n]", working[:explicit.start()])[-1]
        if _UNCERTAIN.search(locality_prefix) or re.search(r"\b(?:not|isn't)\s*$", locality_prefix, re.I):
            return "", ["Locality narration was qualified or negated; no locality assigned."]
        raw = explicit.group(1).strip()
        raw = re.split(r"\b(?:with|weighs?|weighing|asking|priced|price|polished|rough|minor|small|has|there is|and has|and weighs)\b", raw, maxsplit=1, flags=re.I)[0].strip(" ,")
        if _UNCERTAIN.search(raw) or re.search(r"\b(?:unknown|unverified|not known|unclear)\b", raw, re.I):
            return "", ["Locality narration was uncertain; no locality assigned."]
        # Keep comma-separated geographic components only when actually dictated.
        parts = [part.strip() for part in raw.split(",")]
        selected = parts[:1]
        for part in parts[1:]:
            if any(part.casefold() == name.casefold() for name in names):
                selected.append(part)
            else:
                break
        value = ", ".join(selected).strip()
        if value:
            return value, []
    # County/locality supplied as a separate phrase is also explicit narration.
    found = []
    for clause in _clauses(working):
        candidate = clause.strip(" .")
        for name in names:
            if re.fullmatch(re.escape(name), candidate, re.I):
                found.append(candidate)
                break
    if found:
        return ", ".join(dict.fromkeys(found)), []
    return "", []  # Unknown provenance is optional and remains unstated.


def _specimen_number(text: str) -> tuple[str, list[str]]:
    found = []
    for match in re.finditer(r"(?:\b(?:specimen(?:\s+(?:number|id))?|number|no\.?|sku)\s*[:#-]?\s*|#)([A-Za-z]*-?\d+[A-Za-z]*|" + _NUMBER_SPAN + r")", text, re.I):
        value = match.group(1).strip()
        # A vocabulary word without a number must not become an inventory ID.
        if re.fullmatch(r"[A-Za-z]*-?\d+[A-Za-z]*", value):
            found.append(value)
        else:
            parsed = parse_number(value)
            if parsed is not None and parsed == int(parsed):
                found.append(str(int(parsed)))
    if not found:
        return "", []  # The hub assigns a persistent inventory identity.
    if len(set(found)) != 1:
        return "", ["Multiple specimen numbers found; check the segment boundaries."]
    return found[0], []


def _weight(text: str) -> tuple[str, list[str]]:
    units = {"ounce": "oz", "ounces": "oz", "oz": "oz", "pound": "lb", "pounds": "lb", "lb": "lb", "lbs": "lb", "gram": "g", "grams": "g", "g": "g", "kilogram": "kg", "kilograms": "kg", "kg": "kg"}
    found = []
    uncertain = False
    for match in re.finditer(r"\b(?:ounces?|oz|pounds?|lbs?|kilograms?|kg|grams?|g)\b", text, re.I):
        prefix = _numeric_suffix(text[:match.start()])
        if not prefix:
            continue
        value = parse_number(prefix[0])
        context = text[max(0, prefix[1] - 20):match.end() + 12]
        if _UNCERTAIN.search(context) or value is None or value <= 0:
            uncertain = True
            continue
        found.append(f"{format(value.normalize(), 'f')} {units[match.group().casefold()]}")
    if uncertain or len(set(found)) > 1:
        return "", ["Weight narration was uncertain or contained multiple measurements; verify the weight."]
    return (found[0] if found else ""), []


def _finish(text: str) -> tuple[str, list[str]]:
    values = []
    warnings = []
    for match in _FINISH.finditer(text):
        start = max(text.rfind(".", 0, match.start()), text.rfind(",", 0, match.start()), text.rfind(";", 0, match.start())) + 1
        prefix = text[start:match.start()]
        if _UNCERTAIN.search(prefix):
            warnings.append("Finish narration was uncertain; verify the finish.")
            continue
        negation = re.search(r"\b(?:not|never|isn't|hasn't been)\s+(?:\w+\s+){0,2}$", prefix, re.I)
        values.append((negation.group() if negation else "") + match.group())
    return "; ".join(dict.fromkeys(values)), warnings


def extract_facts(transcript: str, settings: dict | None = None) -> dict:
    """Extract conservative seller-dictated facts, leaving unknown values empty.

    Returned `notes`, `transcript`, and `source_transcript` retain the complete
    original input. `corrected_transcript` is separate, never a replacement.
    """
    if not isinstance(transcript, str):
        raise TypeError("Transcript must be a string.")
    prefs = normalized_settings(settings)
    text, applied = apply_corrections(transcript, prefs.get("corrections"))
    material, warnings = _material(text, prefs)
    specimen_number, number_warnings = _specimen_number(text)
    locality, locality_warnings = _locality(text, material, prefs)
    price, price_warnings = _parse_price(text)
    weight, weight_warnings = _weight(text)
    clauses = _clauses(text)
    conditions = [clause.strip(" .") for clause in clauses if _DEFECT.search(clause)]
    finish, finish_warnings = _finish(text)
    finishes = finish.split("; ")
    if "rough" in [f.casefold() for f in finishes] and not any("polish" in f.casefold() and not f.casefold().startswith("not ") for f in finishes):
        category = "Rough & Lapidary"
    elif "agate" in material.casefold():
        category = "Agates"
    elif "geode" in material.casefold():
        category = "Geodes"
    else:
        category = "Mineral Specimens"
    warnings += number_warnings + locality_warnings + price_warnings + weight_warnings + finish_warnings
    if not conditions:
        warnings.append("No condition disclosure recognized; confirm condition before approval.")
    elif re.search(r"\b(?:condition\s+(?:is\s+)?(?:not checked|unknown|unchecked|not assessed)|defects?\s+unknown)\b", text, re.I):
        warnings.append("Condition has not been checked; inspect the specimen before publishing.")
    if not transcript.strip():
        warnings.insert(0, "Transcript is empty; add narration or enter specimen details.")
    return {
        "material": material, "specimen_number": specimen_number,
        "locality": locality, "locality_source": "seller narration" if locality else "",
        "locality_verified": False, "price_cents": price, "weight": weight,
        "weight_source": "seller narration" if weight else "",
        "finish": finish, "condition": "; ".join(dict.fromkeys(conditions)),
        "category": category, "notes": transcript, "transcript": transcript,
        "source_transcript": transcript, "corrected_transcript": text,
        "corrections_applied": applied, "warnings": list(dict.fromkeys(warnings)),
        "extraction_engine": "local deterministic rules",
    }


def _clean(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "; ".join(_clean(v) for v in value if _clean(v))
    if isinstance(value, dict):
        if "value" in value:
            return f"{value['value']} {value.get('unit', '')}".strip()
        return "; ".join(f"{key}: {_clean(val)}" for key, val in value.items())
    return str(value).strip()


def _bounded_title(parts: list[str], limit: int) -> str:
    result = ""
    for part in parts:
        if not part:
            continue
        candidate = f"{result} — {part}" if result else part
        if len(candidate) <= limit:
            result = candidate
        elif not result:
            result = part[:limit].rsplit(" ", 1)[0] if " " in part[:limit] else part[:limit]
    return result or "Specimen"


def _slug(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", value).strip("-") or "specimen"


def _tags(record: dict, settings: dict) -> list[str]:
    material = _clean(record.get("material")).lower()
    locality = _clean(record.get("locality")).lower()
    finish = _clean(record.get("finish")).lower()
    candidates = [material, locality, finish]
    if "agate" in material:
        candidates += ["agate specimen", "agate", "collectible agate", "rock collection"]
    elif "geode" in material:
        candidates += ["geode specimen", "geode", "rock collection"]
    if "rough" in finish or "rough" in material:
        candidates += ["rough specimen", "lapidary rough", "lapidary material"]
    if "polished" in finish and "unpolished" not in finish and not re.search(r"\bnot\s+(?:\w+\s+){0,2}polished", finish):
        candidates += ["polished specimen", "polished rock"]
    if material:
        candidates += ["mineral specimen", "rock specimen", "collector specimen"]
    # User-added SEO phrases are used only if they also occur in the actual facts.
    factual = " ".join(_clean(record.get(k)) for k in ("material", "locality", "finish", "notes", "description")).casefold()
    candidates += [_clean(t).lower() for t in settings.get("seo_vocabulary", []) if _clean(t).casefold() in factual]
    if len(material) > 20:
        words = material.split()
        candidates += [" ".join(words[i:i + 2]) for i in range(len(words) - 1)]
    tags = []
    for candidate in candidates:
        candidate = re.sub(r"[^\w\s'-]", "", candidate, flags=re.UNICODE).strip(" -'")
        candidate = re.sub(r"\s+", " ", candidate)
        if candidate and len(candidate) <= 20 and candidate not in tags:
            tags.append(candidate)
        if len(tags) == 13:
            break
    return tags


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Local AI redirects are disabled.")


def _bridge():
    try:
        from .media import native
    except ImportError:
        from media import native
    return native


def capabilities(refresh: bool = False) -> dict:
    """Report the installed model honestly; never request model assets."""
    global _AI_STATUS
    now = time.monotonic()
    if refresh or _AI_STATUS is None or now - _AI_STATUS[0] > 30:
        try:
            status = _bridge()("ai-status", timeout=8)
            status.pop("ok", None)
        except Exception:
            status = {"status": "unavailable", "engine": "factual templates",
                      "message": "Native text generation is unavailable; factual drafts still work."}
        status.update(cloud=False, inference_cost=0, model_downloads=False)
        _AI_STATUS = (now, status)
    return copy.deepcopy(_AI_STATUS[1])


def _appearance_candidates(source: str, material: str, condition: str) -> list[str]:
    """Evidence excerpts, never photo guesses or facts supplied by the model."""
    candidates = []
    for clause in _clauses(source):
        if (8 <= len(clause) <= 180 and _VISUAL_FEATURE.search(clause)
                and not _DEFECT.search(clause)
                and not re.search(r"\b(?:number|specimen|price|dollars?|asking|weigh|from|ignore|instruction|prompt|publish)\b|\$", clause, re.I)
                and clause.casefold() != material.casefold()
                and clause.casefold() not in condition.casefold()):
            candidates.append(clause)
    return list(dict.fromkeys(candidates))[:10]


def _copy_request(name: str, number: str, locality: str, finish: str,
                  weight: str, dimensions: str, condition: str,
                  source: str, material: str) -> dict:
    identity = f"Specimen {number}" if number else "Specimen"
    leads = [f"{identity}: {name}.", f"{name}" + (f" (specimen {number})." if number else ".")]
    details = []
    for value, alternatives in (
        (locality, [f"Seller-supplied locality: {locality}.", f"Locality recorded by the seller: {locality}."]),
        (finish, [f"Finish: {finish}.", f"Recorded finish: {finish}."]),
        (weight, [f"Recorded specimen weight: {weight}.", f"Specimen weight: {weight}."]),
        (dimensions, [f"Recorded dimensions: {dimensions}.", f"Dimensions: {dimensions}."]),
        (condition, [f"Condition: {condition}.", f"Condition notes: {condition}."]),
    ):
        if value:
            details.append(alternatives)
    return {"leads": leads, "details": details,
            "features": _appearance_candidates(source, material, condition)}


def _validate_composition(result: dict, request: dict) -> list[str]:
    """Validate independently of the model/schema, including every disclosure."""
    if not isinstance(result, dict) or set(result) != {"lead", "details", "features"}:
        raise ValueError("Invalid composition fields")
    lead, details, features = result["lead"], result["details"], result["features"]
    if (lead not in request["leads"] or not isinstance(details, list) or not isinstance(features, list)
            or any(not isinstance(v, str) for v in details + features)):
        raise ValueError("Invalid factual copy")
    if len(details) != len(request["details"]) or len(set(details)) != len(details):
        raise ValueError("A required fact was duplicated or omitted")
    if any(sum(sentence in group for sentence in details) != 1 for group in request["details"]):
        raise ValueError("Required facts must each occur once")
    if any(not any(sentence in group for group in request["details"]) for sentence in details):
        raise ValueError("Unrecognized statement")
    if len(features) > 2 or len(set(features)) != len(features) or any(f not in request["features"] for f in features):
        raise ValueError("Appearance claims need exact source evidence")
    return [lead] + [feature.rstrip(" .") + "." for feature in features] + details


def _compose_with_native(request: dict, settings: dict) -> tuple[list[str] | None, str, list[str]]:
    if not settings.get("native_ai", {}).get("enabled", True):
        return None, "deterministic templates", []
    if capabilities().get("status") != "ready":
        return None, "deterministic templates", []
    key = json.dumps(request, sort_keys=True)
    # Serialize on an 8 GB Mac. Cache only validated text, never session history.
    with _AI_LOCK:
        if key in _AI_CACHE:
            return copy.deepcopy(_AI_CACHE[key])
        try:
            with tempfile.TemporaryDirectory(prefix="mineral-copy-") as temporary:
                path = Path(temporary) / "facts.json"
                path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
                result = _bridge()("ai-compose", input=path, timeout=52)
            if result.get("status") != "complete":
                raise ValueError("Local composition unavailable")
            sentences = _validate_composition(result.get("composition"), request)
            value = (sentences, result["engine"], [])
        except Exception:
            value = (None, "deterministic fallback", ["Local AI could not produce validated copy; factual draft used."])
        if value[0] is not None:
            if len(_AI_CACHE) >= 128:
                _AI_CACHE.pop(next(iter(_AI_CACHE)))
            _AI_CACHE[key] = value
        return copy.deepcopy(value)


def _arrange_with_ollama(sentences: list[str], settings: dict) -> tuple[list[str], str, list[str]]:
    config = settings.get("ollama", {})
    if not config.get("enabled"):
        return sentences, "deterministic templates", []
    model = _clean(config.get("model"))
    try:
        parsed = urlsplit(_clean(config.get("base_url")))
        if (parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {"", "/"}):
            raise ValueError("Only a local loopback Ollama server is supported.")
        if not model or ":cloud" in model.casefold() or model.casefold().endswith("-cloud"):
            raise ValueError("Choose an installed local Ollama model, not a cloud model.")
        timeout = max(0.2, min(float(config.get("timeout_seconds", 4)), 15))
        schema = {"type": "object", "properties": {"sentence_order": {
            "type": "array", "items": {"type": "integer"},
            "minItems": len(sentences), "maxItems": len(sentences)}},
            "required": ["sentence_order"], "additionalProperties": False}
        prompt = ("Arrange the following immutable fact sentences into a concise mineral "
                  "listing. Return only JSON with sentence_order containing each zero-based "
                  "index exactly once. Do not write any new words or facts.\n" +
                  json.dumps({"sentences": sentences, "schema": schema}, ensure_ascii=False))
        request = Request(_clean(config.get("base_url")).rstrip("/") + "/api/generate",
                          data=json.dumps({"model": model, "prompt": prompt, "format": schema,
                                           "stream": False, "keep_alive": "0",
                                           "options": {"temperature": 0, "num_predict": 150}}).encode(),
                          headers={"Content-Type": "application/json"}, method="POST")
        # Ignore proxy environment variables, and never follow redirects elsewhere.
        with build_opener(ProxyHandler({}), _NoRedirect()).open(request, timeout=timeout) as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("Local model response exceeded the size limit.")
        envelope = json.loads(raw)
        result = json.loads(envelope["response"])
        order = result.get("sentence_order")
        if (set(result) != {"sentence_order"} or not isinstance(order, list)
                or any(type(i) is not int for i in order)
                or sorted(order) != list(range(len(sentences)))):
            raise ValueError("Local model did not return a valid sentence permutation.")
        return [sentences[i] for i in order], "Ollama sentence arrangement; immutable facts", []
    except Exception:
        # A failed local service must never prevent useful offline drafts.
        return sentences, "deterministic fallback", ["Local AI unavailable or returned an unsafe result; factual template used."]


def _channel_prices(record: dict, settings: dict) -> dict[str, int | None]:
    price = record.get("price_cents")
    if isinstance(price, bool) or not isinstance(price, int) or price < 0:
        price = None
    prices = {"website": price, "etsy": price, "ebay": price}
    configured = record.get("channel_prices") or record.get("platform_prices") or {}
    if isinstance(configured, dict):
        for channel in prices:
            cents = configured.get(channel)
            if isinstance(cents, int) and not isinstance(cents, bool) and cents >= 0:
                prices[channel] = cents
    rule = settings.get("pricing", {})
    if price is not None and rule.get("enabled") is True and rule.get("approved") is True:
        for channel, key, sign in (("website", "website_discount_percent", -1),
                                   ("etsy", "etsy_markup_percent", 1),
                                   ("ebay", "ebay_markup_percent", 1)):
            if channel in configured:
                continue
            try:
                percent = Decimal(str(rule.get(key, 0)))
                if not percent.is_finite() or not 0 <= percent <= 100:
                    continue
                prices[channel] = int((Decimal(price) * (1 + sign * percent / 100)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            except (InvalidOperation, ValueError, TypeError):
                continue
    return prices


def generate_listings(record: dict, settings: dict | None = None) -> dict:
    """Translate one saved master record into distinct, factual channel drafts.

    All required marketplace IDs, policy IDs, eligibility decisions, and shipping
    prices remain unassigned until authenticated taxonomy/account configuration.
    Photo order follows the master record; no visual identity claims are inferred.
    """
    if not isinstance(record, dict):
        raise TypeError("A specimen record must be a JSON object.")
    prefs = normalized_settings(settings)
    material = _clean(record.get("material"))
    number = _clean(record.get("specimen_number") or record.get("sku"))
    locality = _clean(record.get("locality"))
    finish = _clean(record.get("finish"))
    condition = _clean(record.get("condition"))
    source = _clean(record.get("source_transcript") or record.get("transcript") or record.get("notes"))
    legacy = record.get("legacy") if isinstance(record.get("legacy"), dict) else {}
    documented = _clean(record.get("original_description") or legacy.get("description"))
    # Existing condition and the original recorded disclosures are additive.
    source_conditions = [c.strip(" .") for c in _clauses(source + "\n" + documented) if _DEFECT.search(c)]
    conditions = [condition] if condition else []
    for clause in source_conditions:
        if not any(clause.casefold() in known.casefold() for known in conditions):
            conditions.append(clause)
    condition = "; ".join(conditions)
    weight = _clean(record.get("weight"))
    dimensions = _clean(record.get("dimensions"))
    category = _clean(record.get("category")) or "Mineral Specimens"
    name = _clean(record.get("title") or record.get("name")) or material or "Specimen"
    identity = f"Specimen {number}" if number else "Specimen"
    website_title = _bounded_title([name, f"No. {number}" if number else ""], 160)
    etsy_title = _bounded_title([name, finish, locality, f"No. {number}" if number else ""], 140)
    ebay_title = _bounded_title([name, locality, weight, finish, f"#{number}" if number else ""], 80)
    if len({website_title, etsy_title, ebay_title}) < 3:
        # Keep the channel presentation distinct even when very few facts exist.
        etsy_title = _bounded_title([name, f"Specimen {number}" if number else "Specimen listing", finish, locality], 140)
        ebay_title = _bounded_title([name, f"#{number}" if number else "Specimen details", locality, finish], 80)
    detail_values = {"Specimen number": number, "Material": material, "Locality (seller supplied)": locality,
                     "Weight": weight, "Dimensions": dimensions, "Finish": finish,
                     "Category": category, "Condition": condition}
    details = {key: value for key, value in detail_values.items() if value}
    sentences = [f"{identity}: {name}."]
    if locality:
        sentences.append(f"Seller-supplied locality: {locality}.")
    if finish:
        sentences.append(f"Finish: {finish}.")
    if weight:
        sentences.append(f"Recorded specimen weight: {weight}.")
    if dimensions:
        sentences.append(f"Recorded dimensions: {dimensions}.")
    if condition:
        sentences.append(f"Condition: {condition}.")
    request = _copy_request(name, number, locality, finish, weight, dimensions,
                            condition, source + "\n" + documented, material)
    # Existing explicit Ollama configuration remains supported; the installed
    # Apple model is the automatic zero-cost default on a compatible Mac.
    if prefs.get("ollama", {}).get("enabled"):
        arranged, engine, model_warnings = _arrange_with_ollama(sentences, prefs)
    else:
        composed, engine, model_warnings = _compose_with_native(request, prefs)
        arranged = composed or sentences
        if composed is None:
            features = request["features"][:2]
            arranged = sentences[:1] + [f.rstrip(" .") + "." for f in features] + sentences[1:]
    detail_block = "\n".join(f"{key}: {value}" for key, value in details.items())
    # Full source evidence stays in metadata and private review by default.
    # Public copy keeps every condition disclosure without repeating prices and
    # narration instructions. An explicit preference retains the legacy export.
    show_source = prefs.get("include_source_notes_in_description", False)
    source_block = f"\n\nSeller's original recorded notes:\n{source}" if source and show_source else ""
    if documented and show_source:
        source_block += f"\n\nOriginal documented description (retained for review):\n{documented}"
    closing = _clean(prefs.get("style", {}).get("closing")) if isinstance(prefs.get("style"), dict) else ""
    standard_condition = _clean(prefs.get("condition_language"))
    condition_block = "" if condition else "\n\nCondition: Not yet confirmed by the seller."
    if standard_condition:
        condition_block += f"\n{standard_condition}"
    website_description = " ".join(arranged) + condition_block + source_block
    if closing:
        website_description += "\n\n" + closing
    etsy_description = " ".join(arranged) + condition_block + source_block
    ebay_description = "\n".join(arranged) + condition_block + source_block
    prices = _channel_prices(record, prefs)
    images = record.get("photos") or record.get("images") or []
    alt = f"{name}" + (f", specimen {number}" if number else "")
    # Alt text is deliberately photo-neutral: no unseen colors, angles, or locality.
    warnings = list(record.get("warnings") or []) + model_warnings
    if not condition:
        warnings.append("Confirm condition before approving this listing.")
    if prices["website"] is None:
        warnings.append("Price is missing or invalid; publishing requires a verified price.")
    common = {"condition": condition, "price_cents": None,
              "photo_order": copy.deepcopy(images), "alt_text": alt,
              "source_transcript": record.get("source_transcript", record.get("transcript", record.get("notes", ""))),
              "original_description": documented,
              "source_notes": source, "copy_engine": engine,
              "copy_validation": "All factual sentences and appearance excerpts checked against source choices; disclosures retained.",
              "draft": True}
    website = {**copy.deepcopy(common), "title": website_title,
               "slug": _slug(f"{name}-{number}"), "short_description": " ".join(sentences[:3]),
               "description": website_description, "details": details, "price_cents": prices["website"],
               "structured_data": {"@context": "https://schema.org", "@type": "Product",
                                   "name": website_title, "description": " ".join(sentences),
                                   **({"sku": number} if number else {})}}
    etsy = {**copy.deepcopy(common), "title": etsy_title, "tags": _tags(record, prefs),
            "description": etsy_description, "attributes": details.copy(), "materials": [material] if material else [],
            "category_suggestion": category, "taxonomy_id": None, "who_made": None, "when_made": None,
            "price_cents": prices["etsy"], "shipping_profile_id": None, "readiness_state_id": None,
            "review_required": ["Confirm current Etsy category, item eligibility, required attributes, and shipping profile."]}
    ebay = {**copy.deepcopy(common), "title": ebay_title, "description": ebay_description,
            "item_specifics": {key: [value] for key, value in details.items()},
            "condition_description": condition, "condition_id": None,
            "category_suggestion": category, "category_id": None, "price_cents": prices["ebay"],
            "shipping": {"policy_id": None, "package_weight": None, "package_dimensions": None},
            "review_required": ["Select eBay category and required aspects, condition ID, and account policies."]}
    return {"website": website, "etsy": etsy, "ebay": ebay,
            "warnings": list(dict.fromkeys(warnings)), "engine": engine}
