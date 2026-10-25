"""Structured logger with daily rotation and category routing."""
from __future__ import annotations

import logging
import logging.handlers
import os
from pathlib import Path

LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)

LEVELS = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "error": logging.ERROR,
}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        import json
        from datetime import datetime

        payload = {
            "ts": datetime.utcfromtimestamp(record.created).isoformat() + "Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        if hasattr(record, "category"):
            payload["category"] = record.category
        if hasattr(record, "meta"):
            payload["meta"] = record.meta
        return json.dumps(payload)


def _make_logger(name: str, filename: str, level: int) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(level)
    logger.propagate = False
    if logger.handlers:
        return logger
    handler = logging.handlers.TimedRotatingFileHandler(
        LOG_DIR / filename, when="midnight", backupCount=30, utc=True
    )
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    console = logging.StreamHandler()
    console.setFormatter(JsonFormatter())
    logger.addHandler(console)
    return logger


def get_log_level() -> int:
    from config.settings import settings
    return LEVELS.get(settings.log_level.lower(), logging.INFO)


_base_level = get_log_level()

loggers = {
    "app": _make_logger("kaustubh.app", "app.log", _base_level),
    "login": _make_logger("kaustubh.login", "login.log", _base_level),
    "scheduler": _make_logger("kaustubh.scheduler", "scheduler.log", _base_level),
    "websocket": _make_logger("kaustubh.websocket", "websocket.log", _base_level),
    "reconnect": _make_logger("kaustubh.reconnect", "reconnect.log", _base_level),
    "performance": _make_logger("kaustubh.performance", "performance.log", _base_level),
    "error": _make_logger("kaustubh.error", "error.log", logging.ERROR),
}


def get(category: str) -> logging.Logger:
    return loggers.get(category, loggers["app"])

