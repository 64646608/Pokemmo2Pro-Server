"""GM Item.jsonc mirror display filtering; never writes player inventory or Item.bin."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from admin_lib import item_index


def item(item_id: int, name: str, *, region: int = 2, desc: str = "same",
         icon: int | None = None) -> dict:
    label_id = int(name.split("]")[0][1:]) if name.startswith("[") else item_id
    return {
        "itemIndexId": item_id, "name": name, "desc": desc,
        "regionIndexId": region,
        "iconId": icon if icon is not None else label_id,
        "nameLocalStringIndexId": 200000 + label_id,
        "descLocalStringIndexId": 100000 + label_id,
    }


class MirrorPickerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="gm-item-alias-test-")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "Item.jsonc"
        self.file_patch = patch.object(item_index, "ITEM_FILE", self.path)
        self.file_patch.start()
        self.addCleanup(self.file_patch.stop)
        item_index._CACHE = None
        item_index._CACHE_STAMP = 0
        item_index._ALIASES = {}

    def load(self, rows: list[dict]) -> None:
        self.path.write_text(json.dumps({"itemInfos": rows}, ensure_ascii=False), encoding="utf-8")
        item_index._CACHE = None

    def test_common_sprays_candy_and_potion_only_one_text_result(self) -> None:
        rows = []
        for base, name in [
            (5077, "黄金喷雾"), (5076, "白银喷雾"),
            (5079, "除虫喷雾"), (5050, "神奇糖果"),
            (5017, "伤药"),
        ]:
            rows.extend([item(base, f"[{base}]{name}"),
                         item(base + 1000, f"[{base}]{name}")])
        self.load(rows)
        for term, expected in [
            ("黄金喷雾", 5077), ("白银喷雾", 5076),
            ("除虫喷雾", 5079), ("神奇糖果", 5050),
            ("伤药", 5017),
        ]:
            matches = item_index.search(term)
            self.assertEqual([x["itemId"] for x in matches], [expected])
            self.assertEqual(matches[0]["aliasIds"], [expected + 1000])

    def test_numeric_lookup_keeps_legacy_id_without_rewriting(self) -> None:
        self.load([item(5077, "[5077]黄金喷雾"),
                   item(6077, "[5077]黄金喷雾")])
        result = item_index.search("6077")
        self.assertEqual(result[0]["itemId"], 6077)
        self.assertEqual(result[0]["aliasOf"], 5077)
        self.assertIn("需先验证", result[0]["aliasWarning"])
        self.assertEqual(item_index.item_name(6077), "[5077]黄金喷雾")
        self.assertTrue(item_index.exists(6077))

    def test_different_region_or_description_must_not_hide(self) -> None:
        self.load([item(5077, "[5077]黄金喷雾"),
                   item(6077, "[5077]黄金喷雾", region=10),
                   item(5050, "[5050]神奇糖果"),
                   item(6050, "[5050]神奇糖果", desc="different")])
        self.assertEqual([x["itemId"] for x in item_index.search("黄金喷雾")], [5077, 6077])
        self.assertEqual([x["itemId"] for x in item_index.search("神奇糖果")], [5050, 6050])

    def test_unverified_same_name_ids_are_retained(self) -> None:
        self.load([item(1132, "[5050]神奇糖果"),
                   item(1248, "[5050]神奇糖果", region=10),
                   item(5050, "[5050]神奇糖果"),
                   item(6050, "[5050]神奇糖果")])
        # 1132/1248 are not proved to be +1000 aliases.
        self.assertEqual([x["itemId"] for x in item_index.search("神奇糖果")],
                         [1132, 1248, 5050])

    def test_no_bracket_no_alias_and_search_limit(self) -> None:
        self.load([item(5001, "特殊道具"), item(6001, "特殊道具")])
        self.assertEqual([x["itemId"] for x in item_index.search("特殊", 1)], [5001])
        self.assertEqual([x["itemId"] for x in item_index.search("特殊")], [5001, 6001])
        self.assertEqual(item_index.search("特殊", 0), [])

    def test_cache_refresh_picks_up_file_changes(self) -> None:
        self.load([item(5077, "[5077]黄金喷雾")])
        self.assertEqual(len(item_index.search("黄金喷雾")), 1)
        self.load([item(5077, "[5077]黄金喷雾"),
                   item(6077, "[5077]黄金喷雾")])
        self.assertEqual(item_index.search("黄金喷雾")[0]["aliasIds"], [6077])


if __name__ == "__main__":
    unittest.main()
