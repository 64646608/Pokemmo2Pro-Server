"""Fail-closed bridge to the original GAME resource loaders. No DB calls in Java."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading

from .paths import RESOURCE_ROOT

GAME = Path(os.environ.get("GM_GAME_ROOT", "/home/gha-runner/pokemmo-game/patched-server"))
NATIVE = Path(__file__).resolve().parent.parent / "native"
CLASSES = NATIVE / "classes"
_LOCK = threading.Lock()
_CACHE_KEY: tuple[str, int] | None = None
_LIMITS: dict[int, int] = {}


def _command(*args: str, timeout: int = 35) -> str:
    jar = GAME / "server.game/build/install/server.game/lib/server.game.jar"
    libs = jar.parent
    klass = CLASSES / "GmNativeGrant.class"
    if not jar.is_file() or not klass.is_file():
        raise ValueError("GAME 原生道具/宝可梦生成组件未安装，请联系管理员")
    cmd = ["java", "-cp", f"{CLASSES}:{jar}:{libs}/*", "GmNativeGrant", *args]
    output = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    if output.returncode:
        raise ValueError("GAME 原生资源处理失败，请检查道具或宝可梦编号")
    lines = [line.strip() for line in output.stdout.splitlines() if line.strip()]
    if not lines:
        raise ValueError("GAME 原生组件未返回数据")
    return lines[-1]


def stack_limits() -> dict[int, int]:
    global _CACHE_KEY, _LIMITS
    binary = RESOURCE_ROOT / "item/Item.bin"
    if not binary.is_file():
        raise ValueError("GAME Item.bin 缺失，拒绝按统一 999 数量发放")
    stat = binary.stat()
    key = (str(binary.resolve()), stat.st_mtime_ns)
    with _LOCK:
        if _CACHE_KEY != key:
            parsed = json.loads(_command("item-limits", str(binary)))
            limits = {int(k): int(v) for k, v in parsed.items()
                      if 0 < int(k) <= 32767 and 0 < int(v) <= 32767}
            if len(limits) < 200:
                raise ValueError("GAME 道具上限字典不完整，拒绝发放")
            _LIMITS = limits
            _CACHE_KEY = key
        return dict(_LIMITS)


def max_stack(item_id: int) -> int:
    try:
        return stack_limits()[item_id]
    except KeyError as exc:
        raise ValueError(f"GAME 不支持道具编号 #{item_id}") from exc


def generate_pokemon(owner_id: int, owner_name: str, dex_id: int, level: int,
                     object_id: int, mail_container: int, region: int,
                     map_address: int) -> dict:
    raw = _command("pokemon", str(RESOURCE_ROOT), str(owner_id),
                   owner_name, str(dex_id), str(level), str(object_id),
                   str(mail_container), str(region), str(map_address), timeout=50)
    record = json.loads(raw)
    expected = {"id": object_id, "trainer_id": owner_id, "dex_id": dex_id,
                "level_value": level, "original_trainer_id": owner_id,
                "container_id": mail_container, "container_position": 0}
    for key, value in expected.items():
        if type(record.get(key)) is not int or record[key] != value:
            raise ValueError("GAME 原生生成结果的身份/等级不一致")
    for key, size in (("moves", 4), ("moves_pp", 4), ("can_remember_moves", 4),
                      ("iv_values", 6), ("ev_values", 6)):
        values = record.get(key)
        if not isinstance(values, list) or len(values) != size or any(type(v) is not int for v in values):
            raise ValueError(f"GAME 原生生成缺少 {key}")
    if not (0 < record.get("current_hp", 0) <= 32767 and record.get("exp", -1) >= 0):
        raise ValueError("GAME 原生生成 HP/经验非法")
    return record
