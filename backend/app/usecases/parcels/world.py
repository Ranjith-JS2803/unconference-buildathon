"""Simulated logistics world: shipments, carrier claims, replacement parcels, notifications.

Everything is mocked. The hidden integration quirk (in no tool description):

    When a lost-parcel claim is filed for a SwiftShip shipment, SwiftShip automatically
    dispatches a replacement parcel (asynchronously, via webhook).

The webhook is delivered by settle(), which the engine calls once the agent has finished, so
even an agent that checks list_replacements right after filing sees nothing and creates its
own replacement: the customer gets two parcels.
"""

from __future__ import annotations

import copy
import itertools
from dataclasses import dataclass, field
from typing import Any

from mcp.server.mcpserver.exceptions import ToolError

AUTO_REPLACE_CARRIERS = {"SwiftShip"}


@dataclass
class World:
    shipments: dict[str, dict[str, Any]]
    replacements: dict[str, list[dict[str, Any]]]  # order_id -> replacement shipments
    notifications: list[dict[str, Any]] = field(default_factory=list)
    initial: dict[str, Any] = field(default_factory=dict)
    pending_webhooks: list[dict[str, Any]] = field(default_factory=list)
    _ids: Any = field(default_factory=lambda: itertools.count(1))

    @classmethod
    def from_seed(cls, seed: dict[str, Any]) -> "World":
        world = cls(shipments=copy.deepcopy(seed["shipments"]), replacements=copy.deepcopy(seed["replacements"]))
        world.initial = copy.deepcopy({"shipments": seed["shipments"], "replacements": seed["replacements"]})
        return world

    def _next_id(self, prefix: str) -> str:
        return f"{prefix}-{next(self._ids):04d}"

    def get_shipment(self, shipment_id: str) -> dict[str, Any]:
        s = self.shipments.get(shipment_id)
        if not s:
            raise ToolError(f"Shipment {shipment_id} not found.")
        return copy.deepcopy(s)

    def file_lost_claim(self, shipment_id: str, reason: str) -> dict[str, Any]:
        s = self.shipments.get(shipment_id)
        if not s:
            raise ToolError(f"Shipment {shipment_id} not found.")
        if s["status"] == "delivered":
            raise ToolError(f"Shipment {shipment_id} was delivered; a lost claim cannot be filed.")
        if s["status"] == "in_transit":
            raise ToolError(f"Shipment {shipment_id} is still in transit; it is not lost yet.")
        if s.get("claim"):
            raise ToolError(f"A lost claim was already filed for {shipment_id} ({s['claim']['claim_id']}).")
        s["claim"] = {"claim_id": self._next_id("CLM"), "reason": reason, "status": "OPEN"}

        # Hidden integration coupling: SwiftShip auto-dispatches a replacement (async).
        if s["carrier"] in AUTO_REPLACE_CARRIERS:
            self.pending_webhooks.append({"shipment_id": shipment_id})
        return copy.deepcopy(s["claim"])

    def list_replacements(self, order_id: str) -> list[dict[str, Any]]:
        return copy.deepcopy(self.replacements.get(order_id, []))

    def create_replacement(self, order_id: str, idempotency_key: str) -> dict[str, Any]:
        if not any(s["order_id"] == order_id for s in self.shipments.values()):
            raise ToolError(f"Order {order_id} not found.")
        existing = self.replacements.setdefault(order_id, [])
        for r in existing:
            if r["idempotency_key"] == idempotency_key:
                return copy.deepcopy(r)
        rep = {
            "replacement_id": self._next_id("RPL"),
            "status": "DISPATCHED",
            "initiated_by": "api",
            "idempotency_key": idempotency_key,
        }
        existing.append(rep)
        return copy.deepcopy(rep)

    def send_notification(self, customer_id: str, message: str) -> dict[str, Any]:
        note = {"notification_id": self._next_id("NT"), "customer_id": customer_id, "message": message}
        self.notifications.append(note)
        return {"notification_id": note["notification_id"], "status": "SENT"}

    def settle(self) -> list[str]:
        delivered = []
        for hook in self.pending_webhooks:
            s = self.shipments[hook["shipment_id"]]
            self.replacements.setdefault(s["order_id"], []).append(
                {
                    "replacement_id": self._next_id("RPL"),
                    "status": "DISPATCHED",
                    "initiated_by": "swiftship",
                    "idempotency_key": f"swiftship-claim-{hook['shipment_id']}",
                }
            )
            delivered.append(
                f"SwiftShip webhook delivered: replacement parcel dispatched for {s['order_id']} "
                f"(lost claim on {hook['shipment_id']})"
            )
        self.pending_webhooks.clear()
        return delivered

    def ledger(self) -> dict[str, Any]:
        return {
            "shipments": copy.deepcopy(self.shipments),
            "replacements": copy.deepcopy(self.replacements),
            "notifications": copy.deepcopy(self.notifications),
        }
