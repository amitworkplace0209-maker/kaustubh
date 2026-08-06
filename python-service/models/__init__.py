"""Pydantic models for API request/response shapes."""
from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str
    service: str = "kaustubh-python-service"
    uptime_seconds: float
    sdk_loaded: bool


class StatusResponse(BaseModel):
    logged_in: bool
    session_active: bool
    websocket_connected: bool
    subscribed_symbols: int
    last_login_at: Optional[str] = None
    last_logout_at: Optional[str] = None
    reconnect_count: int = 0
    sdk_version: Optional[str] = None


class SessionResponse(BaseModel):
    logged_in: bool
    view_token_present: bool
    session_id_present: bool
    trade_token_present: bool
    # Only boolean flags — never expose actual tokens or credentials.
    user_id: Optional[str] = None
    exchanges: list[str] = Field(default_factory=list)
    products: list[str] = Field(default_factory=list)
    last_login_at: Optional[str] = None
    last_logout_at: Optional[str] = None
    login_count: int = 0


class SubscribeRequest(BaseModel):
    instrument_tokens: list[dict[str, Any]] = Field(default_factory=list)


class SubscribeResponse(BaseModel):
    ok: bool
    message: str
    count: int


class LoginResponse(BaseModel):
    ok: bool
    message: str


class LogoutResponse(BaseModel):
    ok: bool
    message: str


# ---- Trading models ----

class OrderRequest(BaseModel):
    exchange: str = "nse_cm"
    symbol: str
    token: str
    transaction_type: str  # BUY or SELL
    product: str = "MIS"  # MIS or CNC
    order_type: str = "MKT"  # MKT, L, SL, SL-M
    quantity: str = "1"
    price: str = "0"
    trigger_price: str = "0"
    disclosed_quantity: str = "0"
    validity: str = "DAY"
    amo: str = "NO"
    market_protection: str = ""


class ModifyOrderRequest(BaseModel):
    order_id: str
    exchange: str = "nse_cm"
    token: str = ""
    quantity: str = ""
    price: str = ""
    trigger_price: str = ""
    order_type: str = ""
    validity: str = ""
    disclosed_quantity: str = ""


class CancelOrderRequest(BaseModel):
    order_id: str


class SquareOffRequest(BaseModel):
    exchange: str = "nse_cm"
    token: str = ""
    product: str = "MIS"
    quantity: str = "0"
    position_type: str = ""


class SearchScripRequest(BaseModel):
    exchange: str = "nse_cm"
    search_text: str


class QuoteRequest(BaseModel):
    instrument_tokens: list[dict[str, Any]] = Field(default_factory=list)
    quote_type: str = "ltp"
    isIndex: bool = False
