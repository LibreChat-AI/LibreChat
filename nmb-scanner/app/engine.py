"""Scanner core: analysis, policy decision, masking, unmasking and review workflow."""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from presidio_analyzer import AnalyzerEngine, RecognizerRegistry
from presidio_analyzer.nlp_engine import NlpEngineProvider

from . import extract as ex
from .config import Settings
from .policy import Policy
from .recognizers import BlocklistRecognizer, build_static_recognizers
from .vault import PLACEHOLDER_RE, Vault, now

log = logging.getLogger("nmb.scanner")
CHUNK = 50_000
_SEP_RE = re.compile(r"[\s\-./]")
# Entities whose equality should ignore separators/case.
_NORMALISE = {"ACCOUNT_NUMBER", "CREDIT_CARD", "IBAN", "ZW_NATIONAL_ID", "US_SSN", "PHONE", "SWIFT_BIC"}


@dataclass
class Ctx:
    conversation_id: str
    user: str = "anonymous"
    department: str | None = None
    roles: list[str] = field(default_factory=list)


@dataclass
class Raw:
    seg: int
    start: int
    end: int
    entity: str
    score: float
    value: str


def norm_value(entity: str, v: str) -> str:
    if entity in _NORMALISE:
        return _SEP_RE.sub("", v).upper()
    return " ".join(v.split()).lower()


def _build_nlp(settings: Settings):
    import spacy

    model = settings.spacy_model
    if not model:
        path = settings.data_dir / "spacy-blank-en"
        if not path.exists():
            nlp = spacy.blank("en")
            nlp.add_pipe("sentencizer")
            nlp.to_disk(path)
        model = str(path)
    conf = {"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": model}]}
    return NlpEngineProvider(nlp_configuration=conf).create_engine(), model


class Scanner:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        self.policy = Policy.load(settings.policy_file)
        self.vault = Vault(settings.data_dir, settings.vault_key)
        self.blocklist = BlocklistRecognizer(settings.blocklist_file, settings.data_dir / "blocklist.additions.json")
        nlp, self.nlp_model = _build_nlp(settings)
        reg = RecognizerRegistry(supported_languages=["en"])
        for r in build_static_recognizers():
            reg.add_recognizer(r)
        reg.add_recognizer(self.blocklist)
        if settings.spacy_model:  # a real NER model: enable PERSON / LOCATION via Presidio's spaCy recogniser
            from presidio_analyzer.predefined_recognizers import SpacyRecognizer
            reg.add_recognizer(SpacyRecognizer(supported_entities=["PERSON", "LOCATION"]))
        self.analyzer = AnalyzerEngine(registry=reg, nlp_engine=nlp, supported_languages=["en"])

    # ------------------------------------------------------------ analysis
    def _analyze_segments(self, segments: list[ex.Segment]) -> list[Raw]:
        raws: list[Raw] = []
        floor = min([self.policy.min_score] +
                    [c.get("min_score", 1) for c in self.policy.entities.values()])
        for i, seg in enumerate(segments):
            text = seg.text
            if not text.strip():
                continue
            seg_raws: list[Raw] = []
            for off in range(0, len(text), CHUNK):
                chunk = text[off:off + CHUNK]
                for r in self.analyzer.analyze(text=chunk, language="en", score_threshold=floor):
                    seg_raws.append(Raw(i, r.start + off, r.end + off, r.entity_type, r.score,
                                        text[r.start + off:r.end + off]))
            raws.extend(self._resolve_overlaps(seg_raws))
            if len(raws) > self.policy.max_findings:
                raise ValueError("too many findings; refusing to process")
        return raws

    @staticmethod
    def _resolve_overlaps(raws: list[Raw]) -> list[Raw]:
        raws = sorted(raws, key=lambda r: (-r.score, -(r.end - r.start), r.start))
        kept: list[Raw] = []
        for r in raws:
            if all(r.end <= k.start or r.start >= k.end for k in kept):
                kept.append(r)
        return sorted(kept, key=lambda r: r.start)

    # ------------------------------------------------------------ decision core
    def scan_segments(self, segments: list[ex.Segment], ctx: Ctx, *, source: str, meta: dict | None = None,
                      doc_review_reason: str | None = None, doc_reject_reason: str | None = None,
                      force_mask_blocks: bool = False, create_review: bool = True,
                      original_ref: str | None = None, rendered: bool = False) -> dict:
        meta = meta or {}
        raws = self._analyze_segments(segments)
        findings, kept = [], []
        block_reasons: list[str] = []
        reject = bool(doc_reject_reason)
        for r in raws:
            cfg = self.policy.entity_cfg(r.entity, ctx.department)
            if r.score < cfg.get("min_score", self.policy.min_score):
                continue
            action = cfg["action"]
            if action == "BLOCK" and force_mask_blocks:
                action = "MASK"
            if action == "BLOCK":
                if cfg["block_outcome"] == "reject":
                    reject = True
                block_reasons.append(cfg["type"] + ":" + r.entity)
            nv = norm_value(r.entity, r.value)
            f = {
                "entity": r.entity, "type": cfg["type"],
                "location": {"segment": segments[r.seg].location, "start": r.start, "end": r.end},
                "score": round(float(r.score), 3), "action": action,
                "value_hash": self.vault.value_hash(r.entity, nv),
                "placeholder": None,
            }
            findings.append(f)
            kept.append((r, cfg, nv, f))
            log.info("finding entity=%s action=%s hash=%s loc=%s score=%.2f",
                     r.entity, action, f["value_hash"], segments[r.seg].location, r.score)

        review_reason = None
        if reject:
            decision = "reject"
            review_reason = doc_reject_reason or ("Submission contains material that policy forbids sending: "
                                                   + ", ".join(sorted(set(block_reasons))))
        elif block_reasons or doc_review_reason:
            decision = "review"
            parts = []
            if block_reasons:
                parts.append("Policy requires human review for: " + ", ".join(sorted(set(block_reasons))))
            if doc_review_reason:
                parts.append(doc_review_reason)
            review_reason = " ".join(parts)
        elif any(f["action"] == "MASK" for f in findings):
            decision = "mask"
        else:
            decision = "allow"

        sanitized = None
        out_segments = None
        if decision in ("mask", "allow"):
            texts = [s.text for s in segments]
            by_seg: dict[int, list] = {}
            for item in kept:
                by_seg.setdefault(item[0].seg, []).append(item)
            for si in sorted(by_seg):
                items = sorted(by_seg[si], key=lambda x: x[0].start)
                for r, cfg, nv, f in items:        # left to right so numbering follows reading order
                    if f["action"] == "MASK":
                        f["placeholder"] = self.vault.get_or_create_placeholder(
                            ctx.conversation_id, r.entity, cfg["prefix"], nv, r.value, bool(cfg["reversible"]))
                t = segments[si].text
                for r, cfg, nv, f in reversed(items):   # right to left so offsets stay valid
                    if f["placeholder"]:
                        t = t[:r.start] + f["placeholder"] + t[r.end:]
                texts[si] = t
            if source == "text":
                sanitized = texts[0] if texts else ""
            else:
                sanitized = ex.render(segments, texts)
                out_segments = [{"location": s.location, "text": t} for s, t in zip(segments, texts)]

        result = {
            "decision": decision,
            "conversation_id": ctx.conversation_id,
            "findings": findings,
            "sanitized_content": sanitized,
            "review_required_reason": review_reason,
            "review_id": None,
            "document": meta or None,
            "sanitized_segments": out_segments,
            "summary": _summary(findings),
        }
        if decision in ("review", "reject") and create_review:
            result["review_id"] = self._create_review(result, segments, ctx, source, meta, original_ref)
        return result

    # ------------------------------------------------------------ public scans
    def scan_text(self, text: str, ctx: Ctx) -> dict:
        segs = [ex.Segment("text", text, "p", "text")]
        return self.scan_segments(segs, ctx, source="text")

    def scan_file(self, filename: str, data: bytes, ctx: Ctx) -> dict:
        pol = self.policy.files
        allowed = pol.get("allowed_extensions", [".docx", ".pdf", ".xlsx"])
        ext = "." + filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
        meta = {"filename_ext": ext, "bytes": len(data)}
        if ext not in allowed:
            return self._reject_nocontent(ctx, f"File type {ext or '(none)'} is not permitted.", meta)
        if len(data) > pol.get("max_bytes", 26_214_400):
            return self._reject_nocontent(ctx, "File exceeds the maximum permitted size.", meta)
        try:
            doc = ex.extract(filename, data, pol.get("min_chars_per_pdf_page", 20))
        except ex.CorruptFile as e:
            return self._reject_nocontent(ctx, f"File could not be parsed ({e}); it was not sent.", meta)
        if len(doc.segments) > pol.get("max_segments", 200_000):
            return self._reject_nocontent(ctx, "File is too large to inspect.", meta)
        meta.update(doc.meta)
        review = reject = None
        if doc.needs_review:
            if pol.get("scanned_pdf_action", "review") == "reject":
                reject = doc.needs_review
            else:
                review = doc.needs_review
        return self.scan_segments(doc.segments, ctx, source="file", meta=meta,
                                  doc_review_reason=review, doc_reject_reason=reject)

    def _reject_nocontent(self, ctx, reason, meta):
        return {"decision": "reject", "conversation_id": ctx.conversation_id, "findings": [],
                "sanitized_content": None, "review_required_reason": reason, "review_id": None,
                "document": meta, "sanitized_segments": None, "summary": {}}

    # ------------------------------------------------------------ unmask
    def unmask(self, conversation_id: str, text: str, roles: list[str]) -> dict:
        allowed = self.policy.unmask_roles
        if allowed and not (allowed & set(roles)):
            raise PermissionError("role not permitted to unmask")
        restored, unresolved = 0, []

        def sub(m):
            nonlocal restored
            v = self.vault.lookup_placeholder(conversation_id, m.group(0))
            if v is None:
                unresolved.append(m.group(0))
                return m.group(0)
            restored += 1
            return v

        out = PLACEHOLDER_RE.sub(sub, text)
        return {"text": out, "restored": restored, "unresolved": sorted(set(unresolved))}

    # ------------------------------------------------------------ reviews
    def _create_review(self, result, segments, ctx, source, meta, original_ref):
        if original_ref:
            ref = original_ref
        elif result["decision"] == "reject":
            ref = None   # forbidden material (e.g. private keys) is never retained, even encrypted
        else:
            ref = self.vault.put_blob({"source": source, "meta": meta,
                                       "segments": [s.__dict__ for s in segments]})
        item = {
            "id": "rev_" + uuid.uuid4().hex[:12],
            "user": ctx.user, "department": ctx.department,
            "conversation_id": ctx.conversation_id,
            "source": source, "original_prompt_ref": ref,
            "decision_at_creation": result["decision"],
            "reason": result["review_required_reason"],
            "findings": result["findings"],
            "status": "pending" if result["decision"] == "review" else "rejected",
            "reviewer": None if result["decision"] == "review" else "system",
            "reviewer_note": None, "blocklist_additions": [],
            "created_at": now(), "updated_at": now(), "resolved_at": None if result["decision"] == "review" else now(),
            "result_ref": None,
        }
        self.vault.save_review(item)
        return item["id"]

    def _require_reviewer(self, roles):
        if not (self.policy.reviewer_roles & set(roles)):
            raise PermissionError("reviewer role required")

    def original(self, rid: str, roles: list[str]) -> dict:
        self._require_reviewer(roles)
        item = self.vault.get_review(rid)
        if not item:
            raise KeyError(rid)
        blob = self.vault.get_blob(item["original_prompt_ref"])
        segs = [ex.Segment(**s) for s in blob["segments"]]
        return {"id": rid, "source": blob["source"],
                "segments": [{"location": s.location, "text": s.text} for s in segs]}

    def approve_masked(self, rid: str, reviewer: str, roles: list[str], note: str | None,
                       blocklist_terms: list[str]) -> dict:
        self._require_reviewer(roles)
        item = self.vault.get_review(rid)
        if not item:
            raise KeyError(rid)
        if item["status"] != "pending":
            raise ValueError(f"review already {item['status']}")
        added = self.blocklist.add_runtime_terms(blocklist_terms) if blocklist_terms else []
        blob = self.vault.get_blob(item["original_prompt_ref"])
        segs = [ex.Segment(**s) for s in blob["segments"]]
        ctx = Ctx(item["conversation_id"], item["user"], item["department"], [])
        res = self.scan_segments(segs, ctx, source=blob["source"], meta=blob["meta"],
                                 force_mask_blocks=True, create_review=False)
        item.update(status="approved-masked", reviewer=reviewer, reviewer_note=note,
                    blocklist_additions=added, updated_at=now(), resolved_at=now(),
                    findings=res["findings"], result_ref=self.vault.put_blob(
                        {"sanitized_content": res["sanitized_content"],
                         "sanitized_segments": res["sanitized_segments"]}))
        self.vault.save_review(item)
        res["review_id"] = rid
        return res

    def reject(self, rid: str, reviewer: str, roles: list[str], note: str | None,
               blocklist_terms: list[str]) -> dict:
        self._require_reviewer(roles)
        item = self.vault.get_review(rid)
        if not item:
            raise KeyError(rid)
        if item["status"] != "pending":
            raise ValueError(f"review already {item['status']}")
        added = self.blocklist.add_runtime_terms(blocklist_terms) if blocklist_terms else []
        item.update(status="rejected", reviewer=reviewer, reviewer_note=note, blocklist_additions=added,
                    updated_at=now(), resolved_at=now())
        self.vault.save_review(item)
        return item

    def review_result(self, rid: str) -> dict:
        """Gateway polls this after approval to obtain the sanitised content to forward."""
        item = self.vault.get_review(rid)
        if not item:
            raise KeyError(rid)
        out = {"id": rid, "status": item["status"], "sanitized_content": None, "sanitized_segments": None}
        if item["status"] == "approved-masked" and item.get("result_ref"):
            blob = self.vault.get_blob(item["result_ref"])
            out.update(blob)
        return out


def _summary(findings: list[dict]) -> dict:
    s: dict = {}
    for f in findings:
        s.setdefault(f["entity"], {"count": 0, "actions": {}})
        s[f["entity"]]["count"] += 1
        s[f["entity"]]["actions"][f["action"]] = s[f["entity"]]["actions"].get(f["action"], 0) + 1
    return s
