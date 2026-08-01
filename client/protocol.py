"""Pure protocol helpers for the authenticated barcode bridge v2."""

from __future__ import annotations

import re
from collections import OrderedDict
from typing import Any

_ID = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
_BARCODE = re.compile(r"^[ -~]{1,128}$")


def valid_scan(message: Any) -> tuple[str, str] | None:
    if not isinstance(message, dict) or set(message) != {"v", "type", "id", "value"}:
        return None
    scan_id, value = message.get("id"), message.get("value")
    if message.get("v") != 2 or message.get("type") != "scan":
        return None
    if not isinstance(scan_id, str) or not isinstance(value, str):
        return None
    if not _ID.fullmatch(scan_id) or not _BARCODE.fullmatch(value):
        return None
    return scan_id, value


class RecentIds:
    """Bounded de-duplication cache for re-delivered scan IDs."""

    def __init__(self, limit: int = 512) -> None:
        self._ids: OrderedDict[str, None] = OrderedDict()
        self._limit = limit

    def seen(self, scan_id: str) -> bool:
        if scan_id in self._ids:
            self._ids.move_to_end(scan_id)
            return True
        self._ids[scan_id] = None
        if len(self._ids) > self._limit:
            self._ids.popitem(last=False)
        return False
