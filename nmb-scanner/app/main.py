"""FastAPI app. See docs/nmb/INTERFACE.md for the contract."""
from __future__ import annotations

import hmac
import logging
import os
import uuid
from functools import lru_cache

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .config import Settings
from .engine import Ctx, Scanner

logging.basicConfig(level=os.environ.get("NMB_LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")


@lru_cache(maxsize=1)
def get_scanner() -> Scanner:
    return Scanner(Settings.from_env())


def auth(x_nmb_service_key: str | None = Header(default=None), sc: Scanner = Depends(get_scanner)):
    expected = sc.settings.service_key
    if expected and not (x_nmb_service_key and hmac.compare_digest(x_nmb_service_key, expected)):
        raise HTTPException(401, "invalid or missing X-NMB-Service-Key")


app = FastAPI(title="NMB Scanner", version="1.0.0", dependencies=[Depends(auth)])


class ScanTextIn(BaseModel):
    text: str
    conversation_id: str = Field(min_length=1)
    user: str = "anonymous"
    department: str | None = None
    roles: list[str] = []


class UnmaskIn(BaseModel):
    conversation_id: str
    text: str
    roles: list[str] = []


class ReviewActionIn(BaseModel):
    reviewer: str
    roles: list[str] = []
    note: str | None = None
    blocklist_additions: list[str] = []


class BlocklistAddIn(BaseModel):
    terms: list[str]


def _ctx(conversation_id, user, department, roles) -> Ctx:
    return Ctx(conversation_id, user, department, [r.strip() for r in (roles or "").split(",") if r.strip()]
               if isinstance(roles, str) else list(roles or []))


@app.get("/health")
def health(sc: Scanner = Depends(get_scanner)):
    return {"status": "ok", "nlp_model": "custom" if sc.settings.spacy_model else "blank",
            "blocklist_entries": len(sc.blocklist.entries)}


@app.get("/policy")
def policy(sc: Scanner = Depends(get_scanner)):
    return sc.policy.summary()


@app.post("/scan/text")
def scan_text(body: ScanTextIn, sc: Scanner = Depends(get_scanner)):
    return sc.scan_text(body.text, _ctx(body.conversation_id, body.user, body.department, body.roles))


@app.post("/scan/file")
async def scan_file(file: UploadFile = File(...), conversation_id: str = Form(...), user: str = Form("anonymous"),
                    department: str | None = Form(None), roles: str = Form(""), sc: Scanner = Depends(get_scanner)):
    limit = sc.policy.files.get("max_bytes", 26_214_400)
    data = await file.read(limit + 1)
    return sc.scan_file(file.filename or "", data, _ctx(conversation_id, user, department, roles))


@app.post("/unmask")
def unmask(body: UnmaskIn, sc: Scanner = Depends(get_scanner)):
    try:
        return sc.unmask(body.conversation_id, body.text, body.roles)
    except PermissionError as e:
        raise HTTPException(403, str(e))


@app.delete("/conversations/{conversation_id}")
def purge(conversation_id: str, sc: Scanner = Depends(get_scanner)):
    return {"deleted_mappings": sc.vault.delete_conversation(conversation_id)}


@app.get("/reviews")
def list_reviews(status: str | None = None, department: str | None = None, user: str | None = None,
                 sc: Scanner = Depends(get_scanner)):
    return {"items": sc.vault.list_reviews(status, department, user)}


@app.get("/reviews/{rid}")
def get_review(rid: str, sc: Scanner = Depends(get_scanner)):
    item = sc.vault.get_review(rid)
    if not item:
        raise HTTPException(404, "review not found")
    return item


@app.get("/reviews/{rid}/original")
def review_original(rid: str, x_nmb_roles: str = Header(default=""), sc: Scanner = Depends(get_scanner)):
    try:
        return sc.original(rid, [r.strip() for r in x_nmb_roles.split(",")])
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except KeyError:
        raise HTTPException(404, "review not found")


@app.get("/reviews/{rid}/result")
def review_result(rid: str, sc: Scanner = Depends(get_scanner)):
    try:
        return sc.review_result(rid)
    except KeyError:
        raise HTTPException(404, "review not found")


def _act(fn, rid, body: ReviewActionIn):
    try:
        return fn(rid, body.reviewer, body.roles, body.note, body.blocklist_additions)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except KeyError:
        raise HTTPException(404, "review not found")
    except ValueError as e:
        raise HTTPException(409, str(e))


@app.post("/reviews/{rid}/approve-masked")
def approve(rid: str, body: ReviewActionIn, sc: Scanner = Depends(get_scanner)):
    return _act(sc.approve_masked, rid, body)


@app.post("/reviews/{rid}/reject")
def reject(rid: str, body: ReviewActionIn, sc: Scanner = Depends(get_scanner)):
    return _act(sc.reject, rid, body)


@app.get("/blocklist")
def get_blocklist(sc: Scanner = Depends(get_scanner)):
    return {"entries": [{k: v for k, v in e.items()} for e in sc.blocklist.entries]}


@app.post("/blocklist")
def add_blocklist(body: BlocklistAddIn, x_nmb_roles: str = Header(default=""), sc: Scanner = Depends(get_scanner)):
    roles = {r.strip() for r in x_nmb_roles.split(",")}
    if not (sc.policy.reviewer_roles & roles):
        raise HTTPException(403, "reviewer role required")
    return {"added": sc.blocklist.add_runtime_terms(body.terms)}
