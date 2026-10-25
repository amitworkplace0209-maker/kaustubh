"""
Serializer registry — 25 formats for tick data export.

Each serializer produces valid files from a list of tick dicts.
Adding a new format: create a Serializer subclass, call _register().
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import sqlite3
import tempfile
import zipfile
from abc import ABC, abstractmethod
from xml.etree.ElementTree import Element, SubElement, tostring

# ── Optional dependencies (graceful fallback) ──────────────────────
try:
    import openpyxl
    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
    HAS_PYARROW = True
except ImportError:
    HAS_PYARROW = False

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

try:
    from odf.opendocument import OpenDocumentSpreadsheet
    from odf.table import Table, TableRow, TableCell
    from odf.text import P
    HAS_ODF = True
except ImportError:
    HAS_ODF = False

try:
    import fastavro
    HAS_FASTAVRO = True
except ImportError:
    HAS_FASTAVRO = False

try:
    import tomllib as _tomllib_w
    HAS_TOML = True
except ImportError:
    HAS_TOML = False


# ── Abstract base ──────────────────────────────────────────────────
class Serializer(ABC):
    id: str
    display_name: str
    extension: str
    mime_type: str
    available: bool
    description: str
    category: str = "General"

    @abstractmethod
    def serialize(self, ticks: list[dict], fields: list[str]) -> bytes:
        ...


# ── Helpers ────────────────────────────────────────────────────────
def _filter_fields(ticks: list[dict], fields: list[str]) -> list[dict]:
    """Return ticks with only the requested fields, preserving order."""
    if not fields:
        return ticks
    return [{k: t.get(k) for k in fields} for t in ticks]


def _rows(ticks: list[dict], fields: list[str]) -> list[list]:
    """Convert ticks to row-matrix (list of lists)."""
    return [[t.get(f) for f in fields] for t in _filter_fields(ticks, fields)]


# ── Plain-text serializers ─────────────────────────────────────────
class CSVSerializer(Serializer):
    id = "csv"
    display_name = "CSV"
    extension = "csv"
    mime_type = "text/csv"
    available = True
    description = "Comma-separated values"
    category = "Tabular"

    def serialize(self, ticks, fields):
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for row in _filter_fields(ticks, fields):
            w.writerow(row)
        return buf.getvalue().encode("utf-8")


class TSVSerializer(Serializer):
    id = "tsv"
    display_name = "TSV"
    extension = "tsv"
    mime_type = "text/tab-separated-values"
    available = True
    description = "Tab-separated values"
    category = "Tabular"

    def serialize(self, ticks, fields):
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=fields, delimiter="\t", extrasaction="ignore")
        w.writeheader()
        for row in _filter_fields(ticks, fields):
            w.writerow(row)
        return buf.getvalue().encode("utf-8")


class CSVBOMSerializer(Serializer):
    id = "csv_bom"
    display_name = "CSV (BOM)"
    extension = "csv"
    mime_type = "text/csv"
    available = True
    description = "CSV with UTF-8 BOM for Excel compatibility"
    category = "Tabular"

    def serialize(self, ticks, fields):
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for row in _filter_fields(ticks, fields):
            w.writerow(row)
        return ("\ufeff" + buf.getvalue()).encode("utf-8")


class TXTSerializer(Serializer):
    id = "txt"
    display_name = "TXT"
    extension = "txt"
    mime_type = "text/plain"
    available = True
    description = "Tab-separated values (plain text)"
    category = "Text"

    def serialize(self, ticks, fields):
        buf = io.StringIO()
        w = csv.writer(buf, delimiter="\t")
        w.writerow(fields)
        for row in _rows(ticks, fields):
            w.writerow(row)
        return buf.getvalue().encode("utf-8")


class MarkdownSerializer(Serializer):
    id = "markdown"
    display_name = "Markdown"
    extension = "md"
    mime_type = "text/markdown"
    available = True
    description = "Markdown table format"
    category = "Text"

    def serialize(self, ticks, fields):
        lines = []
        lines.append("| " + " | ".join(fields) + " |")
        lines.append("| " + " | ".join(["---"] * len(fields)) + " |")
        for row in _rows(ticks, fields):
            lines.append("| " + " | ".join(str(v if v is not None else "") for v in row) + " |")
        return "\n".join(lines).encode("utf-8")


class HTMLSerializer(Serializer):
    id = "html"
    display_name = "HTML"
    extension = "html"
    mime_type = "text/html"
    available = True
    description = "HTML table format"
    category = "Text"

    def serialize(self, ticks, fields):
        parts = [
            "<!DOCTYPE html><html><head>",
            "<meta charset='utf-8'>",
            "<title>Tick Data Export</title>",
            "<style>table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f5f5f5}tr:nth-child(even){background:#fafafa}</style>",
            "</head><body>",
            "<table><thead><tr>",
        ]
        for f in fields:
            parts.append(f"<th>{f}</th>")
        parts.append("</tr></thead><tbody>")
        for row in _filter_fields(ticks, fields):
            parts.append("<tr>")
            for f in fields:
                parts.append(f"<td>{row.get(f, '')}</td>")
            parts.append("</tr>")
        parts.append("</tbody></table></body></html>")
        return "\n".join(parts).encode("utf-8")


class XMLSerializer(Serializer):
    id = "xml"
    display_name = "XML"
    extension = "xml"
    mime_type = "application/xml"
    available = True
    description = "XML document format"
    category = "Structured"

    def serialize(self, ticks, fields):
        root = Element("ticks")
        for t in _filter_fields(ticks, fields):
            elem = SubElement(root, "tick")
            for f in fields:
                child = SubElement(elem, f)
                val = t.get(f)
                child.text = str(val) if val is not None else ""
        return tostring(root, encoding="unicode", xml_declaration=True).encode("utf-8")


class SQLSerializer(Serializer):
    id = "sql"
    display_name = "SQL"
    extension = "sql"
    mime_type = "application/sql"
    available = True
    description = "CREATE TABLE + INSERT statements"
    category = "Database"

    def serialize(self, ticks, fields):
        lines = []
        col_defs = ", ".join(f'"{f}" TEXT' for f in fields)
        lines.append(f"CREATE TABLE IF NOT EXISTS ticks ({col_defs});")
        lines.append("")
        for row in _filter_fields(ticks, fields):
            vals = ", ".join(
                f"'{str(v).replace(chr(39), chr(39)*2)}'" if v is not None else "NULL"
                for v in [row.get(f) for f in fields]
            )
            lines.append(f"INSERT INTO ticks ({', '.join(fields)}) VALUES ({vals});")
        return "\n".join(lines).encode("utf-8")


class JSONSerializer(Serializer):
    id = "json"
    display_name = "JSON"
    extension = "json"
    mime_type = "application/json"
    available = True
    description = "JSON array of tick objects"
    category = "Structured"

    def serialize(self, ticks, fields):
        data = _filter_fields(ticks, fields)
        return json.dumps(data, indent=2, default=str).encode("utf-8")


class JSONLSerializer(Serializer):
    id = "jsonl"
    display_name = "JSONL"
    extension = "jsonl"
    mime_type = "application/x-ndjson"
    available = True
    description = "One JSON object per line (AI/dataset friendly)"
    category = "AI/Dataset"

    def serialize(self, ticks, fields):
        lines = [json.dumps(row, default=str) for row in _filter_fields(ticks, fields)]
        return "\n".join(lines).encode("utf-8")


class NDJSONSerializer(Serializer):
    id = "ndjson"
    display_name = "NDJSON"
    extension = "ndjson"
    mime_type = "application/x-ndjson"
    available = True
    description = "Newline-delimited JSON (AI/dataset friendly)"
    category = "AI/Dataset"

    def serialize(self, ticks, fields):
        lines = [json.dumps(row, default=str) for row in _filter_fields(ticks, fields)]
        return "\n".join(lines).encode("utf-8")


# ── YAML ───────────────────────────────────────────────────────────
class YAMLSerializer(Serializer):
    id = "yaml"
    display_name = "YAML"
    extension = "yaml"
    mime_type = "application/x-yaml"
    available = HAS_YAML
    description = "YAML format" + ("" if HAS_YAML else " (requires pyyaml)")
    category = "Structured"

    def serialize(self, ticks, fields):
        data = _filter_fields(ticks, fields)
        return yaml.dump(data, default_flow_style=False, allow_unicode=True).encode("utf-8")


# ── TOML ───────────────────────────────────────────────────────────
class TOMLSerializer(Serializer):
    id = "toml"
    display_name = "TOML"
    extension = "toml"
    mime_type = "application/toml"
    available = True
    description = "TOML document format"
    category = "Structured"

    def serialize(self, ticks, fields):
        lines = []
        for i, row in enumerate(_filter_fields(ticks, fields)):
            lines.append(f"[[ticks]]")
            for f in fields:
                val = row.get(f)
                if val is None:
                    lines.append(f'{f} = ""')
                elif isinstance(val, (int, float)):
                    lines.append(f"{f} = {val}")
                else:
                    s = str(val).replace("\\", "\\\\").replace('"', '\\"')
                    lines.append(f'{f} = "{s}"')
            lines.append("")
        return "\n".join(lines).encode("utf-8")


# ── Excel / ODS / Parquet / Arrow ─────────────────────────────────
class XLSXSerializer(Serializer):
    id = "xlsx"
    display_name = "XLSX"
    extension = "xlsx"
    mime_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    available = HAS_OPENPYXL
    description = "Excel spreadsheet" + ("" if HAS_OPENPYXL else " (requires openpyxl)")
    category = "Spreadsheet"

    def serialize(self, ticks, fields):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Ticks"
        ws.append(fields)
        for row in _rows(ticks, fields):
            ws.append([str(v) if v is not None else "" for v in row])
        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()


class ODSSerializer(Serializer):
    id = "ods"
    display_name = "ODS"
    extension = "ods"
    mime_type = "application/vnd.oasis.opendocument.spreadsheet"
    available = HAS_ODF
    description = "OpenDocument Spreadsheet" + ("" if HAS_ODF else " (requires odfpy)")
    category = "Spreadsheet"

    def serialize(self, ticks, fields):
        doc = OpenDocumentSpreadsheet()
        table = Table(name="Ticks")
        # Header row
        header_row = TableRow()
        for f in fields:
            cell = TableCell(valuetype="string")
            cell.addElement(P(text=f))
            header_row.addElement(cell)
        table.addElement(header_row)
        # Data rows
        for row in _filter_fields(ticks, fields):
            tr = TableRow()
            for f in fields:
                val = row.get(f)
                cell = TableCell(valuetype="string")
                cell.addElement(P(text=str(val) if val is not None else ""))
                tr.addElement(cell)
            table.addElement(tr)
        doc.spreadsheet.addElement(table)
        buf = io.BytesIO()
        doc.save(buf)
        return buf.getvalue()


class ParquetSerializer(Serializer):
    id = "parquet"
    display_name = "Parquet"
    extension = "parquet"
    mime_type = "application/octet-stream"
    available = HAS_PYARROW
    description = "Apache Parquet columnar format (analytics/ML)" + ("" if HAS_PYARROW else " (requires pyarrow)")
    category = "Analytics"

    def serialize(self, ticks, fields):
        data = _filter_fields(ticks, fields)
        arrays = [pa.array([row.get(f) for row in data]) for f in fields]
        table = pa.table(dict(zip(fields, arrays)))
        buf = io.BytesIO()
        pq.write_table(table, buf)
        return buf.getvalue()


class FeatherSerializer(Serializer):
    id = "feather"
    display_name = "Feather"
    extension = "feather"
    mime_type = "application/octet-stream"
    available = HAS_PYARROW
    description = "Feather columnar format (fast I/O)" + ("" if HAS_PYARROW else " (requires pyarrow)")
    category = "Analytics"

    def serialize(self, ticks, fields):
        data = _filter_fields(ticks, fields)
        arrays = [pa.array([row.get(f) for row in data]) for f in fields]
        table = pa.table(dict(zip(fields, arrays)))
        buf = io.BytesIO()
        writer = pa.ipc.new_file(buf, table.schema)
        writer.write_table(table)
        writer.close()
        return buf.getvalue()


class ArrowIPCSerializer(Serializer):
    id = "arrow_ipc"
    display_name = "Arrow IPC"
    extension = "arrow"
    mime_type = "application/octet-stream"
    available = HAS_PYARROW
    description = "Apache Arrow IPC format (zero-copy)" + ("" if HAS_PYARROW else " (requires pyarrow)")
    category = "Analytics"

    def serialize(self, ticks, fields):
        data = _filter_fields(ticks, fields)
        arrays = [pa.array([row.get(f) for row in data]) for f in fields]
        table = pa.table(dict(zip(fields, arrays)))
        buf = io.BytesIO()
        writer = pa.ipc.new_file(buf, table.schema)
        writer.write_table(table)
        writer.close()
        return buf.getvalue()


# ── Avro ───────────────────────────────────────────────────────────
class AvroSerializer(Serializer):
    id = "avro"
    display_name = "Avro"
    extension = "avro"
    mime_type = "application/octet-stream"
    available = HAS_FASTAVRO
    description = "Apache Avro binary format (big data)" + ("" if HAS_FASTAVRO else " (requires fastavro)")
    category = "Analytics"

    def serialize(self, ticks, fields):
        schema = fastavro.parse_schema({
            "type": "record",
            "name": "Tick",
            "fields": [
                {"name": f, "type": ["null", "string"], "default": None}
                for f in fields
            ],
        })
        records = []
        for row in _filter_fields(ticks, fields):
            records.append({f: str(row.get(f)) if row.get(f) is not None else None for f in fields})
        buf = io.BytesIO()
        fastavro.writer(buf, schema, records)
        return buf.getvalue()


# ── SQLite ─────────────────────────────────────────────────────────
class SQLiteSerializer(Serializer):
    id = "sqlite"
    display_name = "SQLite"
    extension = "db"
    mime_type = "application/x-sqlite3"
    available = True
    description = "SQLite database with ticks table"
    category = "Database"

    def serialize(self, ticks, fields):
        import os
        tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        tmp.close()
        try:
            conn = sqlite3.connect(tmp.name)
            cur = conn.cursor()
            col_defs = ", ".join(f'"{f}" TEXT' for f in fields)
            cur.execute(f"CREATE TABLE ticks ({col_defs})")
            for row in _rows(ticks, fields):
                cur.execute(
                    f"INSERT INTO ticks VALUES ({', '.join(['?']*len(fields))})",
                    [str(v) if v is not None else None for v in row],
                )
            conn.commit()
            conn.close()
            with open(tmp.name, "rb") as f:
                return f.read()
        finally:
            os.unlink(tmp.name)


# ── Compressed serializers ─────────────────────────────────────────
class ZIPSerializer(Serializer):
    id = "zip"
    display_name = "ZIP"
    extension = "zip"
    mime_type = "application/zip"
    available = True
    description = "ZIP archive (wraps other formats)"
    category = "Compressed"

    def __init__(self, inner_formats: list[str] | None = None):
        self.inner_formats = inner_formats or ["csv", "json", "jsonl"]

    def serialize(self, ticks, fields):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for fmt_id in self.inner_formats:
                ser = REGISTRY.get(fmt_id)
                if ser and ser.available:
                    data = ser.serialize(ticks, fields)
                    zf.writestr(f"data.{ser.extension}", data)
        return buf.getvalue()


class GZipSerializer(Serializer):
    id = "gzip"
    display_name = "GZIP"
    extension = "gz"
    mime_type = "application/gzip"
    available = True
    description = "GZIP compressed (wraps a single format)"
    category = "Compressed"

    def __init__(self, inner_format: str = "csv"):
        self.inner_format = inner_format

    def serialize(self, ticks, fields):
        ser = REGISTRY.get(self.inner_format)
        if not ser or not ser.available:
            raise ValueError(f"Inner format '{self.inner_format}' not available")
        raw = ser.serialize(ticks, fields)
        return gzip.compress(raw)


class JSONGZSerializer(Serializer):
    id = "json_gz"
    display_name = "JSON.GZ"
    extension = "json.gz"
    mime_type = "application/gzip"
    available = True
    description = "GZIP-compressed JSON"
    category = "Compressed"

    def serialize(self, ticks, fields):
        raw = json.dumps(_filter_fields(ticks, fields), indent=2, default=str).encode("utf-8")
        return gzip.compress(raw)


class CSVGZSerializer(Serializer):
    id = "csv_gz"
    display_name = "CSV.GZ"
    extension = "csv.gz"
    mime_type = "application/gzip"
    available = True
    description = "GZIP-compressed CSV"
    category = "Compressed"

    def serialize(self, ticks, fields):
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for row in _filter_fields(ticks, fields):
            w.writerow(row)
        return gzip.compress(buf.getvalue().encode("utf-8"))


class JSONLGZSerializer(Serializer):
    id = "jsonl_gz"
    display_name = "JSONL.GZ"
    extension = "jsonl.gz"
    mime_type = "application/gzip"
    available = True
    description = "GZIP-compressed JSONL (compact AI/dataset)"
    category = "Compressed"

    def serialize(self, ticks, fields):
        lines = [json.dumps(row, default=str) for row in _filter_fields(ticks, fields)]
        raw = "\n".join(lines).encode("utf-8")
        return gzip.compress(raw)


# ── Registry ───────────────────────────────────────────────────────
REGISTRY: dict[str, Serializer] = {}


def _register(ser: Serializer):
    REGISTRY[ser.id] = ser


# Register all formats (25 total)
_register(CSVSerializer())
_register(TSVSerializer())
_register(CSVBOMSerializer())
_register(TXTSerializer())
_register(MarkdownSerializer())
_register(HTMLSerializer())
_register(XMLSerializer())
_register(SQLSerializer())
_register(JSONSerializer())
_register(JSONLSerializer())
_register(NDJSONSerializer())
_register(YAMLSerializer())
_register(TOMLSerializer())
_register(XLSXSerializer())
_register(ODSSerializer())
_register(ParquetSerializer())
_register(FeatherSerializer())
_register(ArrowIPCSerializer())
_register(AvroSerializer())
_register(SQLiteSerializer())
_register(ZIPSerializer())
_register(GZipSerializer())
_register(JSONGZSerializer())
_register(CSVGZSerializer())
_register(JSONLGZSerializer())


# ── Dynamic availability check ─────────────────────────────────────
# Map of serializer ID -> (module_name, attr_name) for optional deps.
_DEP_MAP = {
    "xlsx": ("openpyxl", "openpyxl"),
    "ods": ("odf", "odf"),
    "parquet": ("pyarrow", "pyarrow"),
    "feather": ("pyarrow", "pyarrow"),
    "arrow_ipc": ("pyarrow", "pyarrow"),
    "avro": ("fastavro", "fastavro"),
    "yaml": ("yaml", "yaml"),
}


def _check_available(ser: Serializer) -> bool:
    """Check if a serializer's optional dependencies are actually importable at runtime."""
    dep = _DEP_MAP.get(ser.id)
    if not dep:
        return True
    module_name, _ = dep
    try:
        __import__(module_name)
        return True
    except ImportError:
        return False


# ── Public API ─────────────────────────────────────────────────────
def get_serializer(fmt: str) -> Serializer | None:
    return REGISTRY.get(fmt.lower().strip())


def available_formats() -> list[dict]:
    """Return metadata for all registered formats with live availability checks."""
    return [
        {
            "id": s.id,
            "displayName": s.display_name,
            "extension": s.extension,
            "mimeType": s.mime_type,
            "available": _check_available(s),
            "description": s.description,
            "category": s.category,
        }
        for s in REGISTRY.values()
    ]


def all_format_ids() -> list[str]:
    return [s.id for s in REGISTRY.values() if _check_available(s) and s.id not in ("zip", "gzip")]
