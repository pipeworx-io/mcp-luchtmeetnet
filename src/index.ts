interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Luchtmeetnet MCP — official Netherlands air quality (RIVM Luchtmeetnet, api.luchtmeetnet.nl)
 *
 * Tools:
 * - luchtmeetnet_stations: list/search NL air-quality measuring stations, or find the nearest to a lat/lon
 * - luchtmeetnet_measurements: recent pollutant measurements (NO2, PM10, PM2.5, O3, ...) for a station
 * - luchtmeetnet_air_quality_index: the Dutch LKI air-quality index (1-11) for a station or place
 *
 * Keyless. Upstream quirks (learned by probing 2026-07-16):
 * - Max start/end window is 7 days; omitting start/end triggers an HTTP 302
 *   with server-filled defaults — we always send explicit start/end.
 * - Rate limit: 100 requests per 5 minutes.
 * - The station LIST endpoint returns only {number, location}; coordinates
 *   live on the per-station DETAIL endpoint. To keep "nearest station"
 *   queries to a single upstream call we embed a coordinates snapshot
 *   (generated 2026-07-16 from /stations/{number}) and lazily fetch details
 *   for any station that appears later.
 * - Measurement rows carry no unit field; Luchtmeetnet reports concentrations
 *   in µg/m³ (hourly values).
 */


const BASE_URL = 'https://api.luchtmeetnet.nl/open_api';

const tools: McpToolExport['tools'] = [
  {
    name: 'luchtmeetnet_stations',
    description:
      'List and search official Netherlands air quality measuring stations (RIVM Luchtmeetnet). Filter by place or station name (Amsterdam, Rotterdam, Utrecht, Den Haag...), or pass latitude/longitude to get the nearest stations with distance. Returns station number (e.g. "NL49012"), location, and coordinates — the station number feeds luchtmeetnet_measurements and luchtmeetnet_air_quality_index. Example: luchtmeetnet_stations({ search: "Amsterdam" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: {
          type: 'string',
          description: 'Text filter on station location, e.g. "Amsterdam", "Rotterdam", "Utrecht", "Van Diemenstraat"',
        },
        latitude: {
          type: 'number',
          description: 'Latitude — together with longitude, returns stations sorted by distance (nearest first)',
        },
        longitude: {
          type: 'number',
          description: 'Longitude — together with latitude, returns stations sorted by distance (nearest first)',
        },
        limit: {
          type: 'number',
          description: 'Max stations to return, 1-102 (default 10)',
        },
      },
      required: [],
    },
  },
  {
    name: 'luchtmeetnet_measurements',
    description:
      'Get recent air pollution measurements from a Netherlands (RIVM Luchtmeetnet) measuring station: NO2, PM10, PM2.5 (PM25), ozone (O3), SO2, CO and more, hourly values in µg/m³. Station can be an NL number ("NL49012") or a Dutch place name ("Amsterdam", "Rotterdam") — the first matching station is used. Example: luchtmeetnet_measurements({ station: "Amsterdam", pollutant: "NO2", hours: 6 })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        station: {
          type: 'string',
          description: 'Station number like "NL49012", or a place/station name like "Amsterdam" or "Rotterdam-Pleinweg"',
        },
        pollutant: {
          type: 'string',
          description: 'Pollutant formula: NO2, PM10, PM25 (PM2.5), O3, NO, SO2, CO, NH3, C6H6... Omit for all pollutants the station measures',
        },
        hours: {
          type: 'number',
          description: 'How many hours back to fetch, 1-168 (default 6). Data updates hourly',
        },
      },
      required: ['station'],
    },
  },
  {
    name: 'luchtmeetnet_air_quality_index',
    description:
      'Get the official Dutch air quality index (LKI, Luchtkwaliteitsindex) for a Netherlands station or place — a 1-11 scale computed by RIVM from PM10, ozone and NO2: 1-3 good (goed), 4-6 moderate (matig), 7-8 poor (onvoldoende), 9-10 bad (slecht), 11 very bad (zeer slecht). Answers "how is the air quality in Amsterdam right now". Example: luchtmeetnet_air_quality_index({ station: "Rotterdam" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        station: {
          type: 'string',
          description: 'Station number like "NL49012", or a place name like "Amsterdam", "Rotterdam", "Utrecht"',
        },
      },
      required: ['station'],
    },
  },
];

// ---------------------------------------------------------------------------
// Fetch helper — 8s timeout, explicit params, actionable upstream errors
// ---------------------------------------------------------------------------

interface Paginated<T> {
  pagination?: { last_page: number; current_page: number; next_page: number };
  data: T[];
}

async function fetchJson<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'follow', // API 302-redirects when it adjusts start/end defaults
      headers: { accept: 'application/json' },
    });
    if (res.status === 429) {
      throw new Error(
        'Luchtmeetnet: rate-limit hit (the API allows 100 requests per 5 minutes). Wait a minute and retry.',
      );
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { message?: string; errors?: Array<{ field?: string; message?: string }> };
        detail = body.errors?.map((e) => `${e.field}: ${e.message}`).join('; ') || body.message || '';
      } catch {
        /* body was not JSON */
      }
      throw new Error(`Luchtmeetnet API error ${res.status} on ${path}${detail ? ` — ${detail}` : ''}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Luchtmeetnet API timed out after 8s on ${path}. The service updates hourly — retry shortly.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Station list — cached in-isolate (the list is small and changes rarely)
// ---------------------------------------------------------------------------

interface StationRef {
  number: string;
  location: string;
}

let stationCache: { at: number; list: StationRef[] } | null = null;
const STATION_TTL_MS = 6 * 60 * 60 * 1000;

async function loadStations(): Promise<StationRef[]> {
  if (stationCache && Date.now() - stationCache.at < STATION_TTL_MS) return stationCache.list;

  const list: StationRef[] = [];
  let page = 1;
  let lastPage = 1;
  do {
    const res = await fetchJson<Paginated<StationRef>>('/stations', { page: String(page) });
    list.push(...res.data);
    lastPage = Math.min(res.pagination?.last_page ?? 1, 10); // safety cap
    page += 1;
  } while (page <= lastPage);

  stationCache = { at: Date.now(), list };
  return list;
}

/**
 * Coordinates snapshot [lon, lat] per station, generated 2026-07-16 from
 * GET /stations/{number}. Coordinates only exist on the detail endpoint;
 * fetching ~102 details per "nearest" query would blow the upstream
 * 100-req/5-min budget, so nearest-station math runs off this snapshot.
 * Stations added upstream after the snapshot are detail-fetched lazily
 * (see coordCache) — at most a handful per query.
 */
const STATION_COORDS: Record<string, [number, number]> = {
  NL01484: [4.3125, 51.889],
  NL01485: [4.35524, 51.86742],
  NL01487: [4.48066, 51.89113],
  NL01488: [4.48759, 51.89361],
  NL01489: [4.58007, 51.86942],
  NL01491: [4.4307, 51.93858],
  NL01493: [4.46136, 51.92711],
  NL01494: [4.40139, 51.92139],
  NL01495: [4.22799, 51.93207],
  NL01496: [4.121944, 51.977802999084986],
  NL01497: [3.99972, 51.933517],
  NL01912: [4.563812, 51.861729],
  NL01913: [3.83859, 51.27938],
  NL10107: [6.042399, 51.11919],
  NL10131: [5.85307, 51.54052],
  NL10133: [5.881748, 50.90228],
  NL10136: [5.970496, 50.88796],
  NL10138: [5.986853, 50.90032],
  NL10230: [5.14845, 51.51844],
  NL10235: [4.359835, 51.43444],
  NL10236: [5.47235, 51.46866],
  NL10237: [5.444833, 51.44416],
  NL10240: [4.824944, 51.59353],
  NL10241: [4.781016, 51.60308],
  NL10246: [4.515271, 51.653729],
  NL10247: [5.393328, 51.407365],
  NL10248: [5.5433281, 51.69818779],
  NL10301: [3.916623, 51.634706],
  NL10318: [3.749484, 51.294498],
  NL10320: [3.7145, 51.70644],
  NL10404: [4.289185, 52.077148],
  NL10418: [4.479923, 51.914233],
  NL10437: [4.450529, 51.786579],
  NL10442: [4.708239, 51.800658],
  NL10444: [4.510817, 52.296556],
  NL10445: [4.315872, 52.075071],
  NL10446: [4.359376, 52.039023],
  NL10449: [4.329431, 51.914883],
  NL10450: [4.318551, 52.062537],
  NL10538: [5.048975, 52.80342],
  NL10552: [4.651789, 52.37029],
  NL10617: [5.59338, 52.423214],
  NL10633: [4.83819, 52.13795],
  NL10636: [5.124464, 52.105031],
  NL10639: [5.120507, 52.067748],
  NL10641: [4.987444, 52.20153],
  NL10643: [5.128183, 52.101308],
  NL10644: [4.923301, 51.974489],
  NL10722: [6.605367, 52.091801],
  NL10738: [5.708419, 52.111621],
  NL10741: [5.857777, 51.841372],
  NL10742: [5.856938, 51.838221],
  NL10807: [6.402919, 52.38833],
  NL10818: [6.017571, 52.654144],
  NL10821: [6.919494, 52.234504],
  NL10918: [5.573491, 52.916915],
  NL10929: [6.932432, 52.875725],
  NL10934: [6.276815, 53.330425],
  NL10937: [6.578901, 53.217796],
  NL10938: [6.608937, 53.246535],
  NL49002: [4.87575, 52.385422],
  NL49003: [4.943822, 52.389314],
  NL49007: [4.845233, 52.381331],
  NL49012: [4.887811, 52.389983],
  NL49014: [4.866208, 52.359714],
  NL49016: [4.870157, 52.393972],
  NL49017: [4.8997, 52.358039],
  NL49019: [4.9044, 52.372056],
  NL49020: [4.860319, 52.374786],
  NL49021: [4.988397, 52.320692],
  NL49022: [4.793344, 52.366811],
  NL49546: [4.83206, 52.42023],
  NL49551: [4.6018419999999995, 52.463039],
  NL49553: [4.601986, 52.493992],
  NL49556: [4.8617, 52.56359],
  NL49557: [4.599313, 52.490052],
  NL49561: [4.774006, 52.334003],
  NL49564: [4.71507132053375, 52.3274501787129],
  NL49565: [4.77082, 52.28013],
  NL49570: [4.640531, 52.489303],
  NL49572: [4.6288, 52.4744],
  NL49573: [4.579343, 52.478871],
  NL49680: [5.239257, 52.373572],
  NL49701: [4.816706, 52.448011],
  NL49703: [4.728581, 52.398437],
  NL49704: [4.773, 52.428],
  NL49980: [7.038925, 53.290343],
  NL50002: [5.81071, 50.96309],
  NL50003: [5.82224, 50.98445],
  NL50007: [5.6758, 50.85205],
  NL50010: [5.718977489396707, 50.841053234998604],
  NL50011: [5.771363, 51.303331],
  NL50012: [5.703113, 50.78366],
  NL50013: [5.773652, 50.905079],
  NL50014: [5.916794379061132, 50.75998070408913],
  NL53001: [4.3202367, 51.393289],
  NL53004: [4.623713, 51.699409],
  NL53015: [4.541659, 51.6689355],
  NL53016: [4.594882, 51.653205],
  NL53020: [4.583248, 51.713396],
  NL54004: [5.969485, 51.978328],
  NL54010: [5.897657, 51.962296],
};

const coordCache: Record<string, [number, number]> = { ...STATION_COORDS };

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface StationDetail {
  data: {
    location?: string;
    municipality?: string;
    type?: string;
    organisation?: string;
    components?: string[];
    geometry?: { coordinates?: [number, number] };
  };
}

async function fetchStationDetail(num: string): Promise<StationDetail['data']> {
  const res = await fetchJson<StationDetail>(`/stations/${encodeURIComponent(num)}`);
  const coords = res.data.geometry?.coordinates;
  if (coords && coords.length === 2) coordCache[num] = [coords[0], coords[1]];
  return res.data;
}

/**
 * Resolve a user-supplied station argument (NL number or place name) to
 * candidate stations, best match first. Throws an actionable error when
 * nothing matches.
 */
async function resolveStations(input: string): Promise<StationRef[]> {
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new Error(
      'Pass a station: an NL station number like "NL49012", or a Dutch place name like "Amsterdam". Use luchtmeetnet_stations to browse stations.',
    );
  }

  if (/^NL\d{3,6}$/i.test(raw)) {
    const num = raw.toUpperCase();
    const list = await loadStations();
    const known = list.find((s) => s.number === num);
    return [known ?? { number: num, location: num }];
  }

  const list = await loadStations();
  const q = raw.toLowerCase();
  const matches = list.filter((s) => s.location.toLowerCase().includes(q));
  // Prefer stations whose location *starts* with the query (city prefix),
  // e.g. "Amsterdam" → "Amsterdam-Van Diemenstraat" before "Oude Meer-...".
  matches.sort((a, b) => {
    const aStarts = a.location.toLowerCase().startsWith(q) ? 0 : 1;
    const bStarts = b.location.toLowerCase().startsWith(q) ? 0 : 1;
    return aStarts - bStarts || a.location.localeCompare(b.location);
  });

  if (matches.length === 0) {
    throw new Error(
      `No Luchtmeetnet station matches "${raw}". Station locations look like "Amsterdam-Van Diemenstraat" or "Rotterdam-Pleinweg" — try a Dutch city name, or call luchtmeetnet_stations({ search: "${raw}" }) / luchtmeetnet_stations({ latitude, longitude }) to find the nearest station number.`,
    );
  }
  return matches;
}

// Normalize pollutant input: "pm2.5" → "PM25", "no2" → "NO2", "pm 10" → "PM10"
function normalizeFormula(input: string): string {
  return String(input).toUpperCase().replace(/[\s.\-]/g, '');
}

// ISO timestamp helpers — the API wants explicit start/end (max 7-day window)
function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function isoHoursAhead(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function listStations(args: Record<string, unknown>) {
  const search = args.search != null ? String(args.search).trim() : '';
  const lat = typeof args.latitude === 'number' ? args.latitude : undefined;
  const lon = typeof args.longitude === 'number' ? args.longitude : undefined;
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 102);

  const all = await loadStations();
  let selected = all;
  if (search) {
    const q = search.toLowerCase();
    selected = all.filter((s) => s.location.toLowerCase().includes(q));
  }

  let note: string | undefined;
  if (lat !== undefined && lon !== undefined) {
    // Fill coordinates for stations missing from the snapshot (new stations) —
    // capped so one call can never approach the upstream rate limit.
    const missing = selected.filter((s) => !coordCache[s.number]).slice(0, 8);
    await Promise.all(
      missing.map((s) => fetchStationDetail(s.number).catch(() => undefined)),
    );
    const withCoords = selected.filter((s) => coordCache[s.number]);
    const skipped = selected.length - withCoords.length;
    if (skipped > 0) note = `${skipped} station(s) without known coordinates were left out of the distance ranking.`;

    const ranked = withCoords
      .map((s) => {
        const [slon, slat] = coordCache[s.number];
        return { ...s, slat, slon, distance_km: Math.round(haversineKm(lat, lon, slat, slon) * 10) / 10 };
      })
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, limit);

    return {
      count: ranked.length,
      total_stations: all.length,
      ...(search ? { search } : {}),
      origin: { latitude: lat, longitude: lon },
      stations: ranked.map((s) => ({
        number: s.number,
        location: s.location,
        latitude: s.slat,
        longitude: s.slon,
        distance_km: s.distance_km,
      })),
      ...(note ? { note } : {}),
    };
  }

  if (search && selected.length === 0) {
    return {
      count: 0,
      total_stations: all.length,
      search,
      stations: [],
      note: `No station location contains "${search}". Locations look like "Amsterdam-Van Diemenstraat" — try a shorter query or a nearby city, or pass latitude/longitude for a nearest-station search.`,
    };
  }

  const page = selected.slice(0, limit);
  return {
    count: page.length,
    total_stations: all.length,
    ...(search ? { search, matched: selected.length } : {}),
    stations: page.map((s) => {
      const c = coordCache[s.number];
      return {
        number: s.number,
        location: s.location,
        ...(c ? { latitude: c[1], longitude: c[0] } : {}),
      };
    }),
  };
}

interface MeasurementRow {
  station_number: string;
  formula: string;
  value: number;
  timestamp_measured: string;
}

async function fetchSeries(
  path: '/measurements' | '/lki',
  stationNumber: string,
  hours: number,
  formula?: string,
): Promise<MeasurementRow[]> {
  const rows: MeasurementRow[] = [];
  let page = 1;
  let lastPage = 1;
  do {
    const res = await fetchJson<Paginated<MeasurementRow>>(path, {
      station_number: stationNumber,
      ...(formula ? { formula } : {}),
      order_by: 'timestamp_measured',
      order_direction: 'desc',
      // Explicit window (max 7 days) — end slightly in the future so the
      // freshest just-published hourly value is always included.
      start: isoHoursAgo(hours),
      end: isoHoursAhead(2),
      page: String(page),
    });
    rows.push(...res.data);
    lastPage = Math.min(res.pagination?.last_page ?? 1, 6); // 100 rows/page → ≤600 rows
    page += 1;
  } while (page <= lastPage && rows.length < 600);
  return rows;
}

async function getMeasurements(args: Record<string, unknown>) {
  const hours = Math.min(Math.max(Number(args.hours) || 6, 1), 168);
  const formula = args.pollutant != null && String(args.pollutant).trim() !== ''
    ? normalizeFormula(String(args.pollutant))
    : undefined;

  const candidates = await resolveStations(String(args.station ?? ''));

  // Walk the matched stations until one has data — with a place-name arg the
  // alphabetically-first station may not measure the requested pollutant
  // (e.g. "Rotterdam" + PM25 first hits Geulhaven, a benzene/SO2 station).
  let station = candidates[0];
  let rows: MeasurementRow[] = [];
  for (const candidate of candidates.slice(0, 4)) {
    rows = await fetchSeries('/measurements', candidate.number, hours, formula);
    if (rows.length > 0) {
      station = candidate;
      break;
    }
  }

  if (rows.length === 0) {
    // Distinguish "wrong pollutant for this station" from "station quiet".
    let measured: string[] | undefined;
    try {
      measured = (await fetchStationDetail(station.number)).components;
    } catch {
      /* hint only */
    }
    const pollutantHint =
      formula && measured && !measured.includes(formula)
        ? `Station ${station.number} (${station.location}) measures [${measured.join(', ')}] — "${formula}" is missing from that list. Retry with one of those formulas, or pick another station via luchtmeetnet_stations.`
        : `No measurements returned for station ${station.number} (${station.location}) in the last ${hours}h${formula ? ` for ${formula}` : ''}.${measured ? ` The station measures [${measured.join(', ')}].` : ''} Data updates hourly; try a longer window (hours: 24) or another station via luchtmeetnet_stations.`;
    throw new Error(pollutantHint);
  }

  // Latest reading per pollutant (rows arrive newest-first).
  const latest: Record<string, { value: number; time: string }> = {};
  for (const r of rows) {
    if (!latest[r.formula]) latest[r.formula] = { value: r.value, time: r.timestamp_measured };
  }

  return {
    station_number: station.number,
    station_location: station.location,
    ...(candidates.length > 1
      ? { note: `"${args.station}" matched ${candidates.length} stations; using ${station.location}. Others: ${candidates.filter((c) => c.number !== station.number).slice(0, 3).map((c) => `${c.number} (${c.location})`).join(', ')}${candidates.length > 4 ? ', ...' : ''}` }
      : {}),
    ...(formula ? { pollutant: formula } : {}),
    hours,
    unit: 'µg/m³',
    count: rows.length,
    latest,
    measurements: rows.slice(0, 200).map((r) => ({
      time: r.timestamp_measured,
      formula: r.formula,
      value: r.value,
    })),
  };
}

/**
 * Official LKI banding (RIVM Luchtkwaliteitsindex, scale 1-11, computed
 * from PM10 + O3 + NO2): 1-3 goed, 4-6 matig, 7-8 onvoldoende,
 * 9-10 slecht, 11 zeer slecht.
 */
function lkiBand(value: number): { category: string; category_nl: string; color: string } {
  if (value <= 3) return { category: 'good', category_nl: 'goed', color: 'blue' };
  if (value <= 6) return { category: 'moderate', category_nl: 'matig', color: 'yellow' };
  if (value <= 8) return { category: 'poor', category_nl: 'onvoldoende', color: 'orange' };
  if (value <= 10) return { category: 'bad', category_nl: 'slecht', color: 'red' };
  return { category: 'very bad', category_nl: 'zeer slecht', color: 'purple' };
}

async function getAirQualityIndex(args: Record<string, unknown>) {
  const candidates = await resolveStations(String(args.station ?? ''));

  // LKI is computed for a subset of stations — when the argument was a place
  // name, walk the matches until one has LKI data.
  const tried: string[] = [];
  for (const station of candidates.slice(0, 4)) {
    const rows = await fetchSeries('/lki', station.number, 12);
    if (rows.length > 0) {
      const current = rows[0];
      const band = lkiBand(current.value);
      return {
        station_number: station.number,
        station_location: station.location,
        lki: current.value,
        ...band,
        measured_at: current.timestamp_measured,
        scale: 'LKI 1-11 (RIVM): 1-3 good/goed, 4-6 moderate/matig, 7-8 poor/onvoldoende, 9-10 bad/slecht, 11 very bad/zeer slecht',
        based_on: 'PM10, O3 and NO2 (hourly, computed by RIVM)',
        recent_hours: rows.slice(0, 6).map((r) => ({ time: r.timestamp_measured, lki: r.value })),
      };
    }
    tried.push(`${station.number} (${station.location})`);
  }

  throw new Error(
    `No LKI index published in the last 12h for ${tried.join(', ')}. The LKI is computed for a subset of stations — try a bigger city ("Amsterdam", "Rotterdam", "Utrecht") or find nearby stations via luchtmeetnet_stations({ latitude, longitude }).`,
  );
}

// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'luchtmeetnet_stations':
      return listStations(args);
    case 'luchtmeetnet_measurements':
      return getMeasurements(args);
    case 'luchtmeetnet_air_quality_index':
      return getAirQualityIndex(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
