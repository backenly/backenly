'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { motion } from 'framer-motion'

const plans = [
  {
    name: 'Free',
    apiCalls: '100K',
    projects: '1',
    compute: 'Limited',
  },
  {
    name: 'Pro',
    apiCalls: '5M',
    projects: 'Unlimited',
    compute: 'Higher',
  },
  {
    name: 'Team',
    apiCalls: '50M',
    projects: 'Unlimited',
    compute: 'Premium',
  },
  {
    name: 'Enterprise',
    apiCalls: 'Custom',
    projects: 'Unlimited',
    compute: 'Dedicated',
  },
]

export function PricingPreview() {
  return (
    <section className="py-20 px-6 bg-dark-surface/30">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl font-bold text-white mb-4">Simple, transparent pricing</h2>
          <p className="text-xl text-gray-400">Start free, scale as you grow</p>
        </motion.div>
        
        <div className="grid md:grid-cols-4 gap-6 mb-8">
          {plans.map((plan, index) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              whileHover={{ 
                y: -2,
                transition: { duration: 0.2 }
              }}
              className="glass rounded-xl p-6 cursor-pointer group"
            >
              <h3 className="text-xl font-semibold text-white mb-4 group-hover:text-primary-400 transition-colors duration-200">{plan.name}</h3>
              <div className="space-y-3 text-sm text-gray-400">
                <div>{plan.apiCalls} API requests</div>
                <div>{plan.projects} project{plan.projects !== 'Unlimited' ? '' : 's'}</div>
                <div>{plan.compute} compute</div>
              </div>
            </motion.div>
          ))}
        </div>
        
        <div className="text-center">
          <Link href="/pricing">
            <Button variant="outline" size="lg">
              See full pricing →
            </Button>
          </Link>
        </div>
      </div>
    </section>
  )
}

