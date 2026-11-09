import io

from app.engine import Ctx
from conftest import make_docx, make_pdf, make_scanned_pdf, make_xlsx

CTX = Ctx("conv-f", "u1", "Risk-none", ["user"])


def locs(res):
    return {f["location"]["segment"] for f in res["findings"]}


def test_docx_body_table_header_footer_props(scanner):
    res = scanner.scan_file("report.docx", make_docx(), CTX)
    assert res["decision"] == "mask"
    out = res["sanitized_content"]
    for raw in ["1234567890123", "ABCDZWHX", "ops.team@example.com", "63-123456", "77 123 4567",
                "Project Falcon", "jane.author@example.com"]:
        assert raw not in out, raw
    assert "| Beneficiary | Contact |" in out and "|---|---|" in out
    assert "[header]" in out and "[footer]" in out
    ls = locs(res)
    assert any(l.startswith("body.t[1]") for l in ls)
    assert any(l.startswith("header.") for l in ls)
    assert any(l.startswith("footer.") for l in ls)
    assert "props.author" in ls
    assert res["document"]["type"] == "docx" and res["document"]["tables"] == 1


def test_xlsx_all_sheets_names_headers(scanner):
    res = scanner.scan_file("book.xlsx", make_xlsx(), CTX)
    assert res["decision"] == "mask"
    out = res["sanitized_content"]
    assert "Project Falcon" not in out                      # sheet name blocklisted
    for raw in ["1234567890123", "9876543210", "4111", "x.y@example.org"]:
        assert raw not in out, raw
    assert "| Name | Account number | Card |" in out         # column headers kept, clean
    assert "<EMAIL_001>" in out                              # hidden sheet is scanned
    assert "sheet[1].name" in locs(res)
    assert res["document"]["hidden_sheets"] == 1
    assert any(l.startswith("sheet[1]!B2") for l in locs(res))


def test_xlsx_placeholders_consistent_with_text_scan(scanner):
    scanner.scan_text("account 1234567890123", CTX)
    res = scanner.scan_file("book.xlsx", make_xlsx(), CTX)
    assert "<ACCOUNT_001>" in res["sanitized_content"]   # same value, same conversation, same placeholder


def test_pdf_text_layer(scanner):
    pdf = make_pdf(["Statement for account number 1234567890123", "Contact jane.doe@example.com for queries"])
    res = scanner.scan_file("stmt.pdf", pdf, CTX)
    assert res["decision"] == "mask"
    assert "1234567890123" not in res["sanitized_content"] and "<EMAIL_001>" in res["sanitized_content"]
    assert "page[1]" in locs(res)


def test_scanned_pdf_flagged_for_review(scanner):
    res = scanner.scan_file("scan.pdf", make_scanned_pdf(), CTX)
    assert res["decision"] == "review"
    assert "no usable text layer" in res["review_required_reason"]
    assert res["sanitized_content"] is None and res["review_id"]


def test_unsupported_and_corrupt_rejected(scanner):
    assert scanner.scan_file("x.exe", b"MZ", CTX)["decision"] == "reject"
    assert scanner.scan_file("x.docx", b"not a docx", CTX)["decision"] == "reject"
    assert scanner.scan_file("x.pdf", b"%PDF-garbage", CTX)["decision"] == "reject"


def test_file_with_secret_goes_to_review(scanner):
    pdf = make_pdf(["config api_key = ABCDEFGH12345678XYZ"])
    res = scanner.scan_file("c.pdf", pdf, CTX)
    assert res["decision"] == "review"
    rid = res["review_id"]
    out = scanner.approve_masked(rid, "rev", ["reviewer"], None, [])
    assert "ABCDEFGH12345678XYZ" not in out["sanitized_content"]
    assert "<SECRET_001>" in out["sanitized_content"]


def test_api_end_to_end(client):
    r = client.post("/scan/text", json={"text": "acct 1234567890123", "conversation_id": "c9", "user": "u",
                                        "department": "Risk", "roles": ["user"]})
    assert r.status_code == 200 and r.json()["decision"] == "mask"
    r = client.post("/scan/file", data={"conversation_id": "c9", "user": "u", "roles": "user"},
                    files={"file": ("a.docx", make_docx(),
                                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
    assert r.status_code == 200 and r.json()["decision"] == "mask"
    assert "<ACCOUNT_001>" in r.json()["sanitized_content"]
    r = client.post("/unmask", json={"conversation_id": "c9", "text": "x <ACCOUNT_001>", "roles": ["user"]})
    assert r.json()["text"] == "x 1234567890123"
    assert client.post("/unmask", json={"conversation_id": "c9", "text": "x", "roles": []}).status_code == 403
    rid = client.post("/scan/text", json={"text": "key AKIAIOSFODNN7EXAMPLE", "conversation_id": "c9",
                                          "user": "u", "department": "Risk"}).json()["review_id"]
    assert client.get("/reviews", params={"status": "pending"}).json()["items"][0]["id"] == rid
    assert client.get(f"/reviews/{rid}/original").status_code == 403
    assert client.get(f"/reviews/{rid}/original", headers={"X-NMB-Roles": "reviewer"}).status_code == 200
    r = client.post(f"/reviews/{rid}/approve-masked", json={"reviewer": "r", "roles": ["reviewer"]})
    assert r.status_code == 200 and r.json()["decision"] == "mask"
    assert client.post(f"/reviews/{rid}/reject", json={"reviewer": "r", "roles": ["reviewer"]}).status_code == 409
    assert client.get(f"/reviews/{rid}/result").json()["status"] == "approved-masked"
    assert client.post("/blocklist", json={"terms": ["x"]}).status_code == 403


def test_service_key_enforced(env, monkeypatch):
    monkeypatch.setenv("NMB_SERVICE_KEY", "k-123")
    from fastapi.testclient import TestClient
    from app import main
    main.get_scanner.cache_clear()
    with TestClient(main.app) as c:
        assert c.get("/health").status_code == 401
        assert c.get("/health", headers={"X-NMB-Service-Key": "k-123"}).status_code == 200
    main.get_scanner.cache_clear()
