import io
import json
import zipfile

from conftest import auth, register, upload_pdf


def build_backup(client, token, tmp_path, name="a.pdf"):
    paper = upload_pdf(client, token, tmp_path, name=name)
    client.post("/api/papers/{id}/annotations".replace("{id}", str(paper["id"])),
                json={"page_no": 0, "type": "sentence",
                      "anchor_json": json.dumps({"rects": [[1, 2, 3, 4]]}), "text": "批注"},
                headers=auth(token))
    client.post("/api/words", json={"lemma": "attention", "translation": "注意力",
                                    "paper_id": paper["id"], "sentence": "ctx"},
                headers=auth(token))
    client.post("/api/excerpts", json={"paper_id": paper["id"], "page_no": 1,
                                       "text": "excerpt text", "note": "n"},
                headers=auth(token))
    r = client.post("/api/backup/export", headers=auth(token))
    assert r.status_code == 200
    return paper, r.content


def test_export_zip_structure(client, tmp_path):
    token = register(client, "alice")
    paper, content = build_backup(client, token, tmp_path)
    zf = zipfile.ZipFile(io.BytesIO(content))
    names = zf.namelist()
    assert "data.json" in names
    assert f"files/{paper['file_hash']}.pdf" in names
    data = json.loads(zf.read("data.json"))
    assert data["user"]["username"] == "alice"
    assert len(data["tables"]["papers"]) == 1
    assert len(data["tables"]["words"]) == 1


def test_import_into_same_server_renames_username(client, tmp_path):
    token = register(client, "alice")
    paper, content = build_backup(client, token, tmp_path)
    files = {"zip_file": ("backup.zip", io.BytesIO(content), "application/zip")}
    r = client.post("/api/backup/import", files=files, headers=auth(token))
    assert r.status_code == 200, r.text
    report = r.json()["report"]
    assert report["username_renamed"] is True
    assert report["username"].startswith("alice")
    assert report["papers"] == 1
    assert report["words"] == 1
    assert report["annotations"] == 1

    # 新用户可登录且数据完整（密码哈希随备份迁移）
    from app.core.db import SessionLocal
    from app.models import Annotation, Paper, User

    db = SessionLocal()
    try:
        new_user = db.query(User).filter(User.username == report["username"]).one()
        imported_paper = (
            db.query(Paper).filter(Paper.user_id == new_user.id).one()
        )
        assert imported_paper.title == paper["title"]
        assert imported_paper.ocr_status == "none"
        anno = db.query(Annotation).filter(Annotation.paper_id == imported_paper.id).one()
        assert anno.text == "批注"
    finally:
        db.close()
    # 新账号登录可见
    r = client.post("/api/auth/login", json={"username": report["username"], "password": "secret123"})
    assert r.status_code == 200


def test_import_fresh_username_no_rename(client, tmp_path):
    token = register(client, "alice")
    _, content = build_backup(client, token, tmp_path)
    # 备份中的用户名改成服务器上不存在的 dave → 导入不改名
    src = zipfile.ZipFile(io.BytesIO(content))
    data = json.loads(src.read("data.json"))
    data["user"]["username"] = "dave"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("data.json", json.dumps(data, ensure_ascii=False))
        for n in src.namelist():
            if n != "data.json":
                zf.writestr(n, src.read(n))
    files = {"zip_file": ("backup.zip", io.BytesIO(buf.getvalue()), "application/zip")}
    r = client.post("/api/backup/import", files=files, headers=auth(token))
    assert r.status_code == 200
    report = r.json()["report"]
    assert report["username_renamed"] is False
    assert report["username"] == "dave"


def test_import_restores_physical_file(client, tmp_path):
    token = register(client, "alice")
    paper, content = build_backup(client, token, tmp_path)
    from app.core.config import get_settings

    phys = get_settings().files_dir / f"{paper['file_hash']}.pdf"
    assert phys.exists()
    phys.unlink()  # 模拟新装机无文件
    files = {"zip_file": ("backup.zip", io.BytesIO(content), "application/zip")}
    client.post("/api/backup/import", files=files, headers=auth(token))
    assert phys.exists()  # 从备份恢复物理文件


def test_import_rejects_non_zip(client):
    token = register(client)
    files = {"zip_file": ("x.txt", io.BytesIO(b"not a zip"), "text/plain")}
    r = client.post("/api/backup/import", files=files, headers=auth(token))
    assert r.status_code == 400


def test_backup_import_accepts_file_field(client, tmp_path):
    token = register(client, "alice2")
    _, content = build_backup(client, token, tmp_path)
    # 前端实际发送字段为 file
    files = {"file": ("backup.zip", io.BytesIO(content), "application/zip")}
    r = client.post("/api/backup/import", files=files, headers=auth(token))
    assert r.status_code == 200, r.text


def test_backup_import_uppercase_zip_ext(client, tmp_path):
    token = register(client, "alice3")
    _, content = build_backup(client, token, tmp_path)
    files = {"file": ("BACKUP.ZIP", io.BytesIO(content), "application/zip")}
    r = client.post("/api/backup/import", files=files, headers=auth(token))
    assert r.status_code == 200, r.text


def test_excerpts_crud_and_export(client, tmp_path):
    token = register(client)
    paper = upload_pdf(client, token, tmp_path)
    r = client.post("/api/excerpts", json={"paper_id": paper["id"], "page_no": 2,
                                           "text": "key sentence", "translation": "关键句", "note": "nb"},
                    headers=auth(token))
    assert r.status_code == 201
    eid = r.json()["id"]
    r = client.get("/api/excerpts", params={"paper_id": paper["id"]}, headers=auth(token))
    assert len(r.json()) == 1
    r = client.post("/api/excerpts/export", headers=auth(token))
    text = r.content.decode("utf-8")
    assert "key sentence" in text and "关键句" in text and "nb" in text
    r = client.delete(f"/api/excerpts/{eid}", headers=auth(token))
    assert r.status_code == 204
    assert client.get("/api/excerpts", headers=auth(token)).json() == []
