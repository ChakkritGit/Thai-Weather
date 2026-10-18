"""Private numerical worker, supervised by the Rust API (not an HTTP/ASGI server).

One request per Unix connection: u32 big-endian JSON length, then UTF-8 JSON.
Response: u32 metadata length, u32 body length, JSON metadata, then raw bytes.
The socket is mode 0600 inside the Rust process's private 0700 directory. No
URL forwarding, subprocess per request, base64 grids or public worker port.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import struct
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from ..config import get_settings
from . import products as p
from .runtime import Services
from .types import Context, Product, ProductError

log = logging.getLogger(__name__)
MAX_REQUEST = 2 << 20
MAX_BODY = 32 << 20
MAX_METADATA = 64 << 10
OBSERVATIONS = TypeAdapter(list[p.ObservationIn])


class Coordinates(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


# Explicit scientific operations, not arbitrary attribute/function dispatch.
OPS = {
    "health": (p.health, True, False),
    "meta": (p.meta, True, False),
    "static_layer": (p.static_layer, True, False),
    "point": (p.point, False, True),
    "forecast": (p.forecast, True, True),
    "air_forecast": (p.air_forecast, True, False),
    "air_stations": (p.air_stations, True, False),
    "provinces": (p.provinces, False, True),
    "province": (p.province, False, True),
    "alerts": (p.alerts, False, True),
    "ingest_observations": (p.ingest_observations, True, False),
    "trigger_run": (p.trigger_run, True, False),
    "nowcast": (p.nowcast, True, False),
    "nowcast_layer": (p.nowcast_layer, True, False),
    "nowcast_frames": (p.nowcast_frames, True, False),
    "nowcast_frame": (p.nowcast_frame, True, False),
    "nowcast_status": (p.nowcast_status, True, False),
    "push_public_key": (p.push_public_key, True, False),
    "push_subscribe": (p.push_subscribe, True, False),
    "push_unsubscribe": (p.push_unsubscribe, True, False),
    "push_status": (p.push_status, True, False),
}


def encode(result: Product | dict, status: int = 200) -> tuple[bytes, bytes]:
    if not isinstance(result, Product):
        result = Product(
            json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
            status_code=status,
            media_type="application/json",
        )
    headers = {k.lower(): v for k, v in result.headers.items()}
    if result.media_type:
        headers["content-type"] = result.media_type
    metadata = json.dumps({"status": result.status_code, "headers": headers}, separators=(",", ":")).encode()
    if len(metadata) > MAX_METADATA or len(result.body) > MAX_BODY:
        raise ValueError("numerical product exceeds transport limit")
    return metadata, result.body


def dispatch(state: Services, message: dict) -> tuple[bytes, bytes]:
    try:
        op = message.get("op")
        if not isinstance(op, str) or op not in OPS:
            raise ProductError(404, "unknown numerical operation")
        raw_args = message.get("args", {})
        if not isinstance(raw_args, dict):
            raise ProductError(422, "invalid numerical arguments")
        args = dict(raw_args)
        etag = message.get("if_none_match", "")
        if not isinstance(etag, str) or len(etag) > 512:
            raise ProductError(422, "invalid conditional tag")
        ctx = Context(state, {"if-none-match": etag})
        if op in ("point", "forecast", "nowcast"):
            args = Coordinates.model_validate(args).model_dump()
        elif op == "ingest_observations":
            args["items"] = OBSERVATIONS.validate_python(args.get("items"))
        elif op == "push_subscribe":
            args["body"] = p.PushSubscribe.model_validate(args.get("body"))
        elif op == "push_unsubscribe":
            args["body"] = p.PushSubscription.model_validate(args.get("body"))
        elif op == "trigger_run" and not state.settings.background_tasks:
            raise ProductError(503, "forecast scheduling is disabled in serve-only mode")
        func, needs_ctx, needs_run = OPS[op]
        if needs_ctx:
            args["ctx"] = ctx
        if needs_run:
            args["run"] = p.current_run(ctx)
        return encode(func(**args), status=202 if op == "trigger_run" else 200)
    except ValidationError as exc:
        # Do not echo subscription credentials or observations into errors/logs.
        errors = [{"loc": ["body", *e["loc"]], "type": e["type"], "msg": e["msg"]} for e in exc.errors()]
        return encode({"detail": errors}, 422)
    except ProductError as exc:
        return encode({"detail": exc.detail}, exc.status_code)
    except Exception:
        log.exception("numerical operation failed")
        return encode({"detail": "numerical service error"}, 500)


async def serve(path: Path, state: Services, stop: asyncio.Event) -> None:
    # Limit executor submissions as well as running work; no unbounded request queue.
    slots = asyncio.Semaphore(8)
    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="product")

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            async with asyncio.timeout(35):
                length = struct.unpack("!I", await reader.readexactly(4))[0]
                if length == 0 or length > MAX_REQUEST:
                    return
                message = json.loads(await reader.readexactly(length))
                if not isinstance(message, dict):
                    return
                if message.get("op") == "shutdown":
                    metadata, body = encode({"ok": True})
                    stop.set()
                else:
                    async with slots:
                        metadata, body = await asyncio.get_running_loop().run_in_executor(
                            pool, dispatch, state, message
                        )
                writer.write(struct.pack("!II", len(metadata), len(body)) + metadata + body)
                await writer.drain()
        except (ValueError, TimeoutError, asyncio.IncompleteReadError, ConnectionError):
            pass  # disconnected/invalid IPC clients never receive stack traces
        finally:
            writer.close()
            with suppress(ConnectionError, OSError):
                await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=str(path), backlog=16)
    os.chmod(path, 0o600)
    try:
        async with server:
            await stop.wait()
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
        path.unlink(missing_ok=True)


async def main(path: Path) -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    state = Services(get_settings())
    try:
        state.start()
        await serve(path, state, stop)
    finally:
        state.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m app.engine.worker /private/runtime/engine.sock")
    asyncio.run(main(Path(sys.argv[1])))
