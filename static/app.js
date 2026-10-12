const WARSAW = [52.2297, 21.0122];
const RADIUS = 1000;
const map = L.map('map', { zoomControl: false }).setView(WARSAW, 15);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
const vehicleLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);
const radiusLayer = L.layerGroup().addTo(map);
let allVehicles = [], allStops = [], anchor = WARSAW, userMarker = null;
let layerEnabled = { bus: true, tram: true, stops: true };
const statusEl = document.getElementById('status');
const toast = document.getElementById('toast');
let toastTimer;
function notify(message) { toast.textContent = message; toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.hidden = true, 4500); }
function escaped(text) { return String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function distance(a, b) {
  const rad = n => n * Math.PI / 180, dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const x = Math.sin(dLat/2)**2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon/2)**2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function inRadius(item) { return !document.getElementById('nearby').checked || !anchor || distance(anchor, [item.lat, item.lon]) <= RADIUS; }
function renderRadius() {
  radiusLayer.clearLayers();
  if (anchor) L.circle(anchor, { radius: RADIUS, color: '#37835e', weight: 1, dashArray: '5 6', fillColor: '#4b9a7040', fillOpacity: .07 }).addTo(radiusLayer);
  if (userMarker) userMarker.addTo(radiusLayer);
}
function vehiclePopup(v) {
  const kind = v.kind === 'bus' ? 'Autobus' : 'Tramwaj';
  const fleet = v.fleet || {};
  const fleetRows = ['marka','typ','rokProdukcji','nazwaOperatora','numerRejestracyjny'].filter(k => fleet[k] !== undefined && fleet[k] !== null && fleet[k] !== '').map(k => `<div><b>${escaped(({marka:'Marka',typ:'Typ',rokProdukcji:'Rok produkcji',nazwaOperatora:'Operator',numerRejestracyjny:'Rejestracja'})[k])}:</b> ${escaped(fleet[k])}</div>`).join('');
  return `<div class="popup-title">${kind} · linia ${escaped(v.line)}</div><div class="popup-body"><div><b>Numer taborowy:</b> ${escaped(v.vehicleNumber)}</div><div><b>Brygada:</b> ${escaped(v.brigade)}</div><div><b>Pozycja z:</b> ${escaped(v.time)}</div>${fleetRows}</div>`;
}
function stopPopup(s) {
  const key = `${s.id}/${s.number}`;
  return `<div class="popup-title">${escaped(s.name)}</div><div class="popup-body"><div><b>Kierunek:</b> ${escaped(s.direction || '—')}</div><div><b>Zespół / słupek:</b> ${escaped(s.id)} / ${escaped(s.number)}</div><div id="lines-${key}"><span class="small-loading">Pobieram linie…</span></div><div id="departures-${key}" class="departures"></div></div>`;
}
function addVehicle(v) {
  if (!layerEnabled[v.kind] || !inRadius(v)) return;
  const colorClass = v.kind === 'bus' ? 'bus' : 'tram';
  const icon = L.divIcon({ className: '', html: `<span class="vehicle-dot ${colorClass}"></span>`, iconSize: [16,16], iconAnchor: [8,8] });
  const marker = L.marker([v.lat,v.lon], {icon, keyboard:true}).bindPopup(vehiclePopup(v));
  marker.bindTooltip(escaped(v.line), { permanent:true, direction:'top', offset:[0,-8], className:'vehicle-label' });
  marker.addTo(vehicleLayer);
}
function addStop(s) {
  if (!layerEnabled.stops || !inRadius(s)) return;
  const icon = L.divIcon({ className:'', html:'<span class="stop-pin"></span>', iconSize:[14,14], iconAnchor:[7,7] });
  const marker = L.marker([s.lat,s.lon], {icon}).bindPopup(() => stopPopup(s));
  const label = `${s.name}${s.direction ? ' · ' + s.direction : ''}`;
  marker.bindTooltip(escaped(label), { permanent:true, direction:'right', offset:[7,0], className:'stop-label' });
  marker.on('popupopen', () => loadLines(s));
  marker.addTo(stopLayer);
}
function updateCount() {
  const shownVehicles = allVehicles.filter(v => layerEnabled[v.kind] && inRadius(v)).length;
  const shownStops = layerEnabled.stops ? allStops.filter(inRadius).length : 0;
  document.getElementById('count').textContent = `${shownVehicles} pojazdów · ${shownStops} przystanków w widoku`;
}
function draw() {
  vehicleLayer.clearLayers(); stopLayer.clearLayers();
  allVehicles.forEach(addVehicle); allStops.forEach(addStop);
  updateCount();
}
async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Błąd HTTP ${response.status}`);
  return body;
}
async function refreshVehicles() {
  try {
    const data = await fetchJson('/api/vehicles');
    allVehicles = data.vehicles || [];
    const date = new Date(data.updated * 1000);
    document.getElementById('updated').textContent = `Ostatnia aktualizacja ${date.toLocaleTimeString('pl-PL')}`;
    statusEl.textContent = 'Dane aktualne'; statusEl.parentElement.classList.remove('error');
    draw();
  } catch (e) {
    statusEl.textContent = 'Problem z pobraniem danych'; statusEl.parentElement.classList.add('error');
    notify(e.message);
  }
}
async function loadStops() {
  try {
    const data = await fetchJson('/api/stops'); allStops = data.stops || []; draw();
    updateCount();
  } catch (e) { notify(`Nie udało się pobrać przystanków: ${e.message}`); }
}
async function loadLines(stop) {
  const key = `${stop.id}/${stop.number}`, container = document.getElementById(`lines-${key}`);
  if (!container || container.dataset.loaded) return;
  container.dataset.loaded = '1';
  try {
    const data = await fetchJson(`/api/stops/${encodeURIComponent(stop.id)}/${encodeURIComponent(stop.number)}/lines`);
    container.innerHTML = `<div class="popup-subtitle">Linie odjeżdżające z przystanku</div><div class="line-list">${(data.lines || []).map(line => `<button class="line-button" data-line="${escaped(line)}">${escaped(line)}</button>`).join('') || '<span>Brak danych o liniach.</span>'}</div>`;
    container.querySelectorAll('.line-button').forEach(button => button.addEventListener('click', () => loadDepartures(stop, button.dataset.line, button)));
  } catch (e) { container.textContent = `Nie udało się pobrać linii: ${e.message}`; }
}
async function loadDepartures(stop, line, button) {
  const key = `${stop.id}/${stop.number}`, container = document.getElementById(`departures-${key}`);
  if (!container) return;
  container.innerHTML = '<div class="small-loading">Pobieram odjazdy…</div>';
  try {
    const data = await fetchJson(`/api/stops/${encodeURIComponent(stop.id)}/${encodeURIComponent(stop.number)}/departures?line=${encodeURIComponent(line)}`);
    const departures = data.departures || [];
    departures.sort((a,b) => String(a.czas || '').localeCompare(String(b.czas || '')));
    container.innerHTML = `<div class="popup-subtitle">Godziny z rozkładu · linia ${escaped(line)}</div>` + (departures.map(d => `<div class="departure"><strong>${escaped(d.czas || '—')}</strong>${escaped(d.kierunek || '')}${d.trasa ? ` · ${escaped(d.trasa)}` : ''}</div>`).join('') || '<div class="departure">Brak zaplanowanych odjazdów.</div>');
  } catch (e) { container.textContent = `Nie udało się pobrać odjazdów: ${e.message}`; }
}
function setLocation(lat, lon, zoom=15) {
  anchor = [lat,lon]; map.setView(anchor, zoom); userMarker = L.circleMarker(anchor, {radius:6,color:'#fff',weight:3,fillColor:'#286ba4',fillOpacity:1});
  renderRadius(); draw();
}
function requestLocation() {
  if (!navigator.geolocation) { notify('Ta przeglądarka nie udostępnia lokalizacji. Pokazuję centrum Warszawy.'); setLocation(...WARSAW); return; }
  navigator.geolocation.getCurrentPosition(pos => setLocation(pos.coords.latitude, pos.coords.longitude), () => {
    notify('Brak dostępu do lokalizacji. Pokazuję centrum Warszawy.'); setLocation(...WARSAW);
  }, {enableHighAccuracy:true, timeout:8000, maximumAge:60000});
}
document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', () => { layerEnabled[input.dataset.layer] = input.checked; draw(); }));
document.getElementById('nearby').addEventListener('change', draw);
document.getElementById('locate').addEventListener('click', requestLocation);
requestLocation(); renderRadius(); loadStops(); refreshVehicles();
setInterval(refreshVehicles, 10000);
