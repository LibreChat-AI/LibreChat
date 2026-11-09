import logging

from app.engine import Ctx

CTX = Ctx("conv-1", "u1", "Wealth", ["user"])


def ents(res):
    return {f["entity"] for f in res["findings"]}


def test_each_entity_masked(scanner):
    text = ("Account number 1234567890123 at SWIFT ABCDZWHX, IBAN GB82 WEST 1234 5698 7654 32, "
            "card 4111 1111 1111 1111, ID 63-123456 A 12, SSN 123-45-6789, phone +263 77 123 4567, "
            "mail jane.doe@example.com, see Project Falcon.")
    res = scanner.scan_text(text, CTX)
    assert res["decision"] == "mask"
    assert {"ACCOUNT_NUMBER", "SWIFT_BIC", "IBAN", "CREDIT_CARD", "ZW_NATIONAL_ID", "US_SSN", "PHONE",
            "EMAIL", "ORG_KEYWORD"} <= ents(res)
    out = res["sanitized_content"]
    for raw in ["1234567890123", "ABCDZWHX", "WEST 1234", "4111", "63-123456", "123-45-6789",
                "77 123 4567", "jane.doe@example.com", "Project Falcon"]:
        assert raw not in out, raw
    for ph in ["<ACCOUNT_001>", "<SWIFT_001>", "<IBAN_001>", "<CARD_001>", "<NATIONAL_ID_001>",
               "<SSN_001>", "<PHONE_001>", "<EMAIL_001>", "<ORG_001>"]:
        assert ph in out, ph
    # findings never carry raw values
    assert "1234567890123" not in str(res["findings"])


def test_luhn_invalid_card_not_card(scanner):
    res = scanner.scan_text("number 4111 1111 1111 1112 here", CTX)
    assert "CREDIT_CARD" not in ents(res)


def test_invalid_iban_checksum_rejected(scanner):
    res = scanner.scan_text("iban GB82 WEST 1234 5698 7654 33", CTX)
    assert "IBAN" not in ents(res)


def test_swift_needs_valid_country_and_context(scanner):
    res = scanner.scan_text("The ABSTRACT and STANDARD words", CTX)
    assert "SWIFT_BIC" not in ents(res)


def test_zw_id_variants(scanner):
    for v in ["63-123456 A 12", "63-1234567-A-12", "08-123456 b 07"]:
        res = scanner.scan_text(f"id {v} end", CTX)
        assert "ZW_NATIONAL_ID" in ents(res), v


def test_local_phone(scanner):
    res = scanner.scan_text("call 0772 123 456 now", CTX)
    assert "PHONE" in ents(res)


def test_placeholders_stable_within_conversation(scanner):
    a = scanner.scan_text("Pay account 1234567890123 and account 9876543210.", CTX)["sanitized_content"]
    b = scanner.scan_text("Again account 9876543210 then account 1234567890123", CTX)["sanitized_content"]
    assert a == "Pay account <ACCOUNT_001> and account <ACCOUNT_002>."
    assert b == "Again account <ACCOUNT_002> then account <ACCOUNT_001>"
    other = scanner.scan_text("account 9876543210", Ctx("conv-2", "u1", None, []))["sanitized_content"]
    assert other == "account <ACCOUNT_001>"


def test_same_value_different_formatting_same_placeholder(scanner):
    out = scanner.scan_text("phone +263 77 123 4567 and +263-77-123-4567", CTX)["sanitized_content"]
    assert out.count("<PHONE_001>") == 2


def test_secret_blocks_for_review_no_placeholders(scanner):
    res = scanner.scan_text("use AKIAIOSFODNN7EXAMPLE to log in", CTX)
    assert res["decision"] == "review"
    assert res["sanitized_content"] is None
    assert res["review_id"] and "API_KEY_SECRET" in res["review_required_reason"]
    assert scanner.vault.lookup_placeholder("conv-1", "<ACCOUNT_001>") is None


def test_password_assignment_detected(scanner):
    res = scanner.scan_text('config: password = "S3cr3t-Value-xyz"', CTX)
    assert res["decision"] == "review"


def test_private_key_rejected_and_not_retained(scanner):
    pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBFAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----"
    res = scanner.scan_text("here " + pem, CTX)
    assert res["decision"] == "reject"
    item = scanner.vault.get_review(res["review_id"])
    assert item["original_prompt_ref"] is None and item["status"] == "rejected"


def test_clean_text_allowed(scanner):
    res = scanner.scan_text("Summarise quarterly loan growth by segment.", CTX)
    assert res["decision"] == "allow" and res["findings"] == []
    assert res["sanitized_content"] == "Summarise quarterly loan growth by segment."


def test_department_override(scanner):
    t = "ring +263 77 123 4567 about Project Falcon"
    comp = scanner.scan_text(t, Ctx("c", "u", "Compliance", []))
    assert "<PHONE_" not in comp["sanitized_content"] and "<ORG_001>" in comp["sanitized_content"]
    risk = scanner.scan_text(t, Ctx("c2", "u", "Risk", []))
    assert risk["decision"] == "review"


def test_blocklist_regex_and_runtime_addition(scanner):
    assert "ORG_KEYWORD" in ents(scanner.scan_text("ref INTERNAL-ABC-1234", CTX))
    assert "ORG_KEYWORD" not in ents(scanner.scan_text("mention Zebra Initiative", CTX))
    scanner.blocklist.add_runtime_terms(["Zebra Initiative"])
    assert "ORG_KEYWORD" in ents(scanner.scan_text("mention Zebra Initiative", CTX))


def test_unmask_roundtrip_and_authorisation(scanner):
    scanner.scan_text("account 1234567890123 and card 4111 1111 1111 1111", CTX)
    ans = "Funds moved from <ACCOUNT_001>; card <CARD_001> unchanged; <ACCOUNT_009> unknown."
    r = scanner.unmask("conv-1", ans, ["user"])
    assert "1234567890123" in r["text"]
    assert "<CARD_001>" in r["text"]            # PCI: non-reversible
    assert "<ACCOUNT_009>" in r["text"]
    assert set(r["unresolved"]) == {"<CARD_001>", "<ACCOUNT_009>"}
    import pytest
    with pytest.raises(PermissionError):
        scanner.unmask("conv-1", ans, ["guest"])
    # other conversation cannot resolve
    assert "1234567890123" not in scanner.unmask("conv-zzz", ans, ["user"])["text"]


def test_vault_encrypted_at_rest(scanner, env):
    scanner.scan_text("account 1234567890123", CTX)
    for p in (env / "data").rglob("*"):
        if p.is_file() and p.suffix in (".db", ".json"):
            assert b"1234567890123" not in p.read_bytes()


def test_no_raw_values_in_logs(scanner, caplog):
    caplog.set_level(logging.DEBUG)
    scanner.scan_text("acct 1234567890123 mail jane.doe@example.com key AKIAIOSFODNN7EXAMPLE", CTX)
    assert "1234567890123" not in caplog.text
    assert "jane.doe" not in caplog.text
    assert "AKIAIOSFODNN7EXAMPLE" not in caplog.text
    assert "hash=" in caplog.text


def test_review_lifecycle_approve_masked(scanner):
    res = scanner.scan_text("acct 1234567890123 token AKIAIOSFODNN7EXAMPLE about Zebra Initiative", CTX)
    rid = res["review_id"]
    item = scanner.vault.get_review(rid)
    assert item["status"] == "pending" and item["user"] == "u1" and item["department"] == "Wealth"
    import pytest
    with pytest.raises(PermissionError):
        scanner.approve_masked(rid, "bob", ["user"], None, [])
    assert "AKIAIOSFODNN7EXAMPLE" in str(scanner.original(rid, ["reviewer"]))
    out = scanner.approve_masked(rid, "rev1", ["reviewer"], "ok", ["Zebra Initiative"])
    assert out["decision"] == "mask"
    assert "AKIA" not in out["sanitized_content"] and "<SECRET_001>" in out["sanitized_content"]
    assert "<ORG_001>" in out["sanitized_content"]
    item = scanner.vault.get_review(rid)
    assert item["status"] == "approved-masked" and item["reviewer"] == "rev1"
    assert item["blocklist_additions"] == ["Zebra Initiative"] and item["resolved_at"]
    assert scanner.review_result(rid)["sanitized_content"] == out["sanitized_content"]
    with pytest.raises(ValueError):
        scanner.reject(rid, "rev1", ["reviewer"], None, [])


def test_review_lifecycle_reject(scanner):
    rid = scanner.scan_text("key AKIAIOSFODNN7EXAMPLE", CTX)["review_id"]
    item = scanner.reject(rid, "rev1", ["admin"], "no", [])
    assert item["status"] == "rejected"
    assert scanner.review_result(rid)["sanitized_content"] is None


def test_large_text_chunking(scanner):
    big = ("lorem ipsum " * 6000) + " account 1234567890123 " + ("dolor " * 6000)
    res = scanner.scan_text(big, CTX)
    assert "1234567890123" not in res["sanitized_content"]
