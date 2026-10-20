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
        elif "select sender_id, recipient_id, title, body" in sql:
            self.row = self.s.get("existing")
        elif "join public.owned_item o" in sql:
            self.rows = list(self.s.get("existing_items", []))
        elif "where lower(c.name) = 'admin'" in sql:
            self.row = self.s.get("sender", (1,))
        elif "information_schema.columns" in sql:
            self.row = (3,)
        elif sql.startswith("insert into public.mail_message"):
            self.s.setdefault("mail", []).append(params)
        elif sql.startswith("insert into public.owned_item"):
            self.s.setdefault("items", []).append(params)
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
        with self.assertRaisesRegex(db.DbError, "admin"):
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

    def test_invalid_uuid_and_embedded_null_rejected(self):
        with self.assertRaises(db.DbError):
            db.send_gm_item_mail(12, [{"itemIndexId": 361, "amount": 1}],
                                 "GM礼包", "正文", "not-a-uuid")
        with self.assertRaises(db.DbError):
            self.send(title="a\x00b")
        self.assertNotIn("mail", self.state)


if __name__ == "__main__":
    unittest.main()
