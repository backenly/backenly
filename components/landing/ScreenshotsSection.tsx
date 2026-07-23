'use client'

import { motion } from 'framer-motion'
import { FadeInSection } from './animations/FadeInSection'

const tableRows = [
  { method: 'POST', route: '/api/products', colorClass: 'text-emerald-400' },
  { method: 'GET', route: '/api/products/:id', colorClass: 'text-blue-400' },
  { method: 'PUT', route: '/api/products/:id', colorClass: 'text-purple-400' },
  { method: 'DELETE', route: '/api/products/:id', colorClass: 'text-red-400' },
]

export function ScreenshotsSection() {
  return (
    <section className="py-24 px-4 sm:px-6 lg:px-8 bg-[#0F1419]">
      <div className="max-w-[1280px] mx-auto">
        <FadeInSection className="text-center mb-16">
          <motion.div
            className="inline-flex items-center px-3 py-1 bg-[#3B82F6]/10 border border-[#3B82F6]/20 rounded-full mb-4"
            initial={{ opacity: 0, scale: 0.8 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <span className="text-xs font-medium text-[#3B82F6]">Product tour</span>
          </motion.div>
          <h2 className="text-4xl sm:text-5xl font-bold text-white mb-4 tracking-tight">See Backenly in action</h2>
        </FadeInSection>

        <div className="relative mb-12">
          {/* First Card - AI Workspace */}
          <motion.div
            className="relative bg-[#111418] border border-[#23262B] rounded-2xl p-8 shadow-2xl mb-8 lg:mb-0 lg:mr-12 lg:w-[55%]"
            initial={{ opacity: 0, x: -50 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            whileHover={{ y: -8, transition: { duration: 0.3 } }}
          >
            <div className="flex items-center space-x-2 mb-6 pb-4 border-b border-[#23262B]">
              <motion.div
                className="w-3 h-3 rounded-full bg-red-500/60"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
              <motion.div
                className="w-3 h-3 rounded-full bg-yellow-500/60"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 2, repeat: Infinity, delay: 0.2 }}
              />
              <motion.div
                className="w-3 h-3 rounded-full bg-green-500/60"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 2, repeat: Infinity, delay: 0.4 }}
              />
              <span className="ml-4 text-xs text-gray-500 font-mono">AI Workspace</span>
            </div>

            {/* Prompt Area */}
            <div className="mb-6">
              <div className="bg-[#0B0D10] border border-[#23262B] rounded-xl p-5 font-mono text-sm">
                <motion.div
                  className="text-gray-500 mb-2"
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.2 }}
                >
                  $ Create e-commerce API with user auth
                </motion.div>
                <motion.div
                  className="text-[#3B82F6]"
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.4 }}
                >
                  → Analyzing requirements...
                </motion.div>
                <motion.div
                  className="text-emerald-400 mt-2"
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.6 }}
                >
                  ✓ Generated 12 routes
                </motion.div>
                <motion.div
                  className="text-emerald-400"
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.7 }}
                >
                  ✓ Created database schema
                </motion.div>
                <motion.div
                  className="text-emerald-400"
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.8 }}
                >
                  ✓ Configured authentication
                </motion.div>
              </div>
            </div>

            {/* Task List */}
            <div className="space-y-3">
              {['POST /api/products', 'GET /api/products/:id', 'POST /api/auth/login'].map((task, index) => (
                <motion.div
                  key={index}
                  className="flex items-center space-x-3 text-sm text-gray-300"
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.9 + index * 0.1 }}
                >
                  <div className="w-5 h-5 border-2 border-[#3B82F6] rounded flex items-center justify-center">
                    <div className="w-2.5 h-2.5 bg-[#3B82F6] rounded"></div>
                  </div>
                  <span>{task}</span>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Second Card - API Routes Table (Overlapping) */}
          <motion.div
            className="relative bg-[#111418] border border-[#23262B] rounded-2xl p-8 shadow-2xl lg:absolute lg:top-12 lg:right-0 lg:w-[50%]"
            initial={{ opacity: 0, x: 50 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
            whileHover={{ y: -8, transition: { duration: 0.3 } }}
          >
            <div className="flex items-center space-x-2 mb-6 pb-4 border-b border-[#23262B]">
              <motion.div
                className="w-3 h-3 rounded-full bg-red-500/60"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
              <motion.div
                className="w-3 h-3 rounded-full bg-yellow-500/60"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 2, repeat: Infinity, delay: 0.2 }}
              />
              <motion.div
                className="w-3 h-3 rounded-full bg-green-500/60"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 2, repeat: Infinity, delay: 0.4 }}
              />
              <span className="ml-4 text-xs text-gray-500 font-mono">API Routes</span>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#23262B]">
                    <th className="text-left py-3 px-4 text-gray-400 font-medium">Method</th>
                    <th className="text-left py-3 px-4 text-gray-400 font-medium">Route</th>
                    <th className="text-left py-3 px-4 text-gray-400 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {tableRows.map((row, index) => (
                    <motion.tr
                      key={index}
                      className="border-b border-[#23262B]"
                      initial={{ opacity: 0, y: 10 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true }}
                      transition={{ delay: 0.5 + index * 0.1 }}
                    >
                      <td className="py-3 px-4">
                        <span className={row.colorClass}>{row.method}</span>
                      </td>
                      <td className="py-3 px-4 text-gray-300">{row.route}</td>
                      <td className="py-3 px-4">
                        <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-1 rounded">
                          Active
                        </span>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        </div>

        {/* Key Experience Bullets */}
        <FadeInSection delay={0.3}>
          <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {[
              { icon: '💬', title: 'Prompt-based backend design', desc: 'Describe what you need in plain English' },
              { icon: '⚡', title: 'Generated APIs and schemas', desc: 'Production-ready code in seconds' },
              { icon: '🚀', title: 'One-click deploy or export', desc: 'Full control, zero lock-in' },
            ].map((item, index) => (
              <motion.div
                key={index}
                className="text-center"
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.5 + index * 0.1 }}
              >
                <motion.div
                  className="w-12 h-12 bg-[#3B82F6]/10 rounded-xl flex items-center justify-center mx-auto mb-3"
                  whileHover={{ scale: 1.1, rotate: 5 }}
                  transition={{ type: 'spring', stiffness: 300 }}
                >
                  <span className="text-2xl">{item.icon}</span>
                </motion.div>
                <h3 className="text-sm font-semibold text-white mb-2">{item.title}</h3>
                <p className="text-xs text-gray-400">{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </FadeInSection>
      </div>
    </section>
  )
}
