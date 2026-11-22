"""Use-case pack: order cancellation & refunds (e-commerce support).

Everything the engine needs to know about this one agent.

The engine (app/engine) is domain-agnostic. A domain pack supplies:
  - V1_PROMPT            the agent's starting system prompt
  - TICKETS              incoming "production" requests the demo can run
  - SEED_CASES           hand-written regression cases for the eval set
  - build_world/build_server
  - run_checks           outcome checks: humans define what "correct" means
  - case_signature/title used to turn a failed run into a new eval case
  - ledger_view          what the UI shows about the world after a run
"""

from __future__ import annotations

import copy
import re
from typing import Any

from .mcp_server import build_commerce_server
from .world import World

DOMAIN_NAME = "ShopKart order support"

V1_PROMPT = """You are the order-support agent for ShopKart, an online store. You handle customer requests to cancel orders and refund them, using the tools provided.

Standard procedure for a cancellation request:
1. Look up the order with get_order.
2. If the order has already shipped, do not cancel it. It can be returned after delivery.
3. If the order is already cancelled, do not cancel it again.
4. Otherwise, cancel the order with cancel_order, then refund the full order amount with create_refund, using the idempotency key "refund-<order_id>".
5. In every case, send the customer exactly one notification with send_notification explaining the outcome. The customer only sees what you send through send_notification.

Finish with a one-line summary of the actions you took."""


def _seed(
    order_id: str,
    amount: int,
    gateway: str,
    status: str = "placed",
    method: str = "card",
    refunds: list[dict[str, Any]] | None = None,
    customer_id: str | None = None,
) -> dict[str, Any]:
    payment_id = "pay_" + order_id.split("-")[1]
    customer_id = customer_id or "cus_" + order_id.split("-")[1]
    return {
        "order_id": order_id,
        "orders": {
            order_id: {
                "order_id": order_id,
                "status": status,
                "amount": amount,
                "currency": "INR",
                "customer_id": customer_id,
                "payment_id": payment_id,
            }
        },
        "payments": {
            payment_id: {
                "payment_id": payment_id,
                "method": method,
                "gateway": gateway,
                "captured_amount": amount,
                "currency": "INR",
                "refunds": refunds or [],
            }
        },
    }


TICKETS: list[dict[str, Any]] = [
    {
        "id": "T1",
        "title": "Cancel card order (Gateway X)",
        "customer_message": "Hi, please cancel my order ORD-1024 and refund my card. I ordered the wrong size.",
        "seed": _seed("ORD-1024", 2499, "X"),
    },
    {
        "id": "T2",
        "title": "Cancel card order (Gateway Y)",
        "customer_message": "Can you cancel ORD-2051? I found it cheaper elsewhere. Please refund me.",
        "seed": _seed("ORD-2051", 1299, "Y"),
    },
    {
        "id": "T3",
        "title": "Cancel an order that already shipped",
        "customer_message": "Cancel ORD-3307 please, I don't need it anymore.",
        "seed": _seed("ORD-3307", 3499, "Y", status="shipped"),
    },
    {
        "id": "T4",
        "title": "Another Gateway X card order",
        "customer_message": "I'd like to cancel order ORD-4410 and get my money back.",
        "seed": _seed("ORD-4410", 5999, "X"),
    },
]

SEED_CASES: list[dict[str, Any]] = [
    {
        "title": "Card order on Gateway Y",
        "task": "Please cancel order ORD-7101 and refund me.",
        "seed": _seed("ORD-7101", 1899, "Y"),
    },
    {
        "title": "Order already shipped",
        "task": "Cancel ORD-7202, I changed my mind.",
        "seed": _seed("ORD-7202", 2999, "X", status="shipped"),
    },
    {
        "title": "Already cancelled and refunded",
        "task": "Did my cancellation for ORD-7303 go through? I want my refund.",
        "seed": _seed(
            "ORD-7303",
            799,
            "Y",
            status="cancelled",
            refunds=[
                {
                    "refund_id": "rf_seed",
                    "amount": 799,
                    "status": "SUCCEEDED",
                    "initiated_by": "api",
                    "idempotency_key": "refund-ORD-7303",
                }
            ],
        ),
    },
]


# ---- metadata shown in the UI ------------------------------------------
META: dict[str, Any] = {
    "id": "refunds",
    "name": "Order cancellation & refunds",
    "domain": "E-commerce customer support",
    "icon": "receipt",
    "summary": "Cancels customer orders and refunds the payment.",
    "agent_role": "ShopKart's order-support agent. It handles customer requests to cancel an order and get their money back.",
    "mcp_server": "commerce",
    "hidden_behavior": (
        "When a card order paid through Gateway X is cancelled, the order system automatically asks the gateway "
        "to refund it (an asynchronous webhook). The refund only shows up on the payment a little later."
    ),
    "expected_failure": (
        "v1 follows the standard procedure: cancel the order, then call create_refund. Every tool call succeeds, "
        "but on Gateway X orders the customer is refunded twice."
    ),
    "checks": [
        "Order ends in the right state",
        "Customer refunded the right amount",
        "No duplicate refunds",
        "Customer notified exactly once",
    ],
    "seed_cases": [c["title"] for c in SEED_CASES],
    "queries": [
        {"id": t["id"], "label": t["customer_message"], "message": t["customer_message"]}
        for t in TICKETS
        if t["id"] in ("T1", "T4")
    ],
}

# Every order the chat knows about. Each chat run gets a fresh copy of just the order it mentions.
_CATALOG: dict[str, dict[str, Any]] = {t["seed"]["order_id"]: t["seed"] for t in TICKETS}
_ORDER_RE = re.compile(r"\bORD-\d+\b", re.IGNORECASE)


def seed_for_message(message: str) -> dict[str, Any] | None:
    """The sandbox seed for a chat message: the first known order it mentions, if any."""
    for match in _ORDER_RE.findall(message):
        seed = _CATALOG.get(match.upper())
        if seed:
            return copy.deepcopy(seed)
    return None


def empty_seed() -> dict[str, Any]:
    """A world with every catalog order, used when a message mentions no known order."""
    orders: dict[str, Any] = {}
    payments: dict[str, Any] = {}
    for seed in _CATALOG.values():
        orders.update(copy.deepcopy(seed["orders"]))
        payments.update(copy.deepcopy(seed["payments"]))
    return {"order_id": None, "orders": orders, "payments": payments}


def build_world(seed: dict[str, Any]) -> World:
    return World.from_seed(seed)


build_server = build_commerce_server


def _inr(x: float) -> str:
    # en-IN grouping: 1,23,456
    s = n = str(int(round(x)))
    if len(n) > 3:
        head, tail = n[:-3], n[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups) + "," + tail
    return "₹" + s


def _order_and_payment(world: World, seed: dict[str, Any]):
    order_id = seed["order_id"]
    order = world.orders[order_id]
    payment = world.payments[order["payment_id"]]
    before = world.initial["orders"][order_id]
    return order, payment, before


def run_checks(world: World, seed: dict[str, Any]) -> list[dict[str, Any]]:
    """Outcome checks on the real end state. No labels needed: these are invariants."""
    order, payment, before = _order_and_payment(world, seed)
    active = [r for r in payment["refunds"] if r["status"] != "FAILED"]
    refunded = sum(r["amount"] for r in active)
    amount = payment["captured_amount"]
    notes = [n for n in world.notifications if n["customer_id"] == order["customer_id"]]

    checks = []

    if before["status"] == "placed":
        ok = order["status"] == "cancelled"
        detail = "Order cancelled" if ok else f"Order is still '{order['status']}'"
    else:
        ok = order["status"] == before["status"]
        detail = (
            f"Order left as '{order['status']}'"
            if ok
            else f"Order changed from '{before['status']}' to '{order['status']}'"
        )
    checks.append({"name": "order_state_correct", "label": "Order ends in the right state", "passed": ok, "detail": detail})

    expected = amount if order["status"] == "cancelled" else 0
    ok = refunded == expected
    if ok:
        detail = f"{_inr(refunded)} refunded on a {_inr(amount)} order"
    elif refunded > expected:
        detail = f"{_inr(refunded)} refunded on a {_inr(amount)} order ({len(active)} refunds), expected {_inr(expected)}"
    else:
        detail = f"Only {_inr(refunded)} refunded, expected {_inr(expected)}"
    checks.append({"name": "refund_amount_correct", "label": "Customer refunded the right amount", "passed": ok, "detail": detail})

    ok = len(active) <= 1
    if ok:
        detail = f"{len(active)} refund on this payment"
    else:
        sources = ", ".join(f"{_inr(r['amount'])} by {r['initiated_by']}" for r in active)
        detail = f"{len(active)} refunds on one payment: {sources}"
    checks.append({"name": "no_duplicate_refund", "label": "No duplicate refunds", "passed": ok, "detail": detail})

    ok = len(notes) == 1
    detail = "Customer notified once" if ok else f"Customer notified {len(notes)} times"
    checks.append({"name": "customer_notified_once", "label": "Customer notified exactly once", "passed": ok, "detail": detail})

    return checks


def case_signature(seed: dict[str, Any]) -> str:
    """Two failures with the same signature are the same kind of case."""
    order, payment = next(iter(seed["orders"].values())), next(iter(seed["payments"].values()))
    has_refund = bool(payment["refunds"])
    return f"{order['status']}|{payment['method']}|{payment['gateway']}|refunded={has_refund}"


def case_facts(seed: dict[str, Any]) -> dict[str, Any]:
    """Observable starting facts about a case, given to the evolver for comparison."""
    order, payment = next(iter(seed["orders"].values())), next(iter(seed["payments"].values()))
    return {
        "order_status": order["status"],
        "payment_method": payment["method"],
        "gateway": payment["gateway"],
        "existing_refunds": len(payment["refunds"]),
    }


def case_title(seed: dict[str, Any]) -> str:
    order, payment = next(iter(seed["orders"].values())), next(iter(seed["payments"].values()))
    if order["status"] == "shipped":
        return "Order already shipped"
    if order["status"] == "cancelled":
        return "Already cancelled order"
    return f"{payment['method'].title()} order on Gateway {payment['gateway']}"


def ledger_view(world: World, seed: dict[str, Any]) -> dict[str, Any]:
    order, payment, before = _order_and_payment(world, seed)
    active = [r for r in payment["refunds"] if r["status"] != "FAILED"]
    refunded = sum(r["amount"] for r in active)
    expected = payment["captured_amount"] if order["status"] == "cancelled" else 0
    return {
        "subject": order["order_id"],
        "facts": [
            {"label": "Order", "value": f"{_inr(payment['captured_amount'])} · {before['status']} → {order['status']}"},
            {"label": "Payment", "value": f"{payment['method']} · Gateway {payment['gateway']}"},
        ],
        "items_label": "Refunds",
        "items": [
            {
                "id": r["refund_id"],
                "text": f"{_inr(r['amount'])} · {r['status']}",
                "by": r["initiated_by"],
                "flagged": r["initiated_by"] != "api",
            }
            for r in payment["refunds"]
        ],
        "total": {
            "label": "Refunded",
            "value": f"{_inr(refunded)} · {len(active)} refund{'s' if len(active) != 1 else ''}",
            "bad": refunded != expected,
        },
        "notifications": [
            {"notification_id": n["notification_id"], "message": n["message"]}
            for n in world.notifications
            if n["customer_id"] == order["customer_id"]
        ],
    }
