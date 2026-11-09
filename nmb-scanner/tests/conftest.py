import io
import sys
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

CONFIG = Path(__file__).resolve().parent.parent / "config"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("NMB_VAULT_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("NMB_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("NMB_POLICY_FILE", str(CONFIG / "policy.yaml"))
    monkeypatch.setenv("NMB_BLOCKLIST_FILE", str(CONFIG / "blocklist.yaml"))
    monkeypatch.delenv("NMB_SERVICE_KEY", raising=False)
    return tmp_path


_cache = {}


@pytest.fixture()
def scanner(env):
    from app.config import Settings
    from app.engine import Scanner
    return Scanner(Settings.from_env())


@pytest.fixture()
def client(env):
    from fastapi.testclient import TestClient
    from app import main
    main.get_scanner.cache_clear()
    with TestClient(main.app) as c:
        yield c
    main.get_scanner.cache_clear()


# ---- synthetic file builders -------------------------------------------
def make_docx() -> bytes:
    from docx import Document
    d = Document()
    d.core_properties.author = "Synthetic Author jane.author@example.com"
    d.add_paragraph("Customer wire instruction for Project Falcon.")
    d.add_paragraph("Account number: 1234567890123")
    t = d.add_table(rows=2, cols=2)
    t.cell(0, 0).text = "Beneficiary"
    t.cell(0, 1).text = "Contact"
    t.cell(1, 0).text = "SWIFT: ABCDZWHX"
    t.cell(1, 1).text = "ops.team@example.com"
    d.sections[0].header.paragraphs[0].text = "Confidential - national id 63-123456 A 12"
    d.sections[0].footer.paragraphs[0].text = "Call +263 77 123 4567 for queries"
    b = io.BytesIO()
    d.save(b)
    return b.getvalue()


def make_xlsx() -> bytes:
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Project Falcon"
    ws.append(["Name", "Account number", "Card"])
    ws.append(["Alice Example", 1234567890123, "4111 1111 1111 1111"])
    ws.append(["Bob Example", "9876543210", "n/a"])
    hid = wb.create_sheet("Hidden")
    hid.append(["Email"])
    hid.append(["x.y@example.org"])
    hid.sheet_state = "hidden"
    b = io.BytesIO()
    wb.save(b)
    return b.getvalue()


def make_pdf(text_lines) -> bytes:
    from reportlab.pdfgen import canvas
    b = io.BytesIO()
    c = canvas.Canvas(b)
    y = 800
    for ln in text_lines:
        c.drawString(50, y, ln)
        y -= 20
    c.showPage()
    c.save()
    return b.getvalue()


def make_scanned_pdf() -> bytes:
    from PIL import Image
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas
    img = Image.new("RGB", (200, 100), "white")
    b = io.BytesIO()
    c = canvas.Canvas(b)
    c.drawImage(ImageReader(img), 50, 600, 300, 150)
    c.showPage()
    c.save()
    return b.getvalue()
