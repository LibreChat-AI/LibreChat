"""Text extraction from .docx / .pdf / .xlsx into ordered segments, and re-rendering.

Locations never contain document content (sheet names are referred to by index).
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field

MAX_CELL_CHARS = 100_000


@dataclass
class Segment:
    location: str
    text: str
    kind: str = "p"          # p | cell | heading | prop
    group: str = ""          # table / sheet / page identifier
    row: int = 0
    col: int = 0
    header: bool = False


@dataclass
class Extracted:
    segments: list[Segment]
    meta: dict = field(default_factory=dict)
    needs_review: str | None = None


class UnsupportedFile(Exception):
    pass


class CorruptFile(Exception):
    pass


# ---------------------------------------------------------------- docx
def _docx_block_iter(parent):
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    from docx.oxml.ns import qn

    parent = getattr(parent, "_body", parent)   # Document -> its body container
    for child in parent._element.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, parent)
        elif child.tag == qn("w:tbl"):
            yield Table(child, parent)


def _docx_container(container, prefix: str, segs: list[Segment], counter: dict):
    from docx.table import Table

    pi = 0
    for block in _docx_block_iter(container):
        if isinstance(block, Table):
            counter["t"] += 1
            ti = counter["t"]
            for ri, row in enumerate(block.rows):
                seen, ci = set(), 0
                for cell in row.cells:
                    if id(cell._tc) in seen:        # merged cells repeat
                        continue
                    seen.add(id(cell._tc))
                    txt = " ".join(p.text for p in cell.paragraphs if p.text).strip()
                    # nested tables inside the cell
                    for nt in cell.tables:
                        for nr in nt.rows:
                            txt += " " + " ".join(c.text for c in nr.cells)
                    segs.append(Segment(f"{prefix}.t[{ti}].r[{ri}].c[{ci}]", txt.strip(), "cell",
                                        f"{prefix}.t{ti}", ri, ci, header=(ri == 0)))
                    ci += 1
        else:
            if block.text.strip():
                segs.append(Segment(f"{prefix}.p[{pi}]", block.text, "p", prefix))
            pi += 1


def extract_docx(data: bytes) -> Extracted:
    from docx import Document

    try:
        doc = Document(io.BytesIO(data))
    except Exception as e:  # noqa: BLE001
        raise CorruptFile(f"cannot open docx: {type(e).__name__}") from e
    segs: list[Segment] = []
    cp = doc.core_properties
    for name in ("author", "last_modified_by", "title", "subject", "comments", "keywords", "category"):
        v = getattr(cp, name, None)
        if v:
            segs.append(Segment(f"props.{name}", str(v), "prop", "props"))
    counter = {"t": 0}
    _docx_container(doc, "body", segs, counter)
    for si, sec in enumerate(doc.sections):
        for label, part in (("header", sec.header), ("first_header", sec.first_page_header),
                            ("even_header", sec.even_page_header), ("footer", sec.footer),
                            ("first_footer", sec.first_page_footer), ("even_footer", sec.even_page_footer)):
            if part.is_linked_to_previous and si > 0:
                continue
            start = len(segs)
            _docx_container(part, f"{label}.s{si}", segs, counter)
            if len(segs) > start:
                segs.insert(start, Segment(f"{label}.s{si}.title", f"[{label.replace('_', ' ')}]", "heading",
                                           f"{label}.s{si}"))
    return Extracted(segs, {"type": "docx", "tables": counter["t"], "sections": len(doc.sections)})


# ---------------------------------------------------------------- xlsx
def _cell_text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v)[:MAX_CELL_CHARS]


def extract_xlsx(data: bytes) -> Extracted:
    import openpyxl

    try:
        wb_v = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
        wb_f = openpyxl.load_workbook(io.BytesIO(data), data_only=False)
    except Exception as e:  # noqa: BLE001
        raise CorruptFile(f"cannot open xlsx: {type(e).__name__}") from e
    segs: list[Segment] = []
    hidden = 0
    for si, ws in enumerate(wb_v.worksheets, start=1):
        wf = wb_f[ws.title]
        if ws.sheet_state != "visible":
            hidden += 1
        grp = f"sheet{si}"
        segs.append(Segment(f"sheet[{si}].name", ws.title, "heading", grp))
        header_row_done = False
        for row in ws.iter_rows():
            row_has = False
            for c in row:
                v = c.value
                if v is None:
                    fv = wf[c.coordinate].value
                    if isinstance(fv, str) and fv.startswith("="):
                        v = fv
                txt = _cell_text(v)
                note = c.comment.text if c.comment else None
                if not txt and not note:
                    continue
                is_hdr = not header_row_done
                if txt:
                    segs.append(Segment(f"sheet[{si}]!{c.coordinate}", txt, "cell", grp, c.row, c.column,
                                        header=is_hdr))
                    row_has = True
                if note:
                    segs.append(Segment(f"sheet[{si}]!{c.coordinate}.comment", note, "prop", grp))
            if row_has:
                header_row_done = True
    for name in ("creator", "lastModifiedBy", "title", "subject", "description", "keywords"):
        v = getattr(wb_v.properties, name, None)
        if v:
            segs.append(Segment(f"props.{name}", str(v), "prop", "props"))
    return Extracted(segs, {"type": "xlsx", "sheets": len(wb_v.worksheets), "hidden_sheets": hidden})


# ---------------------------------------------------------------- pdf
def extract_pdf(data: bytes, min_chars: int = 20) -> Extracted:
    import pdfplumber

    segs: list[Segment] = []
    scanned: list[int] = []
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            n = len(pdf.pages)
            for i, page in enumerate(pdf.pages, start=1):
                text = (page.extract_text() or "").strip()
                segs.append(Segment(f"page[{i}].title", f"Page {i}", "heading", f"page{i}"))
                if len(text) >= min_chars:
                    segs.append(Segment(f"page[{i}]", text, "p", f"page{i}"))
                else:
                    if text:
                        segs.append(Segment(f"page[{i}]", text, "p", f"page{i}"))
                    scanned.append(i)
            meta_info = pdf.metadata or {}
        for k in ("Author", "Title", "Subject", "Keywords", "Creator"):
            v = meta_info.get(k)
            if v:
                segs.append(Segment(f"props.{k.lower()}", str(v), "prop", "props"))
    except Exception as e:  # noqa: BLE001
        raise CorruptFile(f"cannot open pdf: {type(e).__name__}") from e
    reason = None
    if scanned:
        pages = ", ".join(map(str, scanned[:20])) + ("..." if len(scanned) > 20 else "")
        reason = (f"PDF has no usable text layer on page(s) {pages} (scanned or image-only). "
                  "Content cannot be inspected; manual review or OCR required.")
    return Extracted(segs, {"type": "pdf", "pages": n, "pages_without_text": scanned}, needs_review=reason)


EXTRACTORS = {".docx": extract_docx, ".xlsx": extract_xlsx, ".pdf": extract_pdf}


def extract(filename: str, data: bytes, min_pdf_chars: int = 20) -> Extracted:
    ext = "." + filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext not in EXTRACTORS:
        raise UnsupportedFile(f"unsupported file type {ext or '(none)'}")
    if ext == ".pdf":
        return extract_pdf(data, min_pdf_chars)
    return EXTRACTORS[ext](data)


# ---------------------------------------------------------------- render
def render(segments: list[Segment], texts: list[str]) -> str:
    """Render segments (with sanitised texts) to markdown-like text preserving tables/sheets."""
    out: list[str] = []
    row_buf: list[str] = []
    row_key = None
    row_hdr = False
    props: list[str] = []

    def flush():
        nonlocal row_buf, row_key, row_hdr
        if row_buf:
            out.append("| " + " | ".join(row_buf) + " |")
            if row_hdr:
                out.append("|" + "---|" * len(row_buf))
        row_buf, row_key, row_hdr = [], None, False

    for seg, txt in zip(segments, texts):
        txt = txt.replace("\r", " ")
        if seg.kind == "cell":
            key = (seg.group, seg.row)
            if key != row_key:
                flush()
                row_key, row_hdr = key, seg.header
            row_buf.append(txt.replace("\n", " ").replace("|", "/"))
            continue
        flush()
        if seg.kind == "heading":
            out.append(f"\n## {txt}")
        elif seg.kind == "prop":
            props.append(f"- {seg.location}: {txt}")
        else:
            out.append(txt)
    flush()
    if props:
        out.append("\n## Document properties")
        out.extend(props)
    return "\n".join(out).strip() + "\n"
