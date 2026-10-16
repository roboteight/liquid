/**
 * Where the sun and moon are in the sky for a place and moment. These are the standard low-precision
 * almanac formulas: good to about a degree for the sun and a few degrees for the moon, which is plenty for
 * drawing a sky. Angles are in degrees unless a name says otherwise.
 */

const RAD = Math.PI / 180;
/** Mean length of a lunar month, and a known new moon (6 Jan 2000, 18:14 UT) to count from. */
const SYNODIC_MONTH = 29.530588853;
const NEW_MOON_JD = 2451550.1;
/** The sun's centre is at this altitude when its upper edge touches the horizon, allowing for refraction. */
export const HORIZON_ALTITUDE = -0.833;

export interface BodyPosition {
  /** Degrees above the horizon (negative below). */
  altitude: number;
  /** Degrees clockwise from north (90 = east, 180 = south, 270 = west). */
  azimuth: number;
}

export interface Sky {
  sun: BodyPosition;
  moon: BodyPosition;
  /** The lit fraction of the moon's face, 0 (new) to 1 (full). */
  moonIllumination: number;
  /** How far through the lunar month it is: 0 is new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  moonPhase: number;
}

export interface SunTimes {
  /** Hours since local midnight, or null when the sun doesn't cross the horizon that day (polar day or night). */
  rise: number | null;
  set: number | null;
  /** The hour the sun is highest. */
  noon: number;
  /** For polar regions: whether the sun stays up (true) or down (false) all day. */
  alwaysUp: boolean;
}

const mod = (x: number, m: number) => ((x % m) + m) % m;

function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Position of a point on the celestial sphere (right ascension and declination) as seen from a place. */
function horizontal(
  rightAscension: number,
  declination: number,
  jd: number,
  latitude: number,
  longitude: number,
): BodyPosition {
  const n = jd - 2451545;
  const gmst = mod(280.46061837 + 360.98564736629 * n, 360);
  const hourAngle = mod(gmst + longitude - rightAscension, 360) * RAD; // positive to the west of the meridian
  const lat = latitude * RAD;
  const dec = declination * RAD;
  const altitude = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle));
  const fromSouth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat));
  return { altitude: altitude / RAD, azimuth: mod(fromSouth / RAD + 180, 360) };
}

/** Right ascension and declination of a point on the ecliptic, given its longitude. */
function fromEcliptic(longitude: number, obliquity: number): { ra: number; dec: number } {
  const lon = longitude * RAD;
  const eps = obliquity * RAD;
  return {
    ra: mod(Math.atan2(Math.cos(eps) * Math.sin(lon), Math.cos(lon)) / RAD, 360),
    dec: Math.asin(Math.sin(eps) * Math.sin(lon)) / RAD,
  };
}

export function sky(date: Date, latitude: number, longitude: number): Sky {
  const jd = julianDay(date);
  const n = jd - 2451545;
  const meanLongitude = mod(280.46 + 0.9856474 * n, 360);
  const anomaly = mod(357.528 + 0.9856003 * n, 360) * RAD;
  const sunLongitude = meanLongitude + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly);
  const obliquity = 23.439 - 0.0000004 * n;

  const sunPoint = fromEcliptic(sunLongitude, obliquity);
  // The moon is the sun's ecliptic longitude plus its elongation: 0 at new moon, 180 at full (ignoring its
  // small orbital tilt and eccentricity).
  const age = mod(jd - NEW_MOON_JD, SYNODIC_MONTH);
  const elongation = (age / SYNODIC_MONTH) * 360;
  const moonPoint = fromEcliptic(sunLongitude + elongation, obliquity);

  return {
    sun: horizontal(sunPoint.ra, sunPoint.dec, jd, latitude, longitude),
    moon: horizontal(moonPoint.ra, moonPoint.dec, jd, latitude, longitude),
    moonIllumination: (1 - Math.cos(elongation * RAD)) / 2,
    moonPhase: age / SYNODIC_MONTH,
  };
}

/** Sunrise, sunset and solar noon for the local day beginning at `dayStart` (a local midnight). */
export function sunTimes(dayStart: Date, latitude: number, longitude: number): SunTimes {
  const step = 5; // minutes
  let rise: number | null = null;
  let set: number | null = null;
  let noon = 12;
  let highest = -Infinity;
  let previous = sky(dayStart, latitude, longitude).sun.altitude;
  let anyUp = previous > HORIZON_ALTITUDE;
  for (let minute = step; minute <= 24 * 60; minute += step) {
    const altitude = sky(new Date(dayStart.getTime() + minute * 60000), latitude, longitude).sun.altitude;
    const hour = minute / 60;
    if (altitude > highest) {
      highest = altitude;
      noon = hour;
    }
    if (altitude > HORIZON_ALTITUDE) anyUp = true;
    if (previous <= HORIZON_ALTITUDE && altitude > HORIZON_ALTITUDE && rise === null) rise = hour - step / 60;
    if (previous > HORIZON_ALTITUDE && altitude <= HORIZON_ALTITUDE && set === null) set = hour - step / 60;
    previous = altitude;
  }
  return { rise, set, noon, alwaysUp: rise === null && set === null && anyUp };
}

/**
 * A rough guess at where the user is from their time zone alone, used until they share their location.
 * Longitude comes from the UTC offset (15 degrees per hour); the hemisphere from which half of the year the
 * clocks are changed in (daylight saving is in summer, so it reveals north or south); latitude is a
 * typical mid-latitude value for that hemisphere.
 */
export function estimateLocation(now = new Date()): { latitude: number; longitude: number } {
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  const longitude = Math.max(-180, Math.min(180, (-Math.max(jan, jul) / 60) * 15));
  const latitude = jan === jul ? 25 : jul < jan ? 42 : -33; // a smaller offset (clocks forward) in July means north
  return { latitude, longitude };
}

// ---------------------------------------------------------------------------------------------------------------
// Describing the sky in words, for people who can't see it.

export type Stage = 'day' | 'twilight' | 'night';

const POINTS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** The nearest of the eight compass points for an azimuth in degrees. */
export function compass(azimuth: number): string {
  return POINTS[Math.round(mod(azimuth, 360) / 45) % 8];
}

export function moonPhaseName(phase: number): string {
  const p = mod(phase, 1);
  if (p < 0.03 || p >= 0.97) return 'new moon';
  if (p < 0.22) return 'waxing crescent';
  if (p < 0.28) return 'first quarter moon';
  if (p < 0.47) return 'waxing gibbous moon';
  if (p < 0.53) return 'full moon';
  if (p < 0.72) return 'waning gibbous moon';
  if (p < 0.78) return 'last quarter moon';
  return 'waning crescent';
}

/** Day while the sun is up, twilight until it is 12 degrees below the horizon, and night after that. */
export function stageOf(s: Sky): Stage {
  if (s.sun.altitude > HORIZON_ALTITUDE) return 'day';
  return s.sun.altitude > -12 ? 'twilight' : 'night';
}

/** A short sentence or two saying where the sun (and, at night, the moon) is. */
export function describeSky(s: Sky): string {
  const degrees = (n: number) => `${Math.round(Math.abs(n))}°`;
  const stage = stageOf(s);
  if (stage === 'day') {
    return `Daytime. The sun is ${degrees(s.sun.altitude)} above the horizon in the ${compass(s.sun.azimuth)}.`;
  }
  const sunPart =
    stage === 'twilight'
      ? `Twilight. The sun is ${degrees(s.sun.altitude)} below the horizon in the ${compass(s.sun.azimuth)}.`
      : 'Night. The sun is well below the horizon.';
  const moonPart =
    s.moon.altitude > 0
      ? ` The moon, a ${moonPhaseName(s.moonPhase)} (${Math.round(s.moonIllumination * 100)}% lit), is ${degrees(s.moon.altitude)} above the horizon in the ${compass(s.moon.azimuth)}.`
      : ' The moon is below the horizon.';
  return sunPart + moonPart;
}
