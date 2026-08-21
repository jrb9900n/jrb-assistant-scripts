// tools/impl/google-maps.js — Google Maps Routes API drive-time calculation.
// Used by scheduling-visits.js's estimate-visit scheduling to block real
// travel time before/after a site visit (confirmed design: actual blocked
// calendar time, not just a text note). Michael chose Google Maps (Routes
// API) over Azure Maps 2026-08-20 after seeing actual per-call pricing --
// see CLAUDE.md's Autonomous Schedule Manager section.

import axios from 'axios';
import { logger } from '../../core/logger.js';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * Returns drive time in whole minutes (rounded up) between two addresses,
 * or null if the API key isn't configured, either address is missing, or
 * the request fails. Callers should degrade gracefully on null (skip the
 * travel-time block) rather than fail the whole visit-scheduling flow over
 * a drive-time lookup problem -- the visit itself matters far more than the
 * travel-time nicety around it.
 */
export async function getDriveTimeMinutes({ originAddress, destinationAddress }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    logger.warn('getDriveTimeMinutes: GOOGLE_MAPS_API_KEY not configured, skipping drive-time calculation');
    return null;
  }
  if (!originAddress || !destinationAddress) return null;

  try {
    const res = await axios.post(ROUTES_URL, {
      origin: { address: originAddress },
      destination: { address: destinationAddress },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // Routes API requires an explicit field mask on every request --
        // omitting it is a 400, not just a wasteful full-payload response.
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
      },
      timeout: 10_000,
    });
    const route = res.data?.routes?.[0];
    if (!route?.duration) return null;
    // duration comes back as a string like "1234s", not a number.
    const seconds = parseInt(route.duration, 10);
    if (!Number.isFinite(seconds)) return null;
    return Math.ceil(seconds / 60);
  } catch (err) {
    logger.warn('getDriveTimeMinutes: request failed', { err: err.response?.data ?? err.message, originAddress, destinationAddress });
    return null;
  }
}
