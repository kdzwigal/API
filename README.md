# Warszawski transport na żywo

Aplikacja webowa z mapą autobusów, tramwajów i przystanków. Zakres endpointów i schematów API jest oparty wyłącznie na `tram.txt`. Pojazdy odświeżają się co 10 sekund; po wybraniu przystanku aplikacja pobiera listę linii, a po wybraniu linii także rozkład odjazdów.

## Uruchomienie lokalne

```sh
python3 -m venv venv
source venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app:app --reload
```

Otwórz http://127.0.0.1:8000. Lokalnie backend odczytuje token ze zmiennej środowiskowej `WARSAW_API_TOKEN` albo z ignorowanego przez Git pliku `apiKey.txt`.

## Wdrożenie na Render

Plik `render.yaml` definiuje usługę. Po połączeniu repozytorium z Render, ustaw sekret `WARSAW_API_TOKEN` w ustawieniach usługi, używając tokenu ZTM. Nie dodawaj tokenu do plików śledzonych przez Git. Darmowa usługa może usypiać się po bezczynności.

## Zakres danych

Endpoint lokalizacji opisany w `tram.txt` zawiera przykłady tylko dla autobusów (`type: 1`) i tramwajów (`type: 2`). Plik wymienia metro i kolej/SKM wyłącznie w danych taborowych bez bieżących współrzędnych, więc aplikacja nie pokazuje ich markerów, dopóki nie będzie potwierdzonego zapytania lokalizacyjnego.
