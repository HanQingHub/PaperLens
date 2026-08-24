"""B14 心跳协议 worker 侧纯逻辑测试（免模型）。"""
import os
import time

from worker.run import HEARTBEAT_STALE_S, find_task, touch_heartbeat, write_result


def make_claimed(d, *, heartbeat_age=None):
    d.mkdir(parents=True, exist_ok=True)
    claimed = d / "task.claimed.json"
    claimed.write_text('{"paper_id": 1}', encoding="utf-8")
    if heartbeat_age is not None:
        hb = d / ".heartbeat"
        hb.write_text("hb", encoding="utf-8")
        old = time.time() - heartbeat_age
        os.utime(hb, (old, old))
    return claimed


def test_touch_heartbeat_creates_file(tmp_path):
    touch_heartbeat(tmp_path)
    assert (tmp_path / ".heartbeat").exists()


def test_find_task_skips_fresh_orphan_claim(tmp_path):
    """他人实例的活任务（心跳新鲜）不得抢占回收。"""
    make_claimed(tmp_path / "7", heartbeat_age=1.0)
    assert find_task(tmp_path) is None
    assert (tmp_path / "7" / "task.claimed.json").exists()


def test_find_task_recovers_stale_orphan_claim(tmp_path):
    make_claimed(tmp_path / "7", heartbeat_age=HEARTBEAT_STALE_S + 60)
    assert find_task(tmp_path) == tmp_path / "7" / "task.json"
    assert not (tmp_path / "7" / "task.claimed.json").exists()


def test_find_task_recovers_legacy_claim_without_heartbeat(tmp_path):
    """旧协议残留（无 .heartbeat）按陈旧处理，维持升级前回收语义。"""
    make_claimed(tmp_path / "7")
    assert find_task(tmp_path) == tmp_path / "7" / "task.json"


def test_write_result_clears_heartbeat(tmp_path):
    touch_heartbeat(tmp_path)
    write_result(tmp_path, "done", 3)
    assert (tmp_path / "result.json").exists()
    assert not (tmp_path / ".heartbeat").exists()
