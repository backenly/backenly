/**
 * The contact page's message form (app/contact, app/api/contact): what it
 * asks and how much it accepts, shared by the form and the route so the two
 * cannot disagree.
 */

/** What the message is about, as the team sees it in the subject line. */
export const CONTACT_TOPICS = ['General question', 'Help with a project', 'Sales or Enterprise', 'Partnership'] as const
export type ContactTopic = (typeof CONTACT_TOPICS)[number]

export const CONTACT_LIMITS = {
  name: 100,
  email: 254,
  company: 120,
  messageMin: 10,
  messageMax: 5000,
} as const

/** Where a message lands, and the address the page offers when the form cannot send. */
export const CONTACT_EMAIL = 'support@backenly.com'
