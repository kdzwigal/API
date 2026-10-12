"""Backend proxy for the Warsaw transit map. API scope is defined by tram.txt."""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any

import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
API = "https://dane.um.warszawa.pl/api/action/"
TOKEN_PATH = ROOT / "apiKey.txt"
TIMEOUT = 12

app = FastAPI(title="Mapa komunikacji Warszawy")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = threading.Lock()
_fetch_locks: dict[str, threading.Lock] = {}


def api_token() -> str:
    token = os.getenv("WARSAW_API_TOKEN", "").strip()
    if not token and TOKEN_PATH.exists():
        token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    if not token:
        raise HTTPException(status_code=503, detail="Brak tokenu API. Ustaw WARSAW_API_TOKEN lub lokalnie apiKey.txt.")
    return token


def cached(key: str, ttl: int, loader):
    now = time.monotonic()
    with _cache_lock:
        entry = _cache.get(key)
        if entry and now - entry[0] < ttl:
            return entry[1]
        lock = _fetch_locks.setdefault(key, threading.Lock())
    with lock:
        now = time.monotonic()
        with _cache_lock:
            entry = _cache.get(key)
            if entry and now - entry[0] < ttl:
                return entry[1]
        value = loader()
        with _cache_lock:
            _cache[key] = (time.monotonic(), value)
        return value


def post(endpoint: str, body: dict | None = None) -> Any:
    try:
        response = requests.post(
            API + endpoint,
            headers={"Authorization": api_token(), "Content-Type": "application/json", "Accept": "application/json"},
            json=body,
            timeout=TIMEOUT,
        )
        response.raise_for_status()
        return response.json()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Błąd połączenia z API Warszawy ({endpoint}): {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"API Warszawy zwróciło niepoprawny JSON ({endpoint}).") from exc


def records(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("result", "results", "data", "items"):
            if isinstance(data.get(key), list):
                return data[key]
        return [data]
    return []


def values_record(row: Any) -> dict[str, Any]:
    """Convert ZTM [{key, value}, ...] records to ordinary dictionaries."""
    if isinstance(row, dict) and isinstance(row.get("values"), list):
        row = row["values"]
    if isinstance(row, list):
        result = {}
        for item in row:
            if isinstance(item, dict) and item.get("key"):
                result[item["key"]] = item.get("value")
        return result
    return row if isinstance(row, dict) else {}


def parse_stops(data: Any) -> list[dict[str, Any]]:
    rows = records(data)
    result = []
    # Some API variants wrap the stop list inside `result` or `values`.
    for row in rows:
        stop = values_record(row)
        if not stop and isinstance(row, dict) and isinstance(row.get("result"), list):
            stop = values_record(row["result"])
        if stop.get("zespol") and stop.get("slupek"):
            try:
                lat, lon = float(stop["szer_geo"]), float(stop["dlug_geo"])
            except (KeyError, TypeError, ValueError):
                continue
            result.append({
                "id": str(stop["zespol"]), "number": str(stop["slupek"]),
                "name": stop.get("nazwa_zespolu") or "Przystanek",
                "direction": stop.get("kierunek") or "", "lat": lat, "lon": lon,
            })
    return result


def load_vehicles() -> dict[str, Any]:
    bus = records(post("get_ztm_lokalizacja_pojazdow", {"type": 1}))
    tram = records(post("get_ztm_lokalizacja_pojazdow", {"type": 2}))
    return {"buses": bus, "trams": tram, "updated": time.time()}


def fleet_index() -> dict[str, dict[str, Any]]:
    data = post("get_ztm_pojazdy")
    if not isinstance(data, dict):
        return {}
    categories = {
        "busy": "Autobus", "tramwaje": "Tramwaj", "metro": "Metro", "kolej": "SKM / kolej",
    }
    result: dict[str, dict[str, Any]] = {}
    for category, label in categories.items():
        for item in data.get(category, []) if isinstance(data.get(category), list) else []:
            if isinstance(item, dict) and item.get("numerTaborowy") is not None:
                result[str(item["numerTaborowy"])] = {**item, "rodzaj": label}
    return result


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/vehicles")
def vehicles():
    live = cached("vehicles", 8, load_vehicles)
    # Fleet enrichment is optional: a temporary catalogue failure must not hide live positions.
    try:
        fleet = cached("fleet", 3600, fleet_index)
    except HTTPException:
        fleet = {}

    def normalize(rows: list[Any], kind: str):
        output = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            try:
                lat, lon = float(row["Lat"]), float(row["Lon"])
            except (KeyError, TypeError, ValueError):
                continue
            number = str(row.get("VehicleNumber", ""))
            details = fleet.get(number, {})
            output.append({
                "kind": kind, "line": str(row.get("Lines", "")), "lat": lat, "lon": lon,
                "time": row.get("Time"), "brigade": row.get("Brigade"),
                "vehicleNumber": number, "fleet": details,
            })
        return output

    return {"vehicles": normalize(live["buses"], "bus") + normalize(live["trams"], "tram"), "updated": live["updated"]}


@app.get("/api/stops")
def stops():
    data = cached("stops", 3600, lambda: parse_stops(post("get_ztm_przystanki_komunikacji_miejskiej")))
    return {"stops": data, "count": len(data)}


@app.get("/api/stops/{stop_id}/{stop_number}/lines")
def stop_lines(stop_id: str, stop_number: str):
    def load():
        payload = post("get_ztm_lista_linii_na_przystanku", {"busstopId": stop_id, "busstopNr": stop_number})
        lines = []
        for row in records(payload):
            parsed = values_record(row)
            line = parsed.get("linia")
            if line is not None and str(line) not in lines:
                lines.append(str(line))
        return lines
    return {"lines": cached(f"lines:{stop_id}:{stop_number}", 300, load)}


@app.get("/api/stops/{stop_id}/{stop_number}/departures")
def departures(stop_id: str, stop_number: str, line: str = Query(min_length=1, max_length=10)):
    def load():
        payload = post("get_ztm_odjazdy_linii_z_przystanku", {"busstopId": stop_id, "busstopNr": stop_number, "line": line})
        result = []
        for row in records(payload):
            departure = values_record(row)
            if departure:
                result.append(departure)
        return result
    return {"departures": cached(f"dep:{stop_id}:{stop_number}:{line}", 30, load)}


@app.get("/api/health")
def health():
    return {"status": "ok"}
