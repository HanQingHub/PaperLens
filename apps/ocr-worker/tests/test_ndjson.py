"""blocks.ndjson 协议与解析单测（不加载 OCR 模型）。"""

import json

from worker import ndjson


def test_build_record_defaults():
    rec = ndjson.build_record(7, 3, 2.8, [{"bbox": [0, 0, 1, 1]}])
    assert rec["paper_id"] == 7
    assert rec["page"] == 3
    assert rec["page_rot"] == 0
    assert rec["format_version"] == 1
    assert rec["engine"] == ""


def test_build_record_page_rot_engine():
    rec = ndjson.build_record(7, 3, 2.8, [], page_rot=90, engine="rapidocr-3.9.2")
    assert rec["page_rot"] == 90
    assert rec["engine"] == "rapidocr-3.9.2"


def test_parse_ndjson_missing_file():
    assert ndjson.parse_ndjson("no/such.ndjson") == []


def test_parse_ndjson_skips_malformed(tmp_path):
    p = tmp_path / "blocks.ndjson"
    p.write_text(
        json.dumps({"paper_id": 1, "page": 0}) + "\n"
        + "{broken\n"
        + json.dumps({"paper_id": 1, "page": 2}) + "\n"
        + "\n",
        encoding="utf-8",
    )
    recs = ndjson.parse_ndjson(p)
    assert len(recs) == 2
    assert [r["page"] for r in recs] == [0, 2]


def test_read_done_pages(tmp_path):
    p = tmp_path / "blocks.ndjson"
    p.write_text(
        json.dumps({"paper_id": 1, "page": 1}) + "\n"
        + json.dumps({"paper_id": 1, "page": 3}) + "\n"
        + "garbage\n",
        encoding="utf-8",
    )
    assert ndjson.read_done_pages(p) == {1, 3}


def test_protocol_documented_fields():
    doc = ndjson.__doc__ or ""
    for field in ("paper_id", "page", "blocks", "page_rot", "format_version", "engine"):
        assert field in doc