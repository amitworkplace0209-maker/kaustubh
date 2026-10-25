import asyncio

_running_loop: asyncio.AbstractEventLoop | None = None


def set_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _running_loop
    _running_loop = loop


def get_loop() -> asyncio.AbstractEventLoop:
    if _running_loop is None:
        raise RuntimeError("Application event loop has not been initialized.")
    return _running_loop