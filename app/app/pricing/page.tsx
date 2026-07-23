'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, X, Crown, ArrowLeft, Zap, Shield, Rocket, ArrowRight, Star } from 'lucide-react'
import { motion } from 'framer-motion'

interface PlanDef {
  name: string
  displayName: string
  price: number | null // null = custom (sales-led)
  annualPrice: number | null
  description: string
  tagline: string
  highlight?: string
  icon: React.ElementType
  limits: string[]
  features: Array<{ label: string; included: boolean }>
  cta: string
  ctaHref?: string
  popular?: boolean
  pro?: boolean
}

const plans: PlanDef[] = [
  {
    name: 'SANDBOX',
    displayName: 'Free',
    price: 0,
    annualPrice: null,
    description: 'No credit card required',
    tagline: 'Explore what Backenly can do',
    icon: Shield,
    limits: [
      '1 project, permanently live, no expiry',
      'Autonomous self-healing every 30 minutes, safe fixes applied, company-funded',
      '200 AI credits / month (1 credit = 1,000 tokens)',
      'Build over MCP with your own coding agent, no AI charge',
      'Up to 50,000 monthly active users',
      '100,000 API requests total',
      '10,000 function invocations / month',
      '512 MB PostgreSQL + 1 GB file storage',
    ],
    features: [
      { label: 'Full REST APIs', included: true },
      { label: 'Auth (Email, Google, GitHub)', included: true },
      { label: 'PostgreSQL + File storage', included: true },
      { label: 'Realtime / SSE', included: true },
      { label: 'Production deployment', included: true },
      { label: 'Custom domain', included: false },
      { label: 'Event triggers + webhooks', included: false },
      { label: 'Team seats + org roles', included: false },
    ],
    cta: 'Current Plan',
  },
  {
    name: 'BUILDER',
    displayName: 'Pro',
    price: 25,
    annualPrice: 20,
    description: 'Ship and run a real product',
    tagline: 'A backend that heals itself',
    highlight: 'Most Popular',
    icon: Rocket,
    popular: true,
    limits: [
      'Self-healing every minute: full autonomy dial, unlimited fixes, company-funded',
      '3,000 AI credits / month, token-backed with a published stable ratio',
      'Unlimited projects + unlimited API requests',
      'Up to 200,000 monthly active users',
      '2M function invocations / month',
      '10 GB PostgreSQL + 100 GB file storage',
      '1,000 concurrent realtime connections',
      'Unlimited triggers, webhooks + custom domains',
      '5 team seats with org roles (RBAC)',
      'Full deployment history + rollback · 30-day logs',
      'Email support',
    ],
    features: [
      { label: 'Everything in Free', included: true },
      { label: 'Every-minute autonomy, full dial', included: true },
      { label: 'Unlimited API requests', included: true },
      { label: 'Custom domain + webhooks', included: true },
      { label: 'Org roles (RBAC) + 5 seats', included: true },
      { label: 'Deployment rollback', included: true },
      { label: 'Email support', included: true },
      { label: 'SSO (OIDC) + 12h SLA', included: false },
    ],
    cta: 'Upgrade to Pro',
  },
  {
    name: 'SCALE',
    displayName: 'Enterprise',
    price: null,
    annualPrice: null,
    description: 'Annual agreement, scoped to you',
    tagline: 'Your company’s backend, operated',
    icon: Crown,
    pro: true,
    limits: [
      'Custom MAU, storage, and AI credit pools',
      'Custom autonomy cadence + guardrail policies',
      'SSO (OIDC) + RBAC',
      'Priority support with a 12-hour SLA',
      'Dedicated isolation + onboarding and migration help',
      '90-day log retention',
      'Invoicing & procurement-friendly billing',
    ],
    features: [
      { label: 'Everything in Pro', included: true },
      { label: 'Custom limits + isolation', included: true },
      { label: 'SSO (OIDC)', included: true },
      { label: 'Priority support (12h SLA)', included: true },
      { label: '90-day log retention', included: true },
      { label: 'Migration + onboarding help', included: true },
    ],
    cta: 'Contact sales',
    ctaHref: 'mailto:sales@backenly.com?subject=Backenly%20Enterprise',
  },
]

export default function AppPricingPage() {
  const router = useRouter()
  const [annual, setAnnual] = useState(false)

  const handleUpgrade = (plan: PlanDef) => {
    if (plan.name === 'SANDBOX') return
    if (plan.ctaHref) {
      window.location.href = plan.ctaHref // Enterprise is sales-led — no self-serve checkout
      return
    }
    router.push('/app/settings?tab=billing')
  }

  return (
    <div className="min-h-screen bg-[#080A0F]">
      {/* Header */}
      <div className="border-b border-white/[0.05] bg-[#080A0F]/95 backdrop-blur-xl sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={() => router.back()}
                className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.06] flex items-center justify-center text-white/30 hover:text-white/60 transition-all"
                aria-label="Go back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <div>
                <h1 className="text-base font-semibold text-white/80 flex items-center gap-2">
                  <Crown className="w-4 h-4 text-violet-400" />
                  Plans & Pricing
                </h1>
                <p className="text-[11px] text-white/25 mt-0.5">
                  Flat-rate pricing. No usage fees, no surprises
                </p>
              </div>
            </div>

            {/* Annual toggle */}
            <div className="flex items-center gap-px bg-white/[0.03] border border-white/[0.06] rounded-xl p-1">
              <button
                onClick={() => setAnnual(false)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  !annual
                    ? 'bg-white/[0.08] text-white border border-white/[0.08] shadow-sm'
                    : 'text-white/30 hover:text-white/50'
                }`}
              >
                Monthly
              </button>
              <button
                onClick={() => setAnnual(true)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                  annual
                    ? 'bg-white/[0.08] text-white border border-white/[0.08] shadow-sm'
                    : 'text-white/30 hover:text-white/50'
                }`}
              >
                Annual
                <span className="px-1.5 py-0.5 bg-emerald-500/15 text-emerald-400 rounded text-[9px] font-bold">
                  −20%
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-6xl mx-auto px-6 py-12">

        {/* Hero text */}
        <div className="text-center mb-12">
          <motion.h2
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-3xl font-bold text-white tracking-tight mb-3"
          >
            Simple, predictable pricing
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.08 }}
            className="text-sm text-white/35 max-w-md mx-auto leading-relaxed"
          >
            One price, all features included. No metered billing, no hidden costs.
          </motion.p>
        </div>

        {/* Pricing Cards */}
        <div className="grid md:grid-cols-3 gap-5 max-w-5xl mx-auto">
          {plans.map((plan, index) => {
            const PlanIcon = plan.icon
            const displayPrice = annual && plan.annualPrice !== null ? plan.annualPrice : plan.price

            return (
              <motion.div
                key={plan.name}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className={`relative flex flex-col rounded-2xl overflow-hidden transition-all duration-300 ${
                  plan.popular
                    ? 'border border-violet-500/30 bg-[#0F0B1E] shadow-[0_0_80px_-20px_rgba(139,92,246,0.3)]'
                    : plan.pro
                    ? 'border border-amber-500/20 bg-[#130F08]'
                    : 'border border-white/[0.06] bg-[#0C0E14]'
                }`}
              >
                {/* Top gradient line */}
                {plan.popular && (
                  <div className="h-px bg-gradient-to-r from-transparent via-violet-400/70 to-transparent" />
                )}
                {plan.pro && (
                  <div className="h-px bg-gradient-to-r from-transparent via-amber-400/40 to-transparent" />
                )}

                {/* Popular badge */}
                {plan.highlight && (
                  <div className="flex justify-center pt-3">
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest bg-violet-500/15 text-violet-300/80 border border-violet-500/25">
                      <Zap className="w-2.5 h-2.5" />
                      {plan.highlight}
                    </span>
                  </div>
                )}

                {/* Subtle glow for popular */}
                {plan.popular && (
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-24 bg-white/[0.05] rounded-full blur-3xl pointer-events-none" />
                )}

                <div className={`relative flex flex-col flex-1 p-6 ${plan.highlight ? 'pt-4' : ''}`}>
                  {/* Plan header */}
                  <div className="flex items-start justify-between mb-5">
                    <div className="flex items-center gap-2.5">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
                        plan.popular
                          ? 'bg-white/[0.06] border border-white/[0.14] text-violet-400'
                          : plan.pro
                          ? 'bg-amber-500/10 border border-amber-500/20 text-amber-500/80'
                          : 'bg-white/[0.05] border border-white/[0.08] text-white/40'
                      }`}>
                        <PlanIcon className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className={`text-base font-bold tracking-tight ${
                          plan.popular ? 'text-white' : plan.pro ? 'text-amber-50/80' : 'text-white/55'
                        }`}>
                          {plan.displayName}
                        </h3>
                        <p className={`text-[11px] mt-0.5 ${
                          plan.popular ? 'text-white/30' : 'text-white/20'
                        }`}>{plan.tagline}</p>
                      </div>
                    </div>
                  </div>

                  {/* Price */}
                  <div className="mb-6">
                    {plan.price === null ? (
                      <div className="flex items-baseline gap-1">
                        <span className={`text-5xl font-extrabold tracking-tighter ${
                          plan.popular ? 'text-white' : plan.pro ? 'text-amber-50/75' : 'text-white/45'
                        }`}>
                          Custom
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-baseline gap-1">
                        <span className={`text-5xl font-extrabold tracking-tighter ${
                          plan.popular ? 'text-white' : plan.pro ? 'text-amber-50/75' : 'text-white/45'
                        }`}>
                          ${displayPrice}
                        </span>
                        <span className={`text-sm ml-0.5 ${plan.popular ? 'text-white/30' : 'text-white/20'}`}>/mo</span>
                      </div>
                    )}
                    {plan.price === null ? (
                      <p className="text-[11px] text-white/20 mt-1.5">{plan.description}</p>
                    ) : annual && plan.annualPrice !== null && plan.price > 0 ? (
                      <p className="text-[11px] text-white/25 mt-1.5">
                        Billed ${plan.annualPrice * 12}/yr · saves ${(plan.price - plan.annualPrice) * 12}/yr
                      </p>
                    ) : plan.price === 0 ? (
                      <p className="text-[11px] text-white/20 mt-1.5">{plan.description}</p>
                    ) : (
                      <p className="text-[11px] text-white/20 mt-1.5">Switch to annual to save 20%</p>
                    )}
                  </div>

                  {/* Limits */}
                  <ul className="space-y-2.5 mb-6 flex-1">
                    {plan.limits.map((item) => (
                      <li key={item} className="flex items-start gap-2">
                        <Check className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${
                          plan.popular ? 'text-violet-400' : plan.pro ? 'text-amber-500/60' : 'text-white/20'
                        }`} />
                        <span className={`text-[12px] leading-snug ${
                          plan.popular ? 'text-white/55' : plan.pro ? 'text-white/40' : 'text-white/30'
                        }`}>{item}</span>
                      </li>
                    ))}
                  </ul>

                  {/* Feature comparison */}
                  <div className="space-y-2 mb-6 pt-4 border-t border-white/[0.04]">
                    {plan.features.map(({ label, included }) => (
                      <div
                        key={label}
                        className={`flex items-center gap-2 text-[11px] ${
                          included
                            ? plan.popular ? 'text-white/50' : plan.pro ? 'text-white/38' : 'text-white/30'
                            : 'text-white/12'
                        }`}
                      >
                        {included ? (
                          <Check className={`w-3 h-3 flex-shrink-0 ${
                            plan.popular ? 'text-violet-400/70' : plan.pro ? 'text-amber-500/50' : 'text-white/20'
                          }`} />
                        ) : (
                          <X className="w-3 h-3 flex-shrink-0 text-white/10" />
                        )}
                        {label}
                      </div>
                    ))}
                  </div>

                  {/* CTA */}
                  <button
                    onClick={() => handleUpgrade(plan)}
                    disabled={plan.name === 'SANDBOX'}
                    className={`w-full py-2.5 px-4 rounded-xl text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${
                      plan.name === 'SANDBOX'
                        ? 'bg-white/[0.03] text-white/20 cursor-not-allowed border border-white/[0.04]'
                        : plan.popular
                        ? 'bg-white hover:bg-zinc-200 text-black shadow-[0_4px_20px_rgba(255,255,255,0.15)] hover:shadow-[0_4px_28px_rgba(255,255,255,0.25)]'
                        : plan.pro
                        ? 'bg-gradient-to-r from-amber-600/80 to-amber-500/80 hover:from-amber-500/90 hover:to-amber-400/90 text-white/90 border border-amber-500/30'
                        : 'bg-white/[0.06] hover:bg-white/[0.09] text-white/50 hover:text-white/70 border border-white/[0.08]'
                    }`}
                  >
                    {plan.name === 'SANDBOX' ? (
                      'Current Free Plan'
                    ) : (
                      <>
                        {plan.cta}
                        <ArrowRight className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )
          })}
        </div>

        {/* Trust signals */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl mx-auto"
        >
          {[
            {
              icon: Shield,
              title: 'Flat-rate pricing',
              desc: 'No pay-as-you-go surprises. One price, every feature included.',
            },
            {
              icon: Star,
              title: 'Cancel anytime',
              desc: 'No lock-in. Cancel or downgrade whenever you want.',
            },
            {
              icon: Zap,
              title: 'Instant activation',
              desc: 'Your plan upgrades instantly. No waiting, no manual steps.',
            },
          ].map(({ icon: Icon, title, desc }) => (
            <div
              key={title}
              className="flex items-start gap-3 p-4 rounded-xl bg-white/[0.02] border border-white/[0.04]"
            >
              <div className="w-8 h-8 rounded-lg bg-white/[0.06] border border-white/[0.12] flex items-center justify-center flex-shrink-0">
                <Icon className="w-3.5 h-3.5 text-violet-400/70" />
              </div>
              <div>
                <h4 className="text-xs font-semibold text-white/60 mb-1">{title}</h4>
                <p className="text-[11px] text-white/25 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </motion.div>

        {/* Footer */}
        <div className="mt-10 text-center space-y-2">
          <p className="text-white/20 text-[11px]">
            All plans include PostgreSQL, REST APIs, Auth, Realtime, File Storage, and AI backend building.
          </p>
          <p className="text-white/15 text-[11px]">
            Need a custom plan?{' '}
            <a href="mailto:sales@backenly.com" className="text-violet-400/60 hover:text-violet-400 transition-colors underline underline-offset-2">
              Contact sales
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
