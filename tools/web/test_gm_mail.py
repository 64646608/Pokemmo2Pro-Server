"""GM item mail contract: unit tests never connect to production PostgreSQL."""
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from admin_lib import db


class FakeCursor:
    def __init__(self, state):
        self.s = state
        self.row = None
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, query, params=None):
        sql = " ".join(query.split()).lower()
        self.s.setdefault("sql", []).append((sql, params))
        if "pg_advisory_xact_lock" in sql:
            self.row = (None,)
        elif "select c.id, c.name, a.login_permission" in sql:
            self.row = (12, "aa", 3)
        elif "select c.id, c.name, c.region_id" in sql:
            self.row = (12, "aa", 0, 4)
        elif "select recipient_id, title, body" in sql:
            self.row = self.s.get("existing_pokemon")
        elif "select pokemon_object_id from public.mail_pokemon_attachment" in sql:
            self.rows = list(self.s.get("existing_pokemon_attachments", []))
        elif "select id from public.container" in sql:
            self.row = (5,)
        elif "select sender_id, recipient_id, title, body" in sql:
            self.row = self.s.get("existing")
        elif "join public.owned_item o" in sql:
            self.rows = list(self.s.get("existing_items", []))
        elif "where lower(a.account_name) = 'qaadmin'" in sql:
            self.row = self.s.get("sender", (1,))
        elif "information_schema.columns" in sql:
            self.row = (3,)
        elif sql.startswith("insert into public.mail_message"):
            self.s.setdefault("mail", []).append(params)
        elif sql.startswith("insert into public.owned_item"):
            self.s.setdefault("items", []).append(params)
        elif sql.startswith("insert into public.pokemon"):
            self.s.setdefault("pokemon", []).append(params)
        elif sql.startswith("insert into public.mail_pokemon_attachment"):
            self.s.setdefault("pokemon_attachments", []).append(params)
        elif sql.startswith("insert into public.mail_item_attachment"):
            self.s.setdefault("attachments", []).append(params)
        else:
            raise AssertionError("Unexpected SQL: " + sql[:130])
        return self

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, state):
        self.s = state

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def cursor(self):
        return FakeCursor(self.s)

    def commit(self):
        self.s["commits"] = self.s.get("commits", 0) + 1


class GmMailTests(unittest.TestCase):
    def setUp(self):
        self.req = str(uuid.uuid4())
        self.state = {}
        self.patchers = [
            patch.object(db, "_connect", lambda: FakeConnection(self.state)),
            patch("admin_lib.item_index.exists", lambda id_: id_ in (361, 366)),
            patch("admin_lib.native_grant.max_stack", lambda id_: 99 if id_ == 361 else 1),
            patch("admin_lib.audit.record"),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    def send(self, entries=None, title="GM礼包", body="点击领取"):
        return db.send_gm_item_mail(12, entries if entries is not None else
                                    [{"itemIndexId": 361, "amount": 3}], title, body, self.req)

    def test_new_mail_is_one_atomic_mail_and_attachment(self):
        result = self.send()
        self.assertFalse(result["alreadySent"])
        self.assertEqual(result["recipient"], "aa")
        self.assertEqual(len(self.state["mail"]), 1)
        self.assertEqual(len(self.state["items"]), 1)
        self.assertEqual(len(self.state["attachments"]), 1)
        item = self.state["items"][0]
        self.assertEqual(item[1:4], (12, 361, 3))
        self.assertEqual(self.state["mail"][0][2], 12)
        self.assertEqual(self.state["attachments"][0][0], int(result["mailId"]))
        self.assertEqual(self.state["commits"], 1)

    def test_two_items_use_same_mail_id(self):
        result = self.send([{"itemIndexId": 361, "amount": 3},
                            {"itemIndexId": 366, "amount": 1}])
        self.assertEqual(len(self.state["mail"]), 1)
        self.assertEqual(len(self.state["items"]), 2)
        self.assertEqual(len(self.state["attachments"]), 2)
        self.assertEqual({x[0] for x in self.state["attachments"]},
                         {int(result["mailId"])})
        self.assertEqual({x[0] for x in self.state["items"]}.__len__(), 2)

    def test_retry_returns_existing_without_reinsertion(self):
        first = self.send()
        self.state["existing"] = (1, 12, "GM礼包", "点击领取")
        self.state["existing_items"] = [(361, 3)]
        self.state["mail"] = []
        self.state["items"] = []
        self.state["attachments"] = []
        second = self.send()
        self.assertEqual(first["mailId"], second["mailId"])
        self.assertTrue(second["alreadySent"])
        self.assertEqual(self.state["mail"], [])
        self.assertEqual(self.state["items"], [])

    def test_sender_must_exist(self):
        self.state["sender"] = None
        with self.assertRaisesRegex(db.DbError, "qaadmin"):
            self.send()
        self.assertNotIn("mail", self.state)

    def test_bad_payload_does_not_touch_database(self):
        for entries in (
            [], [{"itemIndexId": 361, "amount": 0}],
            [{"itemIndexId": 361, "amount": 1000}],
            [{"itemIndexId": 361, "amount": True}],
            [{"itemIndexId": 60000, "amount": 3}],
            [{"itemIndexId": 361, "amount": 1}] * 2,
            [{"itemIndexId": 999, "amount": 1}],
        ):
            with self.subTest(entries=entries), self.assertRaises(db.DbError):
                self.send(entries)
        self.assertEqual(self.state, {})

    def test_item_max_stack_rejected_before_database_access(self):
        with self.assertRaisesRegex(db.DbError, "单组最多"):
            self.send([{"itemIndexId": 361, "amount": 999}])
        with self.assertRaisesRegex(db.DbError, "单组最多"):
            self.send([{"itemIndexId": 366, "amount": 2}])
        self.assertEqual(self.state, {})

    def test_invalid_uuid_and_embedded_null_rejected(self):
        with self.assertRaises(db.DbError):
            db.send_gm_item_mail(12, [{"itemIndexId": 361, "amount": 1}],
                                 "GM礼包", "正文", "not-a-uuid")
        with self.assertRaises(db.DbError):
            self.send(title="a\x00b")
        self.assertNotIn("mail", self.state)



class GmPokemonMailTests(unittest.TestCase):
    def setUp(self):
        self.req = str(uuid.uuid4())
        self.state = {}
        def fake_native(owner_id, owner_name, species, level, object_id, mail_id, region, address):
            result = {
                "id": object_id, "trainer_id": owner_id, "container_id": mail_id,
                "container_position": 0, "dex_id": species, "personality_value": 1234,
                "original_trainer_id": owner_id, "ot_name": owner_name, "name": "",
                "level_value": level, "current_hp": 21, "exp": 125,
                "moves": [10, 45, 0, 0], "moves_pp": [35, 40, 0, 0],
                "can_remember_moves": [0]*4, "ev_values": [0]*6,
                "iv_values": [15]*6, "ability": 0, "ball_type": 3,
                "catch_address": address, "catch_level": level,
                "catch_region": region, "egg_value": 0, "hidden_power_type": -1,
                "current_select_particle_effect_type": -1, "is_shiny": False,
                "is_secret": False, "is_alpha": False, "particle_effects": [],
            }
            return result
        self.patchers = [
            patch.object(db, "_connect", lambda: FakeConnection(self.state)),
            patch("admin_lib.dex_repo.pokemon_names", lambda: {4: "小火龙", 25: "皮卡丘"}),
            patch("admin_lib.native_grant.generate_pokemon", fake_native),
            patch("admin_lib.audit.record"),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    def send(self, level=5, species=4):
        return db.send_gm_pokemon_mail(12, species, level, "GM 宝可梦礼物",
                                       "点击领取", self.req)

    def test_atomic_mail_and_native_pokemon(self):
        reply = self.send()
        self.assertFalse(reply["alreadySent"])
        self.assertEqual(self.state["commits"], 1)
        self.assertEqual(len(self.state["mail"]), 1)
        self.assertEqual(len(self.state["pokemon"]), 1)
        self.assertEqual(len(self.state["pokemon_attachments"]), 1)
        self.assertEqual(self.state["pokemon_attachments"][0][0], int(reply["mailId"]))
        self.assertEqual(self.state["pokemon_attachments"][0][1], int(reply["pokemonId"]))
        self.assertEqual(self.state["pokemon"][0][1], 12)

    def test_idempotent_retry_no_extra_mon(self):
        reply = self.send()
        self.state["existing_pokemon"] = (12, "GM 宝可梦礼物", "点击领取")
        self.state["existing_pokemon_attachments"] = [(int(reply["pokemonId"]),)]
        self.state["mail"] = []
        self.state["pokemon"] = []
        self.state["pokemon_attachments"] = []
        again = self.send()
        self.assertTrue(again["alreadySent"])
        self.assertFalse(self.state["pokemon"])
        self.assertFalse(self.state["mail"])

    def test_bad_species_and_level_rejected_before_db(self):
        for level, species in [(0, 4), (101, 4), (5, 0), (5, 8000)]:
            with self.subTest(level=level, species=species), self.assertRaises(db.DbError):
                self.send(level, species)
        self.assertFalse(self.state)



if __name__ == "__main__":
    unittest.main()
