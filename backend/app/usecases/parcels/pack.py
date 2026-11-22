"""Use-case pack: lost-parcel replacement (logistics customer support)."""

from __future__ import annotations

import copy
import re
from typing import Any

from .mcp_server import build_logistics_server
from .world import World

V1_PROMPT = """You are the delivery-support agent for SwiftCart, an online store. You handle customer reports of parcels that have not arrived, using the tools provided.

Standard procedure for a missing-parcel request:
1. Look up the shipment with get_shipment.
2. If the shipment was delivered, do not file a claim. Tell the customer it shows as delivered and how to raise a dispute.
3. If the shipment is still in transit, do not file a claim. Tell the customer it is on its way.
4. If the shipment is lost: file a claim with file_lost_claim, then dispatch a replacement with create_replacement, using the idempotency key "replace-<shipment_id>".
5. In every case, send the customer exactly one notification with send_notification explaining the outcome. The customer only sees what you send through send_notification.

Finish with a one-line summary of the actions you took."""


def _seed(
    shipment_id: str,
    carrier: str,
    status: str = "lost",
    item: str = "Wireless headphones",
    value: int = 3499,
    claim: dict[str, Any] | None = None,
    replacements: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    num = shipment_id.split("-")[1]
    order_id, customer_id = f"SC-{num}", f"cus_{num}"
    return {
        "shipment_id": shipment_id,
        "shipments": {
            shipment_id: {
                "shipment_id": shipment_id,
                "order_id": order_id,
                "customer_id": customer_id,
                "carrier": carrier,
                "status": status,
                "item": item,
                "declared_value": value,
                "currency": "INR",
                "claim": claim,
            }
        },
        "replacements": {order_id: replacements or []},
    }


TICKETS: list[dict[str, Any]] = [
    {
        "id": "P1",
        "customer_message": "My package SHP-5521 never arrived, can you send a replacement?",
        "seed": _seed("SHP-5521", "SwiftShip", item="Running shoes", value=4299),
    },
    {
        "id": "P2",
        "customer_message": "Parcel SHP-7730 is lost, please replace it.",
        "seed": _seed("SHP-7730", "SwiftShip", item="Coffee grinder", value=2899),
    },
]

SEED_CASES: list[dict[str, Any]] = [
    {
        "title": "Lost parcel on ParcelGo",
        "task": "Shipment SHP-8101 is lost. Please send me a new one.",
        "seed": _seed("SHP-8101", "ParcelGo", item="Desk lamp", value=1899),
    },
    {
        "title": "Parcel already delivered",
        "task": "SHP-8202 never reached me, replace it please.",
        "seed": _seed("SHP-8202", "SwiftShip", status="delivered"),
    },
    {
        "title": "Parcel still in transit",
        "task": "Where is SHP-8303? I want a replacement.",
        "seed": _seed("SHP-8303", "ParcelGo", status="in_transit"),
    },
]

META: dict[str, Any] = {
    "id": "parcels",
    "name": "Lost-parcel replacement",
    "domain": "Logistics customer support",
    "icon": "package",
    "summary": "Files carrier claims for lost parcels and ships replacements.",
    "agent_role": "SwiftCart's delivery-support agent. It handles 'my parcel never arrived' requests: checks the shipment, files a lost claim with the carrier and ships a replacement.",
    "mcp_server": "logistics",
    "hidden_behavior": (
        "When a lost-parcel claim is filed for a SwiftShip shipment, SwiftShip automatically dispatches a "
        "replacement parcel (an asynchronous webhook). It only shows up on the order a little later."
    ),
    "expected_failure": (
        "v1 follows the standard procedure: file the claim, then call create_replacement. Every tool call "
        "succeeds, but on SwiftShip shipments the customer receives two replacement parcels."
    ),
    "checks": [
        "Claim handled correctly",
        "Exactly the right number of replacements",
        "No duplicate replacements",
        "Customer notified exactly once",
    ],
    "seed_cases": [c["title"] for c in SEED_CASES],
    "queries": [{"label": t["customer_message"], "message": t["customer_message"]} for t in TICKETS],
}

_CATALOG: dict[str, dict[str, Any]] = {t["seed"]["shipment_id"]: t["seed"] for t in TICKETS}
_SHIP_RE = re.compile(r"\bSHP-\d+\b", re.IGNORECASE)


def seed_for_message(message: str) -> dict[str, Any] | None:
    for match in _SHIP_RE.findall(message):
        seed = _CATALOG.get(match.upper())
        if seed:
            return _judged(copy.deepcopy(seed))
    return None


def empty_seed() -> dict[str, Any]:
    shipments: dict[str, Any] = {}
    replacements: dict[str, Any] = {}
    for seed in _CATALOG.values():
        shipments.update(copy.deepcopy(seed["shipments"]))
        replacements.update(copy.deepcopy(seed["replacements"]))
    return {"order_id": None, "shipment_id": None, "shipments": shipments, "replacements": replacements}


def _judged(seed: dict[str, Any]) -> dict[str, Any]:
    # The engine judges a run when seed["order_id"] is set; for this pack that's the shipment.
    seed["order_id"] = seed["shipment_id"]
    return seed


for _c in SEED_CASES:
    _judged(_c["seed"])


def build_world(seed: dict[str, Any]) -> World:
    return World.from_seed(seed)


build_server = build_logistics_server


def _inr(x: float) -> str:
    n = str(int(round(x)))
    if len(n) > 3:
        head, tail, groups = n[:-3], n[-3:], []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        n = ",".join(groups) + "," + tail
    return "₹" + n


def _parts(world: World, seed: dict[str, Any]):
    sid = seed["shipment_id"]
    s = world.shipments[sid]
    before = world.initial["shipments"][sid]
    reps = world.replacements.get(s["order_id"], [])
    before_reps = world.initial["replacements"].get(s["order_id"], [])
    return s, before, reps, before_reps


def run_checks(world: World, seed: dict[str, Any]) -> list[dict[str, Any]]:
    s, before, reps, before_reps = _parts(world, seed)
    new_reps = reps[len(before_reps):]
    notes = [n for n in world.notifications if n["customer_id"] == s["customer_id"]]
    lost = before["status"] == "lost"
    checks = []

    if lost:
        ok = bool(s.get("claim"))
        detail = "Lost claim filed with the carrier" if ok else "No lost claim was filed"
    else:
        ok = not s.get("claim")
        detail = f"No claim filed (parcel is {before['status'].replace('_', ' ')})" if ok else "A claim was filed for a parcel that is not lost"
    checks.append({"name": "claim_handled", "label": "Claim handled correctly", "passed": ok, "detail": detail})

    expected = 1 if lost and not before_reps else 0
    ok = len(new_reps) == expected
    if ok:
        detail = f"{len(new_reps)} replacement dispatched" if expected else "No replacement dispatched, as expected"
    elif len(new_reps) > expected:
        detail = f"{len(new_reps)} replacement parcels dispatched for one lost parcel ({_inr(s['declared_value'] * len(new_reps))} of stock), expected {expected}"
    else:
        detail = f"No replacement dispatched, expected {expected}"
    checks.append({"name": "replacement_count", "label": "Exactly the right number of replacements", "passed": ok, "detail": detail})

    ok = len(reps) <= 1
    detail = (
        f"{len(reps)} replacement on this order"
        if ok
        else f"{len(reps)} replacements on one order: " + ", ".join(f"{r['replacement_id']} by {r['initiated_by']}" for r in reps)
    )
    checks.append({"name": "no_duplicate_replacement", "label": "No duplicate replacements", "passed": ok, "detail": detail})

    ok = len(notes) == 1
    checks.append(
        {
            "name": "customer_notified_once",
            "label": "Customer notified exactly once",
            "passed": ok,
            "detail": "Customer notified once" if ok else f"Customer notified {len(notes)} times",
        }
    )
    return checks


def case_signature(seed: dict[str, Any]) -> str:
    s = next(iter(seed["shipments"].values()))
    reps = next(iter(seed["replacements"].values()), [])
    return f"{s['status']}|{s['carrier']}|claimed={bool(s.get('claim'))}|replaced={bool(reps)}"


def case_title(seed: dict[str, Any]) -> str:
    s = next(iter(seed["shipments"].values()))
    if s["status"] == "delivered":
        return "Parcel already delivered"
    if s["status"] == "in_transit":
        return "Parcel still in transit"
    return f"Lost parcel on {s['carrier']}"


def case_facts(seed: dict[str, Any]) -> dict[str, Any]:
    s = next(iter(seed["shipments"].values()))
    reps = next(iter(seed["replacements"].values()), [])
    return {"status": s["status"], "carrier": s["carrier"], "claim_filed": bool(s.get("claim")), "existing_replacements": len(reps)}


def ledger_view(world: World, seed: dict[str, Any]) -> dict[str, Any]:
    s, before, reps, before_reps = _parts(world, seed)
    new_reps = reps[len(before_reps):]
    expected = 1 if before["status"] == "lost" and not before_reps else 0
    return {
        "subject": s["shipment_id"],
        "facts": [
            {"label": "Shipment", "value": f"{s['item']} · {_inr(s['declared_value'])} · {s['carrier']}"},
            {"label": "Status", "value": before["status"].replace("_", " ")},
            {"label": "Claim", "value": s["claim"]["claim_id"] if s.get("claim") else "none"},
        ],
        "items_label": "Replacement shipments",
        "items": [
            {"id": r["replacement_id"], "text": r["status"], "by": r["initiated_by"], "flagged": r["initiated_by"] != "api"}
            for r in reps
        ],
        "total": {
            "label": "Replacements",
            "value": f"{len(new_reps)} parcel{'s' if len(new_reps) != 1 else ''} dispatched",
            "bad": len(new_reps) != expected,
        },
        "notifications": [
            {"notification_id": n["notification_id"], "message": n["message"]}
            for n in world.notifications
            if n["customer_id"] == s["customer_id"]
        ],
    }
