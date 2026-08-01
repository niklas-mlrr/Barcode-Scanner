import unittest

from protocol import RecentIds, valid_scan


class ProtocolTests(unittest.TestCase):
    def test_accepts_valid_scan(self):
        self.assertEqual(
            valid_scan({"v": 2, "type": "scan", "id": "abcdefgh", "value": "978-123"}),
            ("abcdefgh", "978-123"),
        )

    def test_rejects_untrusted_shape_and_controls(self):
        self.assertIsNone(valid_scan({"v": 2, "type": "scan", "id": "abcdefgh", "value": "x", "x": 1}))
        self.assertIsNone(valid_scan({"v": 2, "type": "scan", "id": "abcdefgh", "value": "x\n"}))

    def test_deduplicates_ids_with_a_bound(self):
        ids = RecentIds(limit=2)
        self.assertFalse(ids.seen("one"))
        self.assertTrue(ids.seen("one"))
        self.assertFalse(ids.seen("two"))
        self.assertFalse(ids.seen("three"))
        self.assertFalse(ids.seen("one"))


if __name__ == "__main__":
    unittest.main()
