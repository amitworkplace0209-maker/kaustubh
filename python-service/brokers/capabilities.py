"""Broker capability model — what each terminal can actually do.

The UI exposes only supported capabilities. Everything here is static truth
derived from each adapter's real SDK surface (never guessed at runtime).
"""
from __future__ import annotations
from dataclasses import dataclass, field


@dataclass(frozen=True)
class BrokerCapabilities:
    terminal: str          # kotak | shoonya | dummy
    name: str              # display name
    mode_label: str        # short badge
    account_currency: str = "₹"
    virtual_currency: bool = False
    supports_market_orders: bool = True
    supports_limit_orders: bool = True
    supports_sl_orders: bool = True
    supports_modify_order: bool = True
    supports_cancel_order: bool = True
    supports_squareoff: bool = True
    supports_market_depth: bool = False
    supports_search: bool = True         # instrumental search API
    supports_order_stream: bool = True   # live order-update feed via broker WS
    supports_market_stream: bool = True  # live market-data feed via broker WS
    supports_historical_data: bool = True
    supports_basket: bool = True
    supports_margin_preview: bool = False   # real broker margin API (not an estimate)
    products: tuple[str, ...] = ("MIS", "CNC")
    order_types: tuple[str, ...] = ("MKT", "L", "SL", "SL-M")
    auth_flow: str = "credentials"       # credentials | oauth | simulated
    charges_model: str = "equity"        # none | equity (STT+b->s, etc.)

    def to_dict(self) -> dict:
        return {
            "terminal": self.terminal,
            "name": self.name,
            "modeLabel": self.mode_label,
            "accountCurrency": self.account_currency,
            "virtualCurrency": self.virtual_currency,
            "supportsMarketOrders": self.supports_market_orders,
            "supportsLimitOrders": self.supports_limit_orders,
            "supportsSlOrders": self.supports_sl_orders,
            "supportsModifyOrder": self.supports_modify_order,
            "supportsCancelOrder": self.supports_cancel_order,
            "supportsSquareoff": self.supports_squareoff,
            "supportsMarketDepth": self.supports_market_depth,
            "supportsSearch": self.supports_search,
            "supportsOrderStream": self.supports_order_stream,
            "supportsMarketStream": self.supports_market_stream,
            "supportsHistoricalData": self.supports_historical_data,
            "supportsBasket": self.supports_basket,
            "supportsMarginPreview": self.supports_margin_preview,
            "products": list(self.products),
            "orderTypes": list(self.order_types),
            "authFlow": self.auth_flow,
            "chargesModel": self.charges_model,
        }


class Capabilities:
    KOTAK = BrokerCapabilities(
        terminal="kotak",
        name="Kotak Neo",
        mode_label="KOTAK NEO",
        account_currency="₹",
        virtual_currency=False,
        supports_market_orders=True,
        supports_limit_orders=True,
        supports_sl_orders=True,
        supports_modify_order=True,
        supports_cancel_order=True,
        supports_squareoff=True,
        supports_market_depth=False,
        supports_order_stream=True,
        supports_market_stream=True,
        supports_historical_data=True,    # kotakneoapi 3.0.6 adds HistoricalDataAPI.get_historical_data()
        supports_basket=True,
        supports_margin_preview=True,     # SDK margin_required() = real broker margin
        products=("MIS", "CNC", "NRML", "CASH"),
        order_types=("MKT", "L", "SL", "SL-M"),
        auth_flow="credentials",
        charges_model="equity",
    )

    SHOONYA = BrokerCapabilities(
        terminal="shoonya",
        name="Shoonya",
        mode_label="SHOONYA",
        account_currency="₹",
        virtual_currency=False,
        supports_market_orders=True,
        supports_limit_orders=True,
        supports_sl_orders=True,
        supports_modify_order=True,
        supports_cancel_order=True,
        supports_squareoff=True,
        supports_market_depth=False,
        supports_order_stream=True,
        supports_market_stream=True,
        supports_historical_data=True,
        supports_basket=True,
        supports_margin_preview=False,
        products=("MIS", "CNC", "NRML", "CASH"),
        order_types=("MKT", "L", "SL", "SL-M"),
        auth_flow="oauth",
        charges_model="equity",
    )

    DUMMY = BrokerCapabilities(
        terminal="dummy",
        name="Dummy Mode",
        mode_label="DUMMY",
        account_currency="Coin",
        virtual_currency=True,
        supports_market_orders=True,
        supports_limit_orders=True,
        supports_sl_orders=True,
        supports_modify_order=True,
        supports_cancel_order=True,
        supports_squareoff=True,
        supports_market_depth=False,
        supports_order_stream=True,
        supports_market_stream=True,
        supports_historical_data=True,
        supports_basket=True,
        supports_margin_preview=False,
        products=("MIS", "CASH"),
        order_types=("MKT", "L", "SL", "SL-M"),
        auth_flow="simulated",
        charges_model="equity",
    )


_CAP_MAP: dict[str, BrokerCapabilities] = {
    c.terminal: c for c in (Capabilities.KOTAK, Capabilities.SHOONYA, Capabilities.DUMMY)
}


def capabilities_for(terminal: str) -> BrokerCapabilities:
    return _CAP_MAP.get((terminal or "").lower(), Capabilities.KOTAK)