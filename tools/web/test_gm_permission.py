"""Offline, dependency-free GM permission regression tests. No real database connection."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from admin_lib import db, handlers_auth


class Cursor:
    def __init__(self, state):
        self.state = state
        self.rowcount = 0
        self.row = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, args):
        if "SELECT c.name, c.permission" in sql:
            self.row = self.state.get("role_row")
        elif "FROM public.account_context" in sql:
            self.row = (1,) if self.state.get("online") else None
        elif "UPDATE public.character SET permission" in sql:
            self.state["changed_to"] = args[0]
            self.rowcount = 1
        else:
            raise AssertionError("Unexpected SQL statement in GM permission test")
        return self

    def fetchone(self):
        return self.row


class Connection:
    def __init__(self, state):
        self.state = state
        self.cursor_instance = Cursor(state)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.state["commits"] = self.state.get("commits", 0) + 1


class RoleTests(unittest.TestCase):
    def call(self, state, character=12, role=7, name="qa"):
        with patch.object(db, "_connect", lambda: Connection(state)):
            return db.set_character_permission(character, role, name)

    def test_grant_gm_offline(self):
        state = {"role_row": ("qa", 3, 3)}
        self.assertEqual(self.call(state), 3)
        self.assertEqual(state["changed_to"], 7)
        self.assertEqual(state["commits"], 1)

    def test_revoke_gm_offline(self):
        state = {"role_row": ("qa", 7, 3)}
        self.assertEqual(self.call(state, role=3), 7)
        self.assertEqual(state["changed_to"], 3)

    def test_grant_admin_offline(self):
        state = {"role_row": ("qa", 3, 3)}
        self.assertEqual(self.call(state, role=10), 3)
        self.assertEqual(state["changed_to"], 10)

    def test_refuse_online(self):
        state = {"role_row": ("qa", 3, 3), "online": True}
        with self.assertRaises(db.DbError):
            self.call(state)
        self.assertNotIn("changed_to", state)

    def test_refuse_banned(self):
        state = {"role_row": ("qa", 3, 0)}
        with self.assertRaises(db.DbError):
            self.call(state)
        self.assertNotIn("changed_to", state)

    def test_refuse_wrong_confirmation(self):
        state = {"role_row": ("qa", 3, 3)}
        with self.assertRaises(db.DbError):
            self.call(state, name="other")
        self.assertNotIn("changed_to", state)

    def test_refuse_unlisted_levels(self):
        for level in (0, 1, 2, 4, 5, 8, 9, 11, True, "7"):
            with self.subTest(level=level):
                with self.assertRaises(db.DbError):
                    self.call({}, role=level)

    def test_refuse_invalid_character_id(self):
        with self.assertRaises(db.DbError):
            self.call({}, character=0)

    def test_password_change_handler_no_unbound_handler(self):
        with patch.object(handlers_auth.auth, "set_password") as change, \
                patch.object(handlers_auth, "_audit"):
            response = handlers_auth.api_change_password({"newPassword": "a-strong-pass"})
        change.assert_called_once_with("a-strong-pass")
        self.assertTrue(response["ok"])


if __name__ == "__main__":
    unittest.main()
