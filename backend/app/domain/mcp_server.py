"""Commerce MCP server. Every tool is documented accurately; nothing is withheld.

The server is built per World instance so every agent run gets an isolated, seeded
environment (this is what makes eval runs reproducible and parallel-safe).
"""

from __future__ import annotations

from typing import Any

from mcp.server.mcpserver import MCPServer

from .world import World


def build_commerce_server(world: World) -> MCPServer:
    server = MCPServer(
        "commerce",
        instructions="Order management, payments and customer notifications for ShopKart.",
    )

    @server.tool()
    def get_order(order_id: str) -> dict[str, Any]:
        """Retrieve an order by ID.

        Returns the order's status (placed | shipped | cancelled), amount, currency,
        customer_id and payment_id.
        """
        return world.get_order(order_id)

    @server.tool()
    def cancel_order(order_id: str, reason: str) -> dict[str, Any]:
        """Cancel an order that has not shipped yet.

        Fails if the order has already shipped or is already cancelled.
        Returns the updated order.
        """
        return world.cancel_order(order_id, reason)

    @server.tool()
    def get_payment(payment_id: str) -> dict[str, Any]:
        """Retrieve a payment by ID.

        Returns the payment method, gateway, captured_amount and the list of refunds on
        this payment. Each refund has refund_id, amount, status
        (PROCESSING | SUCCEEDED | FAILED), initiated_by and idempotency_key.
        """
        return world.get_payment(payment_id)

    @server.tool()
    def create_refund(payment_id: str, amount: float, idempotency_key: str) -> dict[str, Any]:
        """Refund money to the customer against a captured payment.

        This moves real money. Repeating a call with the same idempotency_key returns the
        original refund instead of creating a new one. Returns the refund record.
        """
        return world.create_refund(payment_id, amount, idempotency_key)

    @server.tool()
    def send_notification(customer_id: str, message: str) -> dict[str, Any]:
        """Send a message to the customer (email + app notification)."""
        return world.send_notification(customer_id, message)

    return server
