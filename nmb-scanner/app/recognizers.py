"""Custom Presidio recognisers for banking data."""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Callable

import yaml
from presidio_analyzer import EntityRecognizer, RecognizerResult

ISO_COUNTRIES = set(
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ "
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR "
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO "
    "JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR "
    "MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO "
    "RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV "
    "TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split()
)

Validator = Callable[[str], "bool | float"]


def luhn_ok(digits: str) -> bool:
    if not digits.isdigit() or not 13 <= len(digits) <= 19:
        return False
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def iban_ok(raw: str) -> bool:
    s = re.sub(r"\s", "", raw).upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{11,30}", s):
        return False
    if s[:2] not in ISO_COUNTRIES:
        return False
    rearr = s[4:] + s[:4]
    num = "".join(str(int(c, 36)) for c in rearr)
    return int(num) % 97 == 1


def _meta(rec: EntityRecognizer) -> dict:
    return {RecognizerResult.RECOGNIZER_NAME_KEY: rec.name,
            RecognizerResult.RECOGNIZER_IDENTIFIER_KEY: rec.id}


class RegexRecognizer(EntityRecognizer):
    """Regex recogniser with capture-group support, validator and preceding-context boost."""

    def __init__(self, entity: str, patterns: list[tuple[str, float]], group: int = 0,
                 validator: Validator | None = None, context: list[str] | None = None,
                 boosted: float | None = None, flags=0, window: int = 40, name: str | None = None):
        super().__init__(supported_entities=[entity], supported_language="en",
                         name=name or f"nmb_{entity.lower()}")
        self.entity = entity
        self.patterns = [(re.compile(p, flags), s) for p, s in patterns]
        self.group, self.validator = group, validator
        self.context = [c.lower() for c in (context or [])]
        self.boosted, self.window = boosted, window

    def load(self):  # pragma: no cover
        pass

    def _has_context(self, text: str, start: int) -> bool:
        if not self.context:
            return False
        before = text[max(0, start - self.window):start].lower()
        return any(c in before for c in self.context)

    def analyze(self, text, entities=None, nlp_artifacts=None):
        out = []
        for rx, score in self.patterns:
            for m in rx.finditer(text):
                s, e = m.span(self.group)
                if s < 0 or s == e:
                    continue
                val = text[s:e]
                sc = score
                if self.validator:
                    r = self.validator(val)
                    if r is False:
                        continue
                    if isinstance(r, float):
                        sc = r
                if self.boosted and self._has_context(text, s):
                    sc = max(sc, self.boosted)
                out.append(RecognizerResult(self.entity, s, e, sc, recognition_metadata=_meta(self)))
        return out


class BlocklistRecognizer(EntityRecognizer):
    """Organisation keyword blocklist, loaded from YAML/JSON plus runtime additions."""

    def __init__(self, base_file: Path, additions_file: Path):
        super().__init__(supported_entities=["ORG_KEYWORD"], supported_language="en", name="nmb_blocklist")
        self.base_file, self.additions_file = Path(base_file), Path(additions_file)
        self._lock = threading.RLock()
        self._compiled: list[tuple[re.Pattern, str]] = []
        self.entries: list[dict] = []
        self.reload()

    def load(self):  # pragma: no cover
        pass

    @staticmethod
    def _read(path: Path) -> list:
        if not path.exists():
            return []
        raw = path.read_text()
        data = json.loads(raw) if path.suffix == ".json" else yaml.safe_load(raw)
        if isinstance(data, dict):
            data = data.get("terms", [])
        return data or []

    def reload(self):
        entries = []
        for src, path in (("base", self.base_file), ("runtime", self.additions_file)):
            for e in self._read(path):
                e = {"term": e} if isinstance(e, str) else dict(e)
                e["source"] = src
                entries.append(e)
        compiled = []
        for e in entries:
            ent = e.get("entity", "ORG_KEYWORD")
            if "regex" in e:
                compiled.append((re.compile(e["regex"]), ent))
            elif e.get("term"):
                compiled.append((re.compile(r"(?<!\w)" + re.escape(e["term"]) + r"(?!\w)", re.I), ent))
        with self._lock:
            self.entries, self._compiled = entries, compiled

    def add_runtime_terms(self, terms: list[str]) -> list[str]:
        existing = {str(e.get("term", "")).lower() for e in self.entries}
        cur = self._read(self.additions_file)
        added = []
        for t in terms:
            t = t.strip()
            if t and t.lower() not in existing:
                cur.append(t)
                added.append(t)
                existing.add(t.lower())
        if added:
            self.additions_file.parent.mkdir(parents=True, exist_ok=True)
            self.additions_file.write_text(json.dumps({"terms": cur}, indent=2))
            self.reload()
        return added

    def analyze(self, text, entities=None, nlp_artifacts=None):
        out = []
        with self._lock:
            compiled = list(self._compiled)
        for rx, ent in compiled:
            for m in rx.finditer(text):
                if m.end() > m.start():
                    out.append(RecognizerResult(ent, m.start(), m.end(), 0.95, recognition_metadata=_meta(self)))
        return out


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s)


def _card_validator(v: str):
    d = _digits(v)
    return luhn_ok(d) and len(v) - len(d) <= 6


def _swift_validator(v: str):
    return v[4:6] in ISO_COUNTRIES


def _ssn_validator(v: str):
    area, grp, ser = v.split("-")
    return not (area in ("000", "666") or area.startswith("9") or grp == "00" or ser == "0000")


def _phone_validator(v: str):
    return 9 <= len(_digits(v)) <= 15


def _bare_account_validator(v: str):
    d = _digits(v)
    if luhn_ok(d):
        return False  # a Luhn-valid 13-19 digit run is a card; the card recogniser owns it
    return 10 <= len(d) <= 16


def build_static_recognizers() -> list[EntityRecognizer]:
    ctx_acct = ["account", "acct", "a/c", "acc no", "acc.", "beneficiary", "iban"]
    return [
        RegexRecognizer(
            "ACCOUNT_NUMBER", [(r"(?<![\w.])\d(?:[ -]?\d){8,17}(?![\w])", 0.45)],
            validator=_bare_account_validator, context=ctx_acct, boosted=0.9),
        RegexRecognizer(
            "SWIFT_BIC", [(r"\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b", 0.30)],
            validator=_swift_validator, context=["swift", "bic", "sort code", "correspondent"], boosted=0.9),
        RegexRecognizer("IBAN", [(r"\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{2,4}){2,8}\b", 0.9)], validator=iban_ok),
        RegexRecognizer("CREDIT_CARD", [(r"(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])", 0.9)],
                        validator=_card_validator),
        RegexRecognizer("ZW_NATIONAL_ID", [(r"\b\d{2}[- ]?\d{6,7}[- ]?[A-Za-z][- ]?\d{2}\b", 0.85)]),
        RegexRecognizer("US_SSN", [(r"\b\d{3}-\d{2}-\d{4}\b", 0.85)], validator=_ssn_validator),
        RegexRecognizer(
            "PHONE",
            [(r"(?<![\w])(?:\+|00)\d{1,3}[ -]?\(?\d{1,4}\)?(?:[ -]?\d{2,4}){2,4}(?!\w)", 0.8),
             (r"(?<![\w+])0\d{2,3}[ -]?\d{3}[ -]?\d{3,4}(?!\w)", 0.6)],
            validator=_phone_validator, context=["phone", "tel", "mobile", "cell", "whatsapp", "call"],
            boosted=0.85),
        RegexRecognizer("EMAIL", [(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b", 0.95)]),
        RegexRecognizer(
            "PRIVATE_KEY",
            [(r"-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----)?",
              0.99)]),
        RegexRecognizer(
            "API_KEY_SECRET",
            [(r"\bAKIA[0-9A-Z]{16}\b", 0.95),
             (r"\bsk-ant-[A-Za-z0-9_-]{16,}\b", 0.97),
             (r"\bsk-[A-Za-z0-9]{20,}\b", 0.9),
             (r"\bgh[pousr]_[A-Za-z0-9]{30,}\b", 0.95),
             (r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b", 0.95),
             (r"\bAIza[0-9A-Za-z_-]{30,}\b", 0.9),
             (r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b", 0.9)],
            name="nmb_api_key_known"),
        RegexRecognizer(
            "API_KEY_SECRET",
            [(r"(?i)\b(?:api[_-]?key|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|token|password|passwd|pwd)"
              r"[\"']?\s*[:=]\s*[\"']?([^\s\"',;]{8,})", 0.85)],
            group=1, name="nmb_api_key_assignment"),
    ]
