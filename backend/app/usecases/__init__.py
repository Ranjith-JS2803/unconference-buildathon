"""Use-case packs. Each pack plugs one agent into the Evolve engine.

A pack is a module exposing:
  META               id, name, domain, description, tools, hidden behaviour, checks, queries (for the UI)
  V1_PROMPT          the agent's starting system prompt
  SEED_CASES         hand-written regression cases: [{title, task, seed}]
  build_world(seed)  a fresh sandbox of the external systems
  build_server(world) the MCP server the agent talks to
  run_checks(world, seed)  outcome checks on the real end state (what "correct" means)
  ledger_view(world, seed) a generic view of the end state for the UI
  seed_for_message(msg) / empty_seed()  which sandbox a chat message runs in
  case_signature / case_title / case_facts  how a failed run becomes an eval case

Add a pack here and the engine, API and UI pick it up.
"""

from .parcels import pack as parcels
from .refunds import pack as refunds

PACKS = {p.META["id"]: p for p in (refunds, parcels)}
DEFAULT = "refunds"
