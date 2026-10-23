"""只读 PDD Item.jsonc 索引：保持原始 ID，GM 搜索折叠可证实的镜像显示条目。

只对同时满足以下条件的别名折叠：
1. 名称内的 [ID] 明确指向真实存在的规范条目；
2. 实际 ID 恰好比该规范 ID 大 1000；
3. 名称、描述、地区、图标、语言 ID 完全相同。
这只定义 GM 显示层优先项，并不假定 Item.bin 效果/客户端行为相同；
不修改物品、存档或真正的发放 ID。直接搜索数字别名仍然可查看。
"""

from __future__ import annotations

import re
import threading

from . import jsonc_io
from .paths import ITEM_FILE

_LOCK = threading.Lock()
_CACHE: dict[int, str] | None = None
_ALIASES: dict[int, int] = {}
_CACHE_STAMP: float = 0.0
_MIRROR_FIELDS = (
    "name", "desc", "regionIndexId", "iconId",
    "nameLocalStringIndexId", "descLocalStringIndexId",
)
_LABEL_ID = re.compile(r"^\[(\d+)\]")


def _get_mirrors(details: dict[int, dict]) -> dict[int, int]:
    """谨慎折叠 +1000 镜像，不合并仅仅同名的跨地区或不同效果条目。"""
    mirrors: dict[int, int] = {}
    for item_id, row in details.items():
        match = _LABEL_ID.match(str(row.get("name", "")))
        if match is None:
            continue
        canonical_id = int(match.group(1))
        if canonical_id <= 0 or item_id != canonical_id + 1000:
            continue
        canonical = details.get(canonical_id)
        if canonical is None:
            continue
        if all(row.get(field) == canonical.get(field) for field in _MIRROR_FIELDS):
            mirrors[item_id] = canonical_id
    return mirrors


def _load() -> dict[int, str]:
    global _CACHE, _CACHE_STAMP, _ALIASES
    with _LOCK:
        stamp = ITEM_FILE.stat().st_mtime_ns if ITEM_FILE.exists() else 0
        if _CACHE is None or stamp != _CACHE_STAMP:
            items: dict[int, str] = {}
            details: dict[int, dict] = {}
            if ITEM_FILE.exists():
                node = jsonc_io.loads(ITEM_FILE.read_text(encoding="utf-8"))
                for entry in node.value.get("itemInfos").value:
                    row = jsonc_io.to_plain(entry)
                    if not isinstance(row, dict):
                        continue
                    item_id = int(row["itemIndexId"])
                    items[item_id] = str(row.get("name", ""))
                    details[item_id] = row
            # Publish both snapshots together. Missing/broken metadata never
            # turns a different item into an alias.
            _ALIASES = _get_mirrors(details)
            _CACHE = items
            _CACHE_STAMP = stamp
        return _CACHE


def item_name(item_id: int) -> str | None:
    return _load().get(item_id)


def exists(item_id: int) -> bool:
    return item_id in _load()


def search(query: str, limit: int = 30) -> list[dict]:
    """普通文本搜索仅展示规范项；直接输入别名数字可查看原始项。"""
    items = _load()
    aliases = _ALIASES
    query = query.strip()
    if limit <= 0:
        return []
    results: list[dict] = []
    selected: set[int] = set()
    reverse: dict[int, list[int]] = {}
    for legacy, canonical in aliases.items():
        reverse.setdefault(canonical, []).append(legacy)

    def append(item_id: int) -> None:
        if item_id in selected or len(results) >= limit:
            return
        row: dict = {"itemId": item_id, "name": items[item_id]}
        if item_id in aliases:
            row["aliasOf"] = aliases[item_id]
            row["aliasWarning"] = "兼容编号，需先验证实际游戏效果"
        elif item_id in reverse:
            row["aliasIds"] = sorted(reverse[item_id])
        results.append(row)
        selected.add(item_id)

    if query.isdigit():
        exact = int(query)
        if exact in items:
            append(exact)
        for item_id in sorted(items):
            if len(results) >= limit:
                return results
            if item_id != exact and str(item_id).startswith(query):
                # 数字查询是高级精确定位模式，可显示所有原始别名。
                append(item_id)
    lowered = query.lower()
    if lowered:
        matches = [
            (item_id, name) for item_id, name in items.items()
            if lowered in name.lower() and item_id not in selected
            and (query.isdigit() or item_id not in aliases)
        ]
        matches.sort(key=lambda entry: (len(entry[1]), entry[0]))
        for item_id, _ in matches:
            if len(results) >= limit:
                break
            append(item_id)
    return results
