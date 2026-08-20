from pathlib import Path

from conftest import auth, register


def test_get_data_dir(client):
    token = register(client)
    r = client.get("/api/data-dir", headers=auth(token))
    assert r.status_code == 200
    assert "path" in r.json()


def test_migrate_validation(client, tmp_path):
    token = register(client)
    src = Path(__import__("os").environ["PAPERLENS_DATA_DIR"])
    # 空 target
    r = client.post("/api/data-dir/migrate", json={"target": "  "}, headers=auth(token))
    assert r.status_code == 400
    # 与当前相同
    r = client.post("/api/data-dir/migrate", json={"target": str(src)}, headers=auth(token))
    assert r.status_code == 400
    # 相对路径 / 无效盘
    r = client.post("/api/data-dir/migrate", json={"target": "relative/path"}, headers=auth(token))
    assert r.status_code == 400
    # 目标已存在且非空
    occupied = tmp_path / "occupied"
    occupied.mkdir()
    (occupied / "x").write_text("x")
    r = client.post("/api/data-dir/migrate", json={"target": str(occupied)}, headers=auth(token))
    assert r.status_code == 400


def test_migrate_success_copies_and_writes_registry(client, tmp_path, monkeypatch):
    import os

    from app.api import data_dir as data_dir_api

    token = register(client)
    src = Path(os.environ["PAPERLENS_DATA_DIR"])
    (src / "files" / "sample.pdf").write_bytes(b"%PDF-1.4 test")
    # 复制大目录成本高，monkeypatch 成只复制关键结构的最小实现太假；
    # 直接真实 copytree（测试数据目录只有几个小文件），仅 mock 注册表写入
    written = {}
    monkeypatch.setattr(data_dir_api, "_write_registry", lambda p: written.update(path=p))
    target = tmp_path / "new-data-dir"
    r = client.post("/api/data-dir/migrate", json={"target": str(target)}, headers=auth(token))
    assert r.status_code == 200, r.text
    assert written.get("path") == str(target)
    assert (target / "paperlens.db").exists()
    assert (target / "files" / "sample.pdf").read_bytes() == b"%PDF-1.4 test"
    # 幂等：已存在的目标再次迁移应被拒绝
    r = client.post("/api/data-dir/migrate", json={"target": str(target)}, headers=auth(token))
    assert r.status_code == 400