"""Logistics MCP server. Every tool is documented accurately; nothing is withheld."""

from __future__ import annotations

from typing import Any

from mcp.server.mcpserver import MCPServer

from .world import World


def build_logistics_server(world: World) -> MCPServer:
    server = MCPServer("logistics", instructions="Shipments, carrier claims and replacement parcels for SwiftCart.")

    @server.tool()
    def get_shipment(shipment_id: str) -> dict[str, Any]:
        """Retrieve a shipment by ID.

        Returns status (in_transit | delivered | lost), carrier, order_id, customer_id, item,
        declared_value and any lost claim already filed.
        """
        return world.get_shipment(shipment_id)

    @server.tool()
    def file_lost_claim(shipment_id: str, reason: str) -> dict[str, Any]:
        """File a lost-parcel claim with the carrier for a shipment marked lost.

        Fails if the shipment was delivered, is still in transit, or already has a claim.
        Returns the claim record.
        """
        return world.file_lost_claim(shipment_id, reason)

    @server.tool()
    def list_replacements(order_id: str) -> dict[str, Any]:
        """List replacement shipments created for an order.

        Each has replacement_id, status, initiated_by and idempotency_key.
        """
        return {"order_id": order_id, "replacements": world.list_replacements(order_id)}

    @server.tool()
    def create_replacement(order_id: str, idempotency_key: str) -> dict[str, Any]:
        """Dispatch a replacement parcel for an order from our warehouse.

        This ships a real item. Repeating a call with the same idempotency_key returns the
        original replacement instead of creating a new one.
        """
        return world.create_replacement(order_id, idempotency_key)

    @server.tool()
    def send_notification(customer_id: str, message: str) -> dict[str, Any]:
        """Send a message to the customer (email + app notification)."""
        return world.send_notification(customer_id, message)

    return server
