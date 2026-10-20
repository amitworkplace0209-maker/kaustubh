"""Central session manager — single source of truth for broker login state."""
from .session_manager import (  # noqa: F401
    session_manager,
    SESSION_STATES,
    VERSION as SESSION_MANAGER_VERSION,
)
