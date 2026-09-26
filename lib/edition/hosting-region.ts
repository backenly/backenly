/**
 * Where this deployment's backends run, as the console states it.
 *
 * One definition, because three surfaces say it (the New project dialog, project
 * Settings, the TopBar environment chip) and they drifted: all three kept
 * saying "EU · Hetzner" after Backenly Cloud moved to AWS.
 *
 * Cloud is one AWS region today, named the way AWS names it. A self-hosted
 * deployment runs wherever its operator put it, which the product does not know,
 * so it says exactly that rather than naming a provider.
 *
 * Presentation only, like CLOUD_CONTROL_PLANE itself.
 */

import { CLOUD_CONTROL_PLANE } from '@cloud/control-plane'

export interface HostingRegion {
  /** Short chip text. */
  short: string
  /** Full sentence-ready name. */
  label: string
  /** One line of explanation for tooltips and helper text. */
  note: string
}

export const HOSTING_REGION: HostingRegion = CLOUD_CONTROL_PLANE
  ? {
      short: 'AWS · ap-south-1',
      label: 'AWS Asia Pacific (Mumbai)',
      note: 'Backenly Cloud runs every project in one region: AWS Asia Pacific (Mumbai).',
    }
  : {
      short: 'Self-hosted',
      label: 'Self-hosted',
      note: 'This deployment runs wherever its operator hosts it.',
    }
