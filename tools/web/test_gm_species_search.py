"""GM species lookup: fragments must match without knowing full Chinese names."""
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent))
from admin_lib import handlers_players


class SpeciesLookupTests(unittest.TestCase):
    def setUp(self):
        patcher=patch("admin_lib.dex_repo.pokemon_names", lambda:{
            4:"小火龙",5:"火恐龙",6:"喷火龙",25:"皮卡丘",94:"耿鬼",
            149:"快龙",150:"超梦",151:"梦幻"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def lookup(self, term):
        return handlers_players.player_species_search({"q":[term]})["species"]

    def test_single_chinese_character_matches_many(self):
        self.assertEqual([x["id"] for x in self.lookup("龙")],[4,5,6,149])

    def test_any_inner_substring(self):
        self.assertEqual(self.lookup("恐"),[{"id":5,"name":"火恐龙"}])
        self.assertEqual(self.lookup("卡丘"),[{"id":25,"name":"皮卡丘"}])

    def test_part_of_numeric_id(self):
        self.assertEqual(self.lookup("25"),[{"id":25,"name":"皮卡丘"}])

    def test_exact_id_first(self):
        self.assertEqual(self.lookup("25")[0]["id"],25)

    def test_empty_query_does_not_scan_all(self):
        self.assertEqual(self.lookup(""),[])


if __name__=="__main__":
    unittest.main()
