"""API package — re-exports all routers."""
from api.routes import router
from api.stocks import router as stocks_router
from api.ticks import router as ticks_router
from api.downloads import router as downloads_router
from api.statistics import router as statistics_router
from api.logs import router as logs_router
from api.system import router as system_router
from api.settings import router as settings_router
from api.trading import router as trading_router
from api.watchlist import router as watchlist_router
from api.notifications import router as notifications_router
from api.baskets import router as baskets_router

__all__ = [
    "router", "stocks_router", "ticks_router", "downloads_router",
    "statistics_router", "logs_router", "system_router", "settings_router",
    "trading_router", "watchlist_router", "notifications_router", "baskets_router",
]

